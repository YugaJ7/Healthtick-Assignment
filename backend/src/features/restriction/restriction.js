'use strict';

const { adb } = require('../devices/adb');
const { config } = require('../../shared/config');

// "Restricted" sessions can use one app only (Clock by default). Three layers, none of
// which lives in the browser:
//   1. On the device: every other app that can be opened is disabled, and the allowed
//      app runs in Android's lock task mode in its LOCKED state (the state a kiosk
//      uses). Home, Recents, the notification shade and starting other apps are off,
//      and unlike screen pinning there is no gesture that ends it.
//   2. On the server, per message: only a fixed set of actions is passed on.
//   3. On the server, every second: a check that the device is still locked on the
//      allowed app; if not, the lock is applied again.
//
// How the LOCKED state is reached without a device-owner app: Android only grants it to
// apps on its lock-task allow-list. A device owner normally fills that list; here the
// server does, as root, with the same system call (updateLockTaskPackages). An app on
// the list that is started with "--lock-task" enters the LOCKED state at once.

// Keys a restricted session may send. Home and AppSwitch are not on the list.
const RESTRICTED_KEYS = new Set([
  'Back', 'Enter', 'Backspace', 'Delete', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MoveHome', 'MoveEnd',
]);
// One finger only: leaving a pinned app takes two fingers (Back and Recents held together).
const RESTRICTED_POINTER_ID = 0;
const RESTRICTED_TYPES = new Set(['touch', 'scroll', 'key', 'text', 'paste', 'copy']);

/**
 * Whether a restricted session may send this input message to the device.
 * @param {unknown} message parsed JSON from the browser
 * @returns {boolean}
 */
function isAllowedWhenRestricted(message) {
  if (message === null || typeof message !== 'object' || !RESTRICTED_TYPES.has(message.t)) return false;
  if (message.t === 'key') return RESTRICTED_KEYS.has(message.key);
  if (message.t === 'touch') return message.id === RESTRICTED_POINTER_ID;
  return true;
}

const shell = (serial, command) => adb(serial, ['shell', command]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOCK_SETTLE_POLL_MS = 200;
const LOCK_SETTLE_TRIES = 15;

// Puts the allowed app on Android's lock-task allow-list for the device's only user (0).
// The call is IActivityTaskManager.updateLockTaskPackages(int userId, String[] packages);
// "i32 1" is the length of the array. Its number differs between Android versions (see
// config.js), so the caller always checks afterwards that the lock really took.
function allowLockTask(execAsRoot) {
  const { packageName, lockTaskCallCode } = config.restricted;
  return execAsRoot(['/system/bin/service', 'call', 'activity_task', String(lockTaskCallCode), 'i32', '0', 'i32', '1', 's16', packageName]);
}

// Starts the allowed app in lock task mode and waits until Android reports it locked.
async function startLocked(serial) {
  const { packageName, activity } = config.restricted;
  await shell(serial, `am start --lock-task -n ${packageName}/${activity}`);
  for (let attempt = 0; attempt < LOCK_SETTLE_TRIES; attempt += 1) {
    if ((await readRestrictionState(serial)).isIntact) return true;
    await sleep(LOCK_SETTLE_POLL_MS);
  }
  return false;
}

/**
 * Locks a freshly booted device to the allowed app.
 * @param {string} serial
 * @param {(args: string[]) => Promise<string>} execAsRoot runs a command in the device's container as root
 */
async function applyRestriction(serial, execAsRoot) {
  const { packageName, disabledPackages } = config.restricted;
  for (const other of disabledPackages) {
    if (other !== packageName) await shell(serial, `pm disable-user --user 0 ${other}`);
  }
  // Keep the screen upright so the layout the user sees never changes under them.
  await shell(serial, 'settings put system accelerometer_rotation 0');
  await allowLockTask(execAsRoot);
  if (!(await startLocked(serial))) throw new Error(`device is not locked to ${packageName} after setup`);
}

/**
 * @param {string} serial
 * @returns {Promise<{ isLocked: boolean, isAllowedAppInFront: boolean, isIntact: boolean }>}
 */
async function readRestrictionState(serial) {
  // The resumed activity is used, not the focused window: a menu or dialog of the allowed
  // app is its own window, and must not count as having left the app.
  const report = await shell(serial, 'dumpsys activity activities 2>/dev/null | grep -E "mLockTaskModeState|ResumedActivity"');
  const isLocked = report.includes('mLockTaskModeState=LOCKED');
  const resumed = report.split('\n').filter((line) => line.includes('ResumedActivity'));
  const isAllowedAppInFront = resumed.length > 0 && resumed.every((line) => line.includes(` ${config.restricted.packageName}/`));
  return { isLocked, isAllowedAppInFront, isIntact: isLocked && isAllowedAppInFront };
}

/**
 * Checks the device and repairs the lock if it was lost (for example after the allowed
 * app crashed, which ends lock task mode).
 * @param {string} serial
 * @returns {Promise<boolean>} true when a repair was needed
 */
async function enforceRestriction(serial) {
  if ((await readRestrictionState(serial)).isIntact) return false;
  // A fresh start is what enters the LOCKED state, so whatever is left of the app goes first.
  await shell(serial, `am force-stop ${config.restricted.packageName}`);
  await startLocked(serial);
  return true;
}

module.exports = { isAllowedWhenRestricted, applyRestriction, enforceRestriction, readRestrictionState };
