'use strict';

const os = require('node:os');
const path = require('node:path');

const SCRCPY_VERSION = '4.1';

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: intFromEnv('PORT', 8080),
  adbPath: process.env.ADB_PATH || 'adb',
  // One session is one user with their own Android device.
  maxSessions: intFromEnv('MAX_SESSIONS', 3),
  // How many of those one visitor address may hold, so one visitor cannot take them all.
  maxSessionsPerAddress: intFromEnv('MAX_SESSIONS_PER_ADDRESS', 2),
  // How long a device is kept after its viewer disappears (tab closed, network lost).
  graceMs: intFromEnv('SESSION_GRACE_MS', 30_000),
  // A session with no input for this long is ended.
  idleMs: intFromEnv('SESSION_IDLE_MS', 300_000),
  // Shared code a viewer must send to get a stream. Empty means no check (local development).
  accessCode: process.env.ACCESS_CODE || '',
  frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
  device: Object.freeze({
    image: process.env.DEVICE_IMAGE || 'redroid/redroid:12.0.0_64only-latest',
    network: 'android-web-net',
    // Fixed name of the network's bridge, so infra/device-firewall.sh can match it.
    bridge: 'awnet0',
    memory: process.env.DEVICE_MEMORY || '2g',
    // CPU share of one device, in CPUs, so one busy device cannot starve the others.
    cpus: process.env.DEVICE_CPUS || '1.5',
    width: intFromEnv('DEVICE_WIDTH', 720),
    height: intFromEnv('DEVICE_HEIGHT', 1280),
    fps: intFromEnv('DEVICE_FPS', 30),
    bootTimeoutMs: intFromEnv('DEVICE_BOOT_TIMEOUT_MS', 90_000),
  }),
  // "Restricted" sessions may use this one app only (see restriction.js).
  restricted: Object.freeze({
    packageName: process.env.RESTRICTED_PACKAGE || 'com.android.deskclock',
    activity: process.env.RESTRICTED_ACTIVITY || '.DeskClock',
    // Every other app on the redroid image that can be opened or that hosts screens
    // reachable from another app (Settings, the file picker).
    disabledPackages: Object.freeze([
      'com.android.settings', 'com.android.launcher3', 'com.android.documentsui',
      'com.android.gallery3d', 'com.android.contacts', 'com.android.calendar',
      'com.android.quicksearchbox', 'org.chromium.webview_shell', 'com.android.deskclock',
    ]),
  }),
  // Every session's video is saved to one MP4 file named after the session's id.
  recordings: Object.freeze({
    dir: process.env.RECORDINGS_DIR || path.join(os.tmpdir(), 'android-web-recordings'),
    keepMs: intFromEnv('RECORDING_KEEP_MS', 24 * 60 * 60 * 1000),
    maxBytes: intFromEnv('RECORDING_MAX_BYTES', 200 * 1024 * 1024),
    maxTotalBytes: intFromEnv('RECORDINGS_MAX_TOTAL_BYTES', 2 * 1024 * 1024 * 1024),
  }),
  scrcpy: Object.freeze({
    version: SCRCPY_VERSION,
    localJar: process.env.SCRCPY_SERVER_PATH || path.resolve(__dirname, '..', 'vendor', `scrcpy-server-v${SCRCPY_VERSION}`),
    deviceJar: '/data/local/tmp/scrcpy-server.jar',
    maxSize: intFromEnv('VIDEO_MAX_SIZE', 1280),
    maxFps: intFromEnv('VIDEO_MAX_FPS', 30),
    bitRate: intFromEnv('VIDEO_BIT_RATE', 2_000_000),
  }),
});

module.exports = { config };
