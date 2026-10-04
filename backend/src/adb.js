'use strict';

const { execFile, spawn } = require('node:child_process');
const { config } = require('./config');

const ADB_TIMEOUT_MS = 20_000;

// Runs one adb command against the configured device and resolves with its trimmed stdout.
function adb(args) {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, ['-s', config.deviceSerial, ...args], { timeout: ADB_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`adb ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      resolve(stdout.trim());
    });
  });
}

// Starts a long-running command on the device (used for scrcpy-server).
function adbShellSpawn(command) {
  return spawn(config.adbPath, ['-s', config.deviceSerial, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function connectDevice() {
  // `adb connect` is only meaningful for network devices such as a redroid container.
  if (!config.deviceSerial.includes(':')) return;
  await new Promise((resolve, reject) => {
    execFile(config.adbPath, ['connect', config.deviceSerial], { timeout: ADB_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`adb connect failed: ${(stderr || err.message).trim()}`));
      resolve(stdout);
    });
  });
}

module.exports = { adb, adbShellSpawn, connectDevice };
