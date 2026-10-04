'use strict';

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
    memory: process.env.DEVICE_MEMORY || '2g',
    width: intFromEnv('DEVICE_WIDTH', 720),
    height: intFromEnv('DEVICE_HEIGHT', 1280),
    fps: intFromEnv('DEVICE_FPS', 30),
    bootTimeoutMs: intFromEnv('DEVICE_BOOT_TIMEOUT_MS', 90_000),
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
