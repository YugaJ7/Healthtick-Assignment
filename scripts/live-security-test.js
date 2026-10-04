'use strict';

// Live test of the device fences, run ON THE SERVER against the running backend:
//
//   sudo /opt/node/bin/node /opt/android-web/scripts/live-security-test.js
//
// It opens one ordinary session and, from inside that device, tries the things a hostile
// app on the device would try: reach the device's own debugging port, the server, the
// cloud metadata address, and install an app. sudo is needed for `docker exec`.
// Set EXPECT_INTERNET=on when the server runs with DEVICE_INTERNET=on.
// Exit code 0 means every check passed.

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WebSocket = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'ws'));

const URL_BASE = process.env.STREAM_URL || 'ws://127.0.0.1:8080/stream';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const EXPECT_INTERNET = process.env.EXPECT_INTERNET === 'on';
const READY_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_S = 3;
const METADATA_ADDRESS = '169.254.169.254';
const PUBLIC_ADDRESS = '1.1.1.1';
const TEST_APK = '/data/local/tmp/security-test.apk';

const containerOf = (token) => `android-web-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 8)}`;

let failures = 0;
function check(name, isOk, detail = '') {
  if (!isOk) failures += 1;
  process.stdout.write(`${isOk ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`.trim();
  }
}
const inDevice = (name, command) => run('docker', ['exec', name, 'sh', '-c', command]);
const inspect = (name, format) => run('docker', ['inspect', '-f', format, name]);

// Whether a TCP connection from inside the device to host:port succeeds.
function canConnect(name, host, port) {
  return inDevice(name, `nc -w ${CONNECT_TIMEOUT_S} ${host} ${port} </dev/null >/dev/null 2>&1; echo $?`) === '0';
}

function open() {
  const ws = new WebSocket(`${URL_BASE}?${new URLSearchParams({ code: ACCESS_CODE, mode: 'full' })}`);
  const viewer = { ws, token: null, gotVideo: false };
  viewer.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  viewer.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device not ready in time')), READY_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) { viewer.gotVideo = true; return; }
      const message = JSON.parse(data.toString());
      if (message.type !== 'device') return;
      if (message.token) viewer.token = message.token;
      if (message.state === 'ready') { clearTimeout(timer); resolve(viewer); }
    });
    ws.on('error', () => {});
    viewer.closed.then((info) => { clearTimeout(timer); reject(new Error(`closed before ready: ${info.code} ${info.reason}`)); });
  });
  viewer.ready.catch(() => {});
  return viewer;
}

async function main() {
  const viewer = await open().ready;
  const name = containerOf(viewer.token);
  const deviceAddress = inspect(name, '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
  const gateway = inspect(name, '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}');
  const serverAddress = run('hostname', ['-I']).split(/\s+/)[0];
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // The fences must not cut the server's own control of the device.
  check('the server still controls the device (video arrives)', viewer.gotVideo);

  // --- the debugging port, from inside the device ---
  check('the device cannot reach its debugging port on 127.0.0.1', !canConnect(name, '127.0.0.1', 5555));
  check('the device cannot reach its debugging port on its own address', !canConnect(name, deviceAddress, 5555), deviceAddress);
  check('the device cannot reach its debugging port over IPv6', !canConnect(name, '::1', 5555));

  // --- the server and its surroundings ---
  check('the device cannot reach the cloud metadata address', !canConnect(name, METADATA_ADDRESS, 80));
  check('the device cannot reach SSH on the server (bridge address)', !canConnect(name, gateway, 22), gateway);
  check('the device cannot reach the web server on the server (bridge address)', !canConnect(name, gateway, 443), gateway);
  check('the device cannot reach the server on its private address', !canConnect(name, serverAddress, 22), serverAddress);
  const hasInternet = canConnect(name, PUBLIC_ADDRESS, 443);
  check(`internet access from the device is ${EXPECT_INTERNET ? 'kept' : 'off'}`, hasInternet === EXPECT_INTERNET, `connect to ${PUBLIC_ADDRESS}:443 ${hasInternet ? 'worked' : 'failed'}`);
  if (EXPECT_INTERNET) {
    const lookup = inDevice(name, 'ping -c 1 -W 3 example.com >/dev/null 2>&1; echo $?');
    check('names still resolve on the device', lookup === '0', `ping example.com exit ${lookup}`);
  }

  // --- installing an app ---
  const restrictions = inDevice(name, 'dumpsys user | grep -o "no_install[a-z_]*" | sort -u').replace(/\s+/g, ' ');
  check('the install restrictions are set', restrictions.includes('no_install_apps') && restrictions.includes('no_install_unknown_sources'), restrictions || 'none');
  const apk = inDevice(name, 'pm path com.android.deskclock').replace('package:', '');
  inDevice(name, `cp ${apk} ${TEST_APK} && chmod 644 ${TEST_APK}`);
  const install = inDevice(name, `pm install -r ${TEST_APK} 2>&1 | tail -1`);
  check('installing an app on the device is refused', !install.includes('Success'), install);

  // --- resource limit ---
  const cpu = inspect(name, '{{.HostConfig.NanoCpus}}');
  check('the device has a CPU limit', Number(cpu) > 0, `${Number(cpu) / 1e9} CPUs`);

  viewer.ws.send(JSON.stringify({ t: 'end' }));
  await viewer.closed;
  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`TEST ABORTED: ${err.message}\n`);
  process.exit(2);
});
