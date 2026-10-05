'use strict';

// Live test of the single-app restriction, run ON THE SERVER against the running backend:
//
//   sudo /opt/node/bin/node /opt/android-web/scripts/live-restriction-test.js
//
// It opens one restricted session, tries to leave the Clock app in every way listed
// below, and checks after each attempt that the device is still locked on Clock.
// sudo is needed for `docker exec`. Exit code 0 means every check passed.

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WebSocket = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'ws'));

const URL_BASE = process.env.STREAM_URL || 'ws://127.0.0.1:8080/stream';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const ALLOWED_PACKAGE = process.env.RESTRICTED_PACKAGE || 'com.android.deskclock';
const READY_TIMEOUT_MS = 90_000;
const SETTLE_MS = 1500;
const WATCHDOG_WAIT_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const containerOf = (token) => `android-web-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 8)}`;

let failures = 0;
function check(name, isOk, detail = '') {
  if (!isOk) failures += 1;
  process.stdout.write(`${isOk ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function inDevice(name, command) {
  try {
    return execFileSync('docker', ['exec', name, 'sh', '-c', command], { encoding: 'utf8' }).trim();
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`.trim();
  }
}

function deviceState(name) {
  const report = inDevice(name, 'dumpsys activity activities 2>/dev/null | grep -E "mLockTaskModeState|ResumedActivity"');
  const resumed = report.split('\n').filter((line) => line.includes('ResumedActivity'));
  return {
    isOnClock: resumed.length > 0 && resumed.every((line) => line.includes(` ${ALLOWED_PACKAGE}/`)),
    // LOCKED is the kiosk state; PINNED (screen pinning, which a gesture can end) is not enough.
    isPinned: report.includes('mLockTaskModeState=LOCKED'),
    focus: resumed.join(' ').replace(/\s+/g, ' ') || 'no resumed activity',
  };
}

function open(params) {
  const query = new URLSearchParams({ code: ACCESS_CODE, ...params });
  const ws = new WebSocket(`${URL_BASE}?${query}`);
  const viewer = { ws, token: null, mode: null, hasVideoSize: false, width: 0, height: 0 };
  viewer.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  viewer.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device not ready in time')), READY_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'session') Object.assign(viewer, { hasVideoSize: true, width: message.width, height: message.height });
      if (message.type !== 'device') return;
      if (message.token) viewer.token = message.token;
      if (message.mode) viewer.mode = message.mode;
      if (message.state === 'ready') {
        clearTimeout(timer);
        resolve(viewer);
      }
    });
    ws.on('error', () => {});
  });
  return viewer;
}

async function main() {
  const viewer = await open({ mode: 'restricted' }).ready;
  const name = containerOf(viewer.token);
  // Touch positions in this file are written for the device's 720 x 1280 screen. The
  // server expects them in video pixels, and the video may be smaller than the screen.
  const toVideo = (value, screen, video) => Math.min(video - 1, Math.round((value * video) / screen));
  const send = (message) => {
    const scaled = message.t === 'touch'
      ? { ...message, x: toVideo(message.x, 720, viewer.width), y: toVideo(message.y, 1280, viewer.height) }
      : message;
    viewer.ws.send(JSON.stringify(scaled));
  };
  while (!viewer.hasVideoSize) await sleep(200);
  await sleep(SETTLE_MS);

  // Runs one escape attempt, then checks the device is still on Clock and pinned.
  async function attempt(label, action) {
    await action();
    await sleep(SETTLE_MS);
    const state = deviceState(name);
    check(`still on Clock after: ${label}`, state.isOnClock && state.isPinned, state.isOnClock && state.isPinned ? '' : state.focus);
  }

  check('the session reports that it is restricted', viewer.mode === 'restricted');
  const start = deviceState(name);
  check('the device starts on Clock, in the LOCKED state', start.isOnClock && start.isPinned, start.focus);
  const launchable = inDevice(name, 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep /');
  check('Clock is the only app that can be opened', launchable.split('\n').every((line) => line.includes(ALLOWED_PACKAGE)), launchable.replace(/\s+/g, ' '));

  // --- through the WebSocket, as a modified page or a script could ---
  const press = (key) => { send({ t: 'key', a: 'down', key }); send({ t: 'key', a: 'up', key }); };
  await attempt('Home key message', () => press('Home'));
  await attempt('Recents key message', () => press('AppSwitch'));
  await attempt('key names outside the list (Power, Settings, Search)', () => ['Power', 'Settings', 'Search', 'Menu'].forEach(press));
  await attempt('made-up message types (start-app, open-url, expand-notifications)', () => {
    send({ t: 'start-app', name: 'com.android.settings' });
    send({ t: 'open-url', url: 'https://example.com' });
    send({ t: 'expand-notifications' });
  });
  await attempt('raw scrcpy bytes as a binary frame (Home key, start app)', () => {
    viewer.ws.send(Buffer.from([0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]));
    viewer.ws.send(Buffer.concat([Buffer.from([16, 8]), Buffer.from('settings')]));
  });
  await attempt('swipe down from the top edge (notification shade)', async () => {
    send({ t: 'touch', a: 'down', id: 0, x: 360, y: 2 });
    for (let y = 60; y <= 900; y += 120) { send({ t: 'touch', a: 'move', id: 0, x: 360, y }); await sleep(20); }
    send({ t: 'touch', a: 'up', id: 0, x: 360, y: 900 });
  });
  await attempt('tap the Home and Recents buttons on the screen', async () => {
    for (const x of [360, 540]) {
      send({ t: 'touch', a: 'down', id: 0, x, y: 1230 });
      await sleep(80);
      send({ t: 'touch', a: 'up', id: 0, x, y: 1230 });
      await sleep(400);
    }
  });
  await attempt('two fingers held on Back and Recents for 4 s (the unpin gesture)', async () => {
    send({ t: 'touch', a: 'down', id: 0, x: 178, y: 1230 });
    send({ t: 'touch', a: 'down', id: 1, x: 540, y: 1230 });
    await sleep(4000);
    send({ t: 'touch', a: 'up', id: 1, x: 540, y: 1230 });
    send({ t: 'touch', a: 'up', id: 0, x: 178, y: 1230 });
  });
  await attempt('Back pressed five times (backing out of the app)', async () => {
    for (let i = 0; i < 5; i += 1) { press('Back'); await sleep(300); }
  });

  // --- asking the server for an unrestricted session with the same token ---
  viewer.ws.close();
  await viewer.closed;
  const again = await open({ mode: 'full', session: viewer.token }).ready;
  check('reconnecting with mode=full keeps the session restricted', again.mode === 'restricted' && again.token === viewer.token);

  // --- on the device itself (what would happen if some route did get through) ---
  const settings = inDevice(name, 'am start -a android.settings.SETTINGS 2>&1 | tail -1');
  await sleep(SETTLE_MS);
  check('starting Settings on the device is refused', deviceState(name).isOnClock, settings);
  inDevice(name, 'am task lock stop');
  await sleep(SETTLE_MS);
  const afterStop = deviceState(name);
  check('the command that ends screen pinning does not end this lock', afterStop.isPinned && afterStop.isOnClock, afterStop.focus);
  // Killing the app is one way the lock really is lost: lock task mode ends with its task.
  inDevice(name, `am force-stop ${ALLOWED_PACKAGE}`);
  await sleep(WATCHDOG_WAIT_MS);
  const repaired = deviceState(name);
  check('the server restores the lock within 3 s if the app is killed', repaired.isPinned && repaired.isOnClock, repaired.focus);

  again.ws.send(JSON.stringify({ t: 'end' }));
  await again.closed;
  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`TEST ABORTED: ${err.message}\n`);
  process.exit(2);
});
