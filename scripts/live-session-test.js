'use strict';

// Live test of per-user isolation and on-demand devices, run ON THE SERVER against the
// running backend. It opens real sessions, so it needs free capacity (no other users).
//
//   sudo ACCESS_CODE=$(sudo grep ACCESS_CODE /etc/android-web.env | cut -d= -f2) \
//     /opt/node/bin/node scripts/live-session-test.js
//
// sudo is needed because the test looks inside the device containers with `docker exec`.
// Exit code 0 means every check passed.

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WebSocket = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'ws'));

const URL_BASE = process.env.STREAM_URL || 'ws://127.0.0.1:8080/stream';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const GRACE_MS = Number(process.env.SESSION_GRACE_MS || 30_000);
const READY_TIMEOUT_MS = 90_000;
const CLOSE_BUSY = 4429;
const CLOSE_ENDED = 4410;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const containerOf = (token) => `android-web-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 8)}`;

let failures = 0;
function check(name, isOk, detail = '') {
  if (!isOk) failures += 1;
  process.stdout.write(`${isOk ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}
const inDevice = (name, command) => docker(['exec', name, 'sh', '-c', command]);
const runningDevices = () => docker(['ps', '--filter', 'label=android-web=session', '--format', '{{.Names}}']).split('\n').filter(Boolean);
const exists = (name) => runningDevices().includes(name);

// Opens one viewer. `ready` resolves when the device is up; `closed` when the socket closes.
function open(token) {
  const query = new URLSearchParams({ code: ACCESS_CODE });
  if (token) query.set('session', token);
  const ws = new WebSocket(`${URL_BASE}?${query}`);
  const viewer = { ws, token: null, startedAt: Date.now(), readyMs: null };
  viewer.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  viewer.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device not ready in time')), READY_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type !== 'device') return;
      if (message.token) viewer.token = message.token;
      if (message.state === 'ready') {
        clearTimeout(timer);
        viewer.readyMs = Date.now() - viewer.startedAt;
        resolve(viewer);
      }
    });
    viewer.closed.then((info) => {
      clearTimeout(timer);
      reject(new Error(`closed before ready: ${info.code} ${info.reason}`));
    });
    ws.on('error', () => {});
  });
  viewer.ready.catch(() => {});
  return viewer;
}

async function main() {
  check('no devices exist before the test', runningDevices().length === 0, runningDevices().join(',') || 'none');

  // --- on demand: a device exists only once someone asks for it ---
  const a = await open().ready;
  const b = await open().ready;
  const nameA = containerOf(a.token);
  const nameB = containerOf(b.token);
  check('each session got its own device', nameA !== nameB && exists(nameA) && exists(nameB), `${a.readyMs} ms and ${b.readyMs} ms to ready`);

  // --- isolation: what A does is invisible to B ---
  inDevice(nameA, 'mkdir -p /sdcard/Download && echo secret-of-a > /sdcard/Download/a.txt && settings put system screen_brightness 77 && pm disable-user --user 0 com.android.gallery3d');
  check('A sees its own file, setting and app change',
    inDevice(nameA, 'cat /sdcard/Download/a.txt') === 'secret-of-a'
    && inDevice(nameA, 'settings get system screen_brightness') === '77'
    && inDevice(nameA, 'pm list packages -d').includes('com.android.gallery3d'));
  // On a new device the folder may not exist yet; that also means the file is not there.
  check('B does not see A\'s file', inDevice(nameB, 'ls /sdcard/Download/a.txt 2>/dev/null; true') === '');
  check('B does not see A\'s setting', inDevice(nameB, 'settings get system screen_brightness') !== '77');
  check('B does not see A\'s app change', inDevice(nameB, 'pm list packages -d').includes('com.android.gallery3d') === false);
  const ipA = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', nameA]);
  const ping = inDevice(nameB, `ping -c 1 -W 2 ${ipA} >/dev/null 2>&1; echo $?`);
  check('B\'s device cannot reach A\'s device over the network', ping !== '0', `ping exit ${ping}`);

  // --- a guessed token does not join someone else's session ---
  const c = await open('0'.repeat(32)).ready;
  check('an unknown token gets a new, separate device', c.token !== a.token && containerOf(c.token) !== nameA);

  // --- capacity ---
  const busy = await open().closed;
  check('a fourth user is told the service is busy', busy.code === CLOSE_BUSY, `close ${busy.code} ${busy.reason}`);
  check('no fourth device was created', runningDevices().length === 3);

  // --- explicit end ---
  const nameC = containerOf(c.token);
  c.ws.send(JSON.stringify({ t: 'end' }));
  const ended = await c.closed;
  await sleep(3000);
  check('End session closes the viewer with the reason', ended.code === CLOSE_ENDED, `close ${ended.code} ${ended.reason}`);
  check('End session removes the device', !exists(nameC));

  // --- a short disconnect resumes the same device ---
  a.ws.close();
  await a.closed;
  await sleep(2000);
  const a2 = await open(a.token).ready;
  check('reconnecting with the token resumes the same device', a2.token === a.token && inDevice(nameA, 'cat /sdcard/Download/a.txt') === 'secret-of-a', `${a2.readyMs} ms`);

  // --- tab closed / connection lost: device removed after the grace time ---
  b.ws.terminate();
  await sleep(5000);
  check('device is kept for a moment after the viewer vanishes', exists(nameB));
  await sleep(GRACE_MS);
  check('device is removed after the grace time', !exists(nameB));

  // --- clean end state ---
  a2.ws.send(JSON.stringify({ t: 'end' }));
  await a2.closed;
  await sleep(3000);
  check('nothing is left running at the end', runningDevices().length === 0, runningDevices().join(',') || 'none');

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`TEST ABORTED: ${err.message}\n`);
  process.exit(2);
});
