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
  deviceSerial: process.env.ADB_SERIAL || '127.0.0.1:5555',
  maxViewers: intFromEnv('MAX_VIEWERS', 3),
  frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
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
