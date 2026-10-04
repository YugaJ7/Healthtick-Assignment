// SPIKE 2 (throwaway): one frame in a browser and one tap landing, by the simplest path.
// Uses `adb screencap` polling and `adb shell input tap`. This is deliberately the slow,
// naive approach: it proves the loop works and gives baseline timings to beat.
//
// Run on the VM after spike 1:   node 02-screencap-tap.js
// View from your laptop through an SSH tunnel (the port is NOT opened publicly,
// because this page has no authentication):
//   ssh -L 8080:127.0.0.1:8080 user@SERVER    then open http://localhost:8080
// Status: syntax-checked only. NOT yet run against a device.
'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');

const DEVICE = process.env.ADB_ADDR || '127.0.0.1:5555';
const HOST = '127.0.0.1';
const PORT = 8080;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_COORD = 10000;

function adb(args, encoding) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile('adb', ['-s', DEVICE, ...args], { encoding, maxBuffer: MAX_PNG_BYTES }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ stdout, ms: Date.now() - started });
    });
  });
}

function parseCoord(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_COORD ? n : null;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Spike 2</title>
<style>
  body { font-family: sans-serif; margin: 16px; }
  img { height: 80vh; border: 1px solid #888; cursor: crosshair; }
</style>
<p>Click the picture to tap. <span id="log"></span></p>
<img id="screen" alt="device screen">
<script>
  const img = document.getElementById('screen');
  const log = document.getElementById('log');
  function refresh() { img.src = '/frame.png?t=' + Date.now(); }
  img.onload = () => setTimeout(refresh, 200);
  img.onerror = () => setTimeout(refresh, 1000);
  img.addEventListener('click', async (e) => {
    // Map from the drawn size (CSS pixels) to the picture's own size (device pixels).
    const box = img.getBoundingClientRect();
    const x = Math.round((e.clientX - box.left) * img.naturalWidth / box.width);
    const y = Math.round((e.clientY - box.top) * img.naturalHeight / box.height);
    const res = await fetch('/tap?x=' + x + '&y=' + y, { method: 'POST' });
    log.textContent = 'tap ' + x + ',' + y + ' -> ' + await res.text();
  });
  refresh();
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/frame.png') {
      const { stdout, ms } = await adb(['exec-out', 'screencap', '-p'], 'buffer');
      console.log(`screencap ${ms} ms, ${stdout.length} bytes`);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(stdout);
    }
    if (req.method === 'POST' && url.pathname === '/tap') {
      const x = parseCoord(url.searchParams.get('x'));
      const y = parseCoord(url.searchParams.get('y'));
      if (x === null || y === null) {
        res.writeHead(400);
        return res.end('bad coordinates');
      }
      const { ms } = await adb(['shell', 'input', 'tap', String(x), String(y)], 'utf8');
      console.log(`tap ${x},${y} took ${ms} ms`);
      res.writeHead(200);
      return res.end(`ok in ${ms} ms`);
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed: ${err.message}`);
    res.writeHead(500);
    res.end('adb failed, see server log');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`spike 2 on http://${HOST}:${PORT} (device ${DEVICE})`);
});
