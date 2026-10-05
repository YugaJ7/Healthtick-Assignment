'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { adb, adbShellSpawn } = require('../devices/adb');
const { config } = require('../../shared/config');
const { logger } = require('../../shared/logger');
const { createVideoParser } = require('./videoParser');
const { createDeviceMessageParser } = require('../input/deviceMessages');

const SCID_LIMIT = 2 ** 31;
const CONNECT_ATTEMPTS = 50;
const CONNECT_RETRY_MS = 100;
const DUMMY_BYTE_COUNT = 1;
const MAX_CONTROL_BACKLOG_BYTES = 64 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serverCommand(scid) {
  const { deviceJar, version, maxSize, maxFps, bitRate, codecOptions } = config.scrcpy;
  return [
    `CLASSPATH=${deviceJar}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version,
    `scid=${scid}`, 'log_level=info', 'tunnel_forward=true',
    'audio=false', 'control=true', 'cleanup=false', 'send_device_meta=false',
    'video_codec=h264', `max_size=${maxSize}`, `max_fps=${maxFps}`, `video_bit_rate=${bitRate}`,
    ...(codecOptions === '' ? [] : [`video_codec_options=${codecOptions}`]),
  ].join(' ');
}

// With an adb forward, a TCP connect succeeds even before scrcpy-server listens, and is
// then closed at once. The server sends one dummy byte on a real connection, so we retry
// until that byte arrives (scrcpy doc/develop.md, "Connection").
function openVideoSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const fail = (err) => {
      socket.destroy();
      reject(err || new Error('closed before the dummy byte'));
    };
    socket.once('error', fail);
    socket.once('close', () => fail());
    socket.once('readable', () => {
      const dummy = socket.read(DUMMY_BYTE_COUNT);
      if (dummy === null) return fail();
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      resolve(socket);
    });
  });
}

async function openVideoSocketWithRetry(port, isStopped) {
  let lastError = null;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !isStopped(); attempt += 1) {
    try {
      return await openVideoSocket(port);
    } catch (err) {
      lastError = err;
      await sleep(CONNECT_RETRY_MS);
    }
  }
  throw new Error(`could not reach scrcpy-server on the device: ${lastError ? lastError.message : 'stopped'}`);
}

// scrcpy-server accepts its sockets in a fixed order: video first, then control.
// Only the first socket gets the dummy byte, so this one is ready as soon as it connects.
function openControlSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

// One scrcpy-server instance on the device `serial`, with its video and control sockets. Emits:
//   'stage' ('streaming' once the video socket is open, 'control' once the control socket is)
//   'event' (codec | session | packet objects from the parser)
//   'device' (messages from the device, currently { type: 'clipboard', text })
//   'close' (reason string), exactly once
function startScrcpySession(serial) {
  const emitter = new EventEmitter();
  const scid = crypto.randomInt(SCID_LIMIT).toString(16).padStart(8, '0');
  let isStopped = false;
  let port = null;
  let serverProcess = null;
  let socket = null;
  let controlSocket = null;

  function stop(reason) {
    if (isStopped) return;
    isStopped = true;
    if (socket) socket.destroy();
    if (controlSocket) controlSocket.destroy();
    if (serverProcess) serverProcess.kill();
    if (port !== null) {
      adb(serial, ['forward', '--remove', `tcp:${port}`]).catch((err) => logger.error(`[scrcpy ${scid}] ${err.message}`));
    }
    emitter.emit('close', reason);
  }

  async function run() {
    port = Number(await adb(serial, ['forward', 'tcp:0', `localabstract:scrcpy_${scid}`]));
    if (!Number.isInteger(port) || port <= 0) throw new Error('adb forward did not return a port');
    if (isStopped) return adb(serial, ['forward', '--remove', `tcp:${port}`]);

    serverProcess = adbShellSpawn(serial, serverCommand(scid));
    const logLine = (data) => logger.info(`[scrcpy ${scid}] ${data.toString().trim()}`);
    serverProcess.stdout.on('data', logLine);
    serverProcess.stderr.on('data', logLine);
    serverProcess.once('exit', (code) => stop(`scrcpy-server exited (code ${code})`));
    serverProcess.once('error', (err) => stop(`could not start adb: ${err.message}`));

    socket = await openVideoSocketWithRetry(port, () => isStopped);
    if (isStopped) return socket.destroy();
    emitter.emit('stage', 'streaming');

    controlSocket = await openControlSocket(port);
    if (isStopped) return controlSocket.destroy();
    emitter.emit('stage', 'control');
    // The device also talks on this socket: it reports clipboard changes.
    const deviceParser = createDeviceMessageParser();
    controlSocket.on('data', (chunk) => {
      try {
        for (const message of deviceParser.push(chunk)) emitter.emit('device', message);
      } catch (err) {
        stop(`bad device message: ${err.message}`);
      }
    });
    controlSocket.once('error', (err) => stop(`control socket error: ${err.message}`));
    controlSocket.once('close', () => stop('control socket closed'));

    const parser = createVideoParser();
    socket.on('data', (chunk) => {
      try {
        for (const event of parser.push(chunk)) emitter.emit('event', event);
      } catch (err) {
        stop(`bad video stream: ${err.message}`);
      }
    });
    socket.once('error', (err) => stop(`video socket error: ${err.message}`));
    socket.once('close', () => stop('video socket closed'));
  }

  run().catch((err) => stop(err.message));

  // Returns false when the message was dropped (not connected yet, or the device is not
  // reading fast enough). Dropping is safer than queueing stale input.
  function sendControl(buffer) {
    if (isStopped || !controlSocket || controlSocket.writableLength > MAX_CONTROL_BACKLOG_BYTES) return false;
    controlSocket.write(buffer);
    return true;
  }

  return { on: emitter.on.bind(emitter), stop, sendControl, scid };
}

module.exports = { startScrcpySession };
