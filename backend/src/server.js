'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { config } = require('./config');
const { logger } = require('./logger');
const { adb, connectDevice } = require('./adb');
const { startScrcpySession, pushScrcpyServer } = require('./scrcpySession');

const STREAM_PATH = '/stream';
const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const WS_CLOSE_TRY_AGAIN = 1013;
const WS_CLOSE_INTERNAL = 1011;
const WS_CLOSE_GOING_AWAY = 1001;
const SHUTDOWN_GRACE_MS = 2000;

// Only these files are served; anything else is a 404, so no path from the URL reaches the disk.
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.mjs', { file: 'app.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/h264.mjs', { file: 'h264.mjs', type: 'text/javascript; charset=utf-8' }],
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

function handleViewer(ws) {
  if (wss.clients.size > config.maxViewers) {
    return ws.close(WS_CLOSE_TRY_AGAIN, 'too many viewers');
  }
  const session = startScrcpySession();
  logger.info(`viewer connected, scrcpy ${session.scid}`);

  session.on('event', (event) => {
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
const wss = new WebSocketServer({ server, path: STREAM_PATH });
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
