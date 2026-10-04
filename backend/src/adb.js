'use strict';

const { execFile, spawn } = require('node:child_process');
const { config } = require('./config');

const ADB_TIMEOUT_MS = 20_000;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, args, { timeout: ADB_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`adb ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * Runs one adb command against a device and resolves with its trimmed stdout.
 * @param {string} serial device address, for example "127.0.0.1:32768"
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function adb(serial, args) {
  return run(['-s', serial, ...args]);
}

/**
 * Starts a long-running command on a device (used for scrcpy-server).
 * @param {string} serial
 * @param {string} command
 */
function adbShellSpawn(serial, command) {
  return spawn(config.adbPath, ['-s', serial, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const adbConnect = (serial) => run(['connect', serial]);
const adbDisconnect = (serial) => run(['disconnect', serial]);

module.exports = { adb, adbShellSpawn, adbConnect, adbDisconnect };
