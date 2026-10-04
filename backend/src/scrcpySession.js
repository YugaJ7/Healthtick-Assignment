'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { adb, adbShellSpawn } = require('./adb');
const { config } = require('./config');
const { logger } = require('./logger');
const { createVideoParser } = require('./videoParser');

const SCID_LIMIT = 2 ** 31;
const CONNECT_ATTEMPTS = 50;
const CONNECT_RETRY_MS = 100;
const DUMMY_BYTE_COUNT = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pushScrcpyServer() {
  await adb(['push', config.scrcpy.localJar, config.scrcpy.deviceJar]);
}

function serverCommand(scid) {
  const { deviceJar, version, maxSize, maxFps, bitRate } = config.scrcpy;
  return [
    `CLASSPATH=${deviceJar}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version,
    `scid=${scid}`, 'log_level=info', 'tunnel_forward=true',
    'audio=false', 'control=false', 'cleanup=false', 'send_device_meta=false',
    'video_codec=h264', `max_size=${maxSize}`, `max_fps=${maxFps}`, `video_bit_rate=${bitRate}`,
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

// One scrcpy-server instance and its video socket. Emits:
//   'event' (codec | session | packet objects from the parser)
//   'close' (reason string), exactly once
function startScrcpySession() {
  const emitter = new EventEmitter();
  const scid = crypto.randomInt(SCID_LIMIT).toString(16).padStart(8, '0');
  let isStopped = false;
  let port = null;
  let serverProcess = null;
  let socket = null;

  function stop(reason) {
    if (isStopped) return;
    isStopped = true;
    if (socket) socket.destroy();
    if (serverProcess) serverProcess.kill();
    if (port !== null) {
      adb(['forward', '--remove', `tcp:${port}`]).catch((err) => logger.error(`[scrcpy ${scid}] ${err.message}`));
    }
    emitter.emit('close', reason);
  }

  async function run() {
    port = Number(await adb(['forward', 'tcp:0', `localabstract:scrcpy_${scid}`]));
    if (!Number.isInteger(port) || port <= 0) throw new Error('adb forward did not return a port');
    if (isStopped) return adb(['forward', '--remove', `tcp:${port}`]);

    serverProcess = adbShellSpawn(serverCommand(scid));
    const logLine = (data) => logger.info(`[scrcpy ${scid}] ${data.toString().trim()}`);
    serverProcess.stdout.on('data', logLine);
    serverProcess.stderr.on('data', logLine);
    serverProcess.once('exit', (code) => stop(`scrcpy-server exited (code ${code})`));
    serverProcess.once('error', (err) => stop(`could not start adb: ${err.message}`));

    socket = await openVideoSocketWithRetry(port, () => isStopped);
    if (isStopped) return socket.destroy();

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

  return { on: emitter.on.bind(emitter), stop, scid };
}

module.exports = { startScrcpySession, pushScrcpyServer };
