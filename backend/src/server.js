'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { config } = require('./config');
const { logger } = require('./logger');
const { startScrcpySession } = require('./scrcpySession');
const { encodeClientMessage, InputError } = require('./controlMessages');
const { isAccessCodeValid, isOriginAllowed, visitorAddress, securityHeaders } = require('./access');
const { ensureNetwork, removeOrphans, createDevice, removeDevice } = require('./deviceManager');
const { createSessionManager, BusyError, LimitError } = require('./sessionManager');
const { isAllowedWhenRestricted, enforceRestriction } = require('./restriction');
const { recorderFor, finishRecording, serveRecording, serveRecordingInfo, cleanUpRecordings } = require('./recordings');
const { progressMessage } = require('./progress');

const STREAM_PATH = '/stream';
const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_MESSAGE_BYTES = 64 * 1024; // room for a pasted clipboard
const MAX_CLIPBOARD_CHARS = 16 * 1024;
const INPUT_WINDOW_MS = 1000;
const MAX_INPUTS_PER_WINDOW = 1000;
const MAX_REJECTED_INPUTS = 50;
const HEARTBEAT_MS = 15_000;
const RESTRICTION_CHECK_MS = 1000;
const RECORDING_CLEANUP_MS = 60_000;
const SHUTDOWN_GRACE_MS = 3000;
const MIN_ACCESS_CODE_LENGTH = 8;
const MAX_REASON_LENGTH = 100;

// WebSocket close codes. 4000-4999 are free for applications; the page reacts to each.
const WS_CLOSE_GOING_AWAY = 1001;
const WS_CLOSE_POLICY = 1008;
const WS_CLOSE_INTERNAL = 1011;
const WS_CLOSE_TRY_AGAIN = 1013;
const WS_CLOSE_BAD_CODE = 4401;
const WS_CLOSE_SESSION_ENDED = 4410;
const WS_CLOSE_BUSY = 4429;
const WS_CLOSE_ADDRESS_LIMIT = 4430;

// Only these files are served; anything else is a 404, so no path from the URL reaches the disk.
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/app.mjs', { file: 'app.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/h264.mjs', { file: 'h264.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/input.mjs', { file: 'input.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/pointerMap.mjs', { file: 'pointerMap.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/latency.mjs', { file: 'latency.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/state.mjs', { file: 'state.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/latencyPanel.mjs', { file: 'latencyPanel.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/recordingsPanel.mjs', { file: 'recordingsPanel.mjs', type: 'text/javascript; charset=utf-8' }],
]);

const sessions = createSessionManager({
  createDevice,
  removeDevice,
  maxSessions: config.maxSessions,
  maxPerOwner: config.maxSessionsPerAddress,
  graceMs: config.graceMs,
  idleMs: config.idleMs,
  log: logger.info,
  // One recording per session: kept open across reconnects, closed when the session ends.
  onEnded: (session) => finishRecording(session.id),
});

function handleHttp(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, sessions: sessions.count(), maxSessions: config.maxSessions }));
  }
  if (req.method === 'GET' && pathname === '/recording') return serveRecording(req, res, searchParams, securityHeaders(req.headers.host));
  if (req.method === 'GET' && pathname === '/recording/info') return serveRecordingInfo(res, searchParams, securityHeaders(req.headers.host));
  const entry = req.method === 'GET' ? STATIC_FILES.get(pathname) : undefined;
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  fs.readFile(path.join(config.frontendDir, entry.file), (err, body) => {
    if (err) {
      logger.error(`static file ${entry.file}: ${err.message}`);
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('server error');
    }
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store', ...securityHeaders(req.headers.host) });
    res.end(body);
  });
}

// Wire format to the browser: text frames carry JSON control messages; binary frames carry
// one video packet as [flags u8][pts microseconds u64 big-endian][H.264 Annex B payload].
function encodePacket(packet) {
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  header[0] = (packet.isConfig ? FLAG_CONFIG : 0) | (packet.isKeyFrame ? FLAG_KEY_FRAME : 0);
  header.writeBigUInt64BE(BigInt(packet.ptsUs), 1);
  return Buffer.concat([header, packet.data]);
}

function sendJson(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function parseJson(data) {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new InputError('message is not valid JSON');
  }
}

// Input from the browser. Every message is checked and re-encoded by encodeClientMessage,
// so nothing the browser sends reaches the device as raw bytes.
function createInputHandler(ws, session, getStream) {
  let windowStart = Date.now();
  let inputCount = 0;
  let rejectedCount = 0;

  return (data, isBinary) => {
    const now = Date.now();
    if (now - windowStart >= INPUT_WINDOW_MS) {
      windowStart = now;
      inputCount = 0;
    }
    inputCount += 1;
    if (inputCount > MAX_INPUTS_PER_WINDOW) return; // flood: drop until the next window
    try {
      if (isBinary) throw new InputError('binary input is not accepted');
      const message = parseJson(data);
      if (message !== null && message.t === 'end') return sessions.end(session, 'ended by user');
      // Round-trip probe for the latency report; it never reaches the device.
      if (message !== null && message.t === 'ping') return sendJson(ws, { type: 'pong', id: Number.isInteger(message.id) ? message.id : 0 });
      // A restricted session may only send the actions on its list; anything else is
      // dropped here, whatever page or script sent it.
      if (session.mode === 'restricted' && !isAllowedWhenRestricted(message)) return;
      const stream = getStream();
      if (!stream) return; // the device is still starting; there is nothing to control yet
      stream.scrcpy.sendControl(encodeClientMessage(message, stream.videoSize));
      sessions.touch(session);
    } catch (err) {
      if (!(err instanceof InputError)) {
        // An unexpected failure must end this viewer only, never the whole server.
        logger.error(`session ${session.id} input handling failed: ${err.stack || err.message}`);
        return ws.close(WS_CLOSE_INTERNAL, 'input handling failed');
      }
      rejectedCount += 1;
      logger.info(`session ${session.id} rejected input: ${err.message}`);
      if (rejectedCount > MAX_REJECTED_INPUTS) ws.close(WS_CLOSE_POLICY, 'too many invalid messages');
    }
  };
}

// While someone is using a restricted device, checks every second that it is still
// pinned on the allowed app, and re-applies the lock if it is not.
function startRestrictionWatchdog(session, device) {
  let isChecking = false;
  return setInterval(async () => {
    if (isChecking || session.isEnded) return;
    isChecking = true;
    try {
      if (await enforceRestriction(device.serial)) logger.info(`session ${session.id} restriction was lost and re-applied`);
    } catch (err) {
      logger.error(`session ${session.id} restriction check failed: ${err.message}`);
    } finally {
      isChecking = false;
    }
  }, RESTRICTION_CHECK_MS);
}

// Starts scrcpy on the session's device and relays its video to this viewer.
function startStream(ws, session, device) {
  const stream = { scrcpy: startScrcpySession(device.serial), videoSize: null, watchdog: null };
  if (session.mode === 'restricted') stream.watchdog = startRestrictionWatchdog(session, device);
  logger.info(`session ${session.id} streaming, scrcpy ${stream.scrcpy.scid}`);

  const recorder = recorderFor(session.id, session.mode);

  stream.scrcpy.on('event', (event) => {
    recorder.write(event);
    if (event.type === 'session') stream.videoSize = { width: event.width, height: event.height };
    if (ws.readyState !== ws.OPEN) return;
    if (event.type !== 'packet') return ws.send(JSON.stringify(event));
    // A viewer that cannot keep up would otherwise fall further and further behind.
    // Dropping it makes the page reconnect and resume from a fresh key frame.
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.close(WS_CLOSE_TRY_AGAIN, 'viewer too slow');
    ws.send(encodePacket(event));
  });
  stream.scrcpy.on('stage', (stage) => sendJson(ws, progressMessage(stage)));
  stream.scrcpy.on('device', (message) => {
    if (message.type === 'clipboard') sendJson(ws, { type: 'clipboard', text: message.text.slice(0, MAX_CLIPBOARD_CHARS) });
  });
  stream.scrcpy.on('close', (reason) => {
    logger.info(`session ${session.id} scrcpy ${stream.scrcpy.scid} closed: ${reason}`);
    if (ws.readyState === ws.OPEN) ws.close(WS_CLOSE_INTERNAL, reason.slice(0, MAX_REASON_LENGTH));
  });
  return stream;
}

function handleViewer(ws, req) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  if (!isOriginAllowed(req.headers.origin, req.headers.host)) return ws.close(WS_CLOSE_POLICY, 'origin not allowed');
  if (!isAccessCodeValid(config.accessCode, params.get('code') ?? '')) return ws.close(WS_CLOSE_BAD_CODE, 'access code required');

  // A page that was already showing a device reconnects with "resume=only": if that
  // session is gone (idle, or the server restarted), it must be told so, not handed a
  // different device as if nothing had happened.
  if (params.get('resume') === 'only' && !sessions.has(params.get('session') ?? '')) {
    return ws.close(WS_CLOSE_SESSION_ENDED, 'the session has expired');
  }

  const onSessionEnd = (reason) => {
    if (ws.readyState === ws.OPEN) ws.close(WS_CLOSE_SESSION_ENDED, reason.slice(0, MAX_REASON_LENGTH));
  };
  let session;
  try {
    // The mode only matters for a new session; an existing one keeps its own.
    const asked = params.get('mode');
    const mode = asked === 'full' || asked === 'restricted' ? asked : config.defaultMode;
    session = sessions.attach(params.get('session'), onSessionEnd, mode, visitorAddress(req.headers['x-forwarded-for']));
  } catch (err) {
    if (err instanceof BusyError) return ws.close(WS_CLOSE_BUSY, 'all devices are in use');
    if (err instanceof LimitError) return ws.close(WS_CLOSE_ADDRESS_LIMIT, 'too many devices for this address');
    logger.error(`could not open a session: ${err.stack || err.message}`);
    return ws.close(WS_CLOSE_INTERNAL, 'could not open a session');
  }

  let stream = null;
  sendJson(ws, { type: 'device', state: 'starting', token: session.token, mode: session.mode });
  // Where the device's start-up stands now, then each further stage as it happens.
  const onStage = (stage) => sendJson(ws, progressMessage(stage));
  onStage(session.stage);
  session.onStage = onStage;
  ws.on('message', createInputHandler(ws, session, () => stream));
  ws.on('error', (err) => logger.info(`session ${session.id} viewer socket error: ${err.message}`));
  ws.on('close', () => {
    if (stream) {
      clearInterval(stream.watchdog);
      stream.scrcpy.stop('viewer disconnected');
    }
    if (session.onStage === onStage) session.onStage = null;
    sessions.detach(session, onSessionEnd);
  });

  // If the device fails to start, the session ends and onSessionEnd closes this viewer.
  session.ready.then((device) => {
    if (ws.readyState !== ws.OPEN || session.isEnded) return;
    sendJson(ws, { type: 'device', state: 'ready', mode: session.mode });
    stream = startStream(ws, session, device);
  }, () => {});
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: STREAM_PATH, maxPayload: MAX_INPUT_MESSAGE_BYTES });
const aliveViewers = new WeakSet();

wss.on('connection', (ws, req) => {
  aliveViewers.add(ws);
  ws.on('pong', () => aliveViewers.add(ws));
  handleViewer(ws, req);
});

// A viewer whose network vanished never sends a close. Ping each one; a viewer that did
// not answer the previous ping is dropped, which starts its session's grace timer.
const recordingCleanup = setInterval(cleanUpRecordings, RECORDING_CLEANUP_MS);
recordingCleanup.unref();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!aliveViewers.has(ws)) {
      ws.terminate();
      continue;
    }
    aliveViewers.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

async function main() {
  if (!fs.existsSync(config.scrcpy.localJar)) {
    throw new Error(`scrcpy-server not found at ${config.scrcpy.localJar} (run scripts/fetch-scrcpy-server.sh)`);
  }
  if (config.accessCode === '') {
    logger.info('ACCESS_CODE is not set: anyone who can reach this server can start a device');
  } else if (config.accessCode.length < MIN_ACCESS_CODE_LENGTH) {
    throw new Error(`ACCESS_CODE must be at least ${MIN_ACCESS_CODE_LENGTH} characters`);
  }
  // Devices from an earlier run (a crash or a kill) have no session any more.
  const orphans = await removeOrphans();
  if (orphans > 0) logger.info(`removed ${orphans} leftover device(s) from an earlier run`);
  await ensureNetwork();
  cleanUpRecordings();
  server.listen(config.port, config.host, () => {
    logger.info(`listening on http://${config.host}:${config.port}, up to ${config.maxSessions} devices, ${config.maxSessionsPerAddress} per visitor address`);
  });
}

// On a normal stop (systemd, Ctrl+C) every session ends, which removes its device.
function shutdown(signal) {
  logger.info(`${signal} received, ending ${sessions.count()} session(s)`);
  for (const ws of wss.clients) ws.close(WS_CLOSE_GOING_AWAY, 'server shutting down');
  sessions.endAll('server shutting down');
  server.close();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error(`startup failed: ${err.message}`);
  process.exit(1);
});
