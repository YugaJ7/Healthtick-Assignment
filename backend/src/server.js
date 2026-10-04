'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { config } = require('./config');
const { logger } = require('./logger');
const { adb, connectDevice } = require('./adb');
const { startScrcpySession, pushScrcpyServer } = require('./scrcpySession');
const { encodeClientMessage, InputError } = require('./controlMessages');

const STREAM_PATH = '/stream';
const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const WS_CLOSE_TRY_AGAIN = 1013;
const WS_CLOSE_INTERNAL = 1011;
const WS_CLOSE_GOING_AWAY = 1001;
const WS_CLOSE_POLICY = 1008;
const MAX_INPUT_MESSAGE_BYTES = 2048;
const INPUT_WINDOW_MS = 1000;
const MAX_INPUTS_PER_WINDOW = 1000;
const MAX_REJECTED_INPUTS = 50;
const SHUTDOWN_GRACE_MS = 2000;

// Only these files are served; anything else is a 404, so no path from the URL reaches the disk.
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.mjs', { file: 'app.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/h264.mjs', { file: 'h264.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/input.mjs', { file: 'input.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/pointerMap.mjs', { file: 'pointerMap.mjs', type: 'text/javascript; charset=utf-8' }],
]);

function handleHttp(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, viewers: wss.clients.size }));
  }
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
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store' });
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

function parseJson(data) {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new InputError('message is not valid JSON');
  }
}

function handleViewer(ws) {
  if (wss.clients.size > config.maxViewers) {
    return ws.close(WS_CLOSE_TRY_AGAIN, 'too many viewers');
  }
  const session = startScrcpySession();
  logger.info(`viewer connected, scrcpy ${session.scid}`);

  let videoSize = null;
  let inputWindowStart = Date.now();
  let inputCount = 0;
  let rejectedCount = 0;

  // Input from the browser. Every message is checked and re-encoded by encodeClientMessage,
  // so nothing the browser sends reaches the device as raw bytes.
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - inputWindowStart >= INPUT_WINDOW_MS) {
      inputWindowStart = now;
      inputCount = 0;
    }
    inputCount += 1;
    if (inputCount > MAX_INPUTS_PER_WINDOW) return; // flood: drop until the next window
    try {
      if (isBinary) throw new InputError('binary input is not accepted');
      session.sendControl(encodeClientMessage(parseJson(data), videoSize));
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      rejectedCount += 1;
      logger.info(`scrcpy ${session.scid} rejected input: ${err.message}`);
      if (rejectedCount > MAX_REJECTED_INPUTS) ws.close(WS_CLOSE_POLICY, 'too many invalid messages');
    }
  });

  session.on('event', (event) => {
    if (event.type === 'session') videoSize = { width: event.width, height: event.height };
    if (ws.readyState !== ws.OPEN) return;
    if (event.type !== 'packet') return ws.send(JSON.stringify(event));
    // A viewer that cannot keep up would otherwise fall further and further behind.
    // Dropping it makes the page reconnect and resume from a fresh key frame.
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.close(WS_CLOSE_TRY_AGAIN, 'viewer too slow');
    ws.send(encodePacket(event));
  });
  session.on('close', (reason) => {
    logger.info(`scrcpy ${session.scid} closed: ${reason}`);
    if (ws.readyState === ws.OPEN) ws.close(WS_CLOSE_INTERNAL, reason.slice(0, 100));
  });
  ws.on('close', () => session.stop('viewer disconnected'));
  ws.on('error', (err) => session.stop(`viewer socket error: ${err.message}`));
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: STREAM_PATH, maxPayload: MAX_INPUT_MESSAGE_BYTES });
wss.on('connection', handleViewer);

async function main() {
  if (!fs.existsSync(config.scrcpy.localJar)) {
    throw new Error(`scrcpy-server not found at ${config.scrcpy.localJar} (run scripts/fetch-scrcpy-server.sh)`);
  }
  await connectDevice();
  // A backend that was killed leaves its adb forwards behind; clear them before starting.
  await adb(['forward', '--remove-all']);
  await pushScrcpyServer();
  server.listen(config.port, config.host, () => {
    logger.info(`listening on http://${config.host}:${config.port}, device ${config.deviceSerial}`);
  });
}

// On a normal stop (systemd, Ctrl+C) close every viewer, which stops its scrcpy session.
function shutdown(signal) {
  logger.info(`${signal} received, closing ${wss.clients.size} viewer(s)`);
  for (const ws of wss.clients) ws.close(WS_CLOSE_GOING_AWAY, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error(`startup failed: ${err.message}`);
  process.exit(1);
});
