'use strict';

const { adb } = require('../devices/adb');
const { config } = require('../../shared/config');

// "Restricted" sessions can use one app only (Clock by default). Three layers, none of
// which lives in the browser:
//   1. On the device: every other app that can be opened is disabled, and the allowed
//      app's task is pinned (Android lock task mode), which turns off Home, Recents,
//      the notification shade and starting other apps.
//   2. On the server, per message: only a fixed set of actions is passed on.
//   3. On the server, every second: a check that the device is still pinned on the
//      allowed app; if not, the lock is applied again.

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

// Brings the allowed app to the front and pins its task. Safe to repeat.
async function pinAllowedApp(serial) {
  const { packageName, activity } = config.restricted;
  await shell(serial, `am start -n ${packageName}/${activity}`);
  const stacks = await shell(serial, 'am stack list');
  const match = stacks.match(new RegExp(`taskId=(\\d+): ${packageName.replace(/\./g, '\\.')}/`));
  if (!match) throw new Error(`no task found for ${packageName}`);
  await shell(serial, `am task lock ${match[1]}`);
}

/**
 * Locks a freshly booted device to the allowed app.
 * @param {string} serial
 */
async function applyRestriction(serial) {
  const { packageName, disabledPackages } = config.restricted;
  for (const other of disabledPackages) {
    if (other !== packageName) await shell(serial, `pm disable-user --user 0 ${other}`);
  }
  // Keep the screen upright so the layout the user sees never changes under them.
  await shell(serial, 'settings put system accelerometer_rotation 0');
  await pinAllowedApp(serial);
  const state = await readRestrictionState(serial);
  if (!state.isIntact) throw new Error(`device is not locked to ${packageName} after setup`);
}

/**
 * @param {string} serial
 * @returns {Promise<{ isPinned: boolean, isAllowedAppInFront: boolean, isIntact: boolean }>}
 */
async function readRestrictionState(serial) {
  // The resumed activity is used, not the focused window: a menu or dialog of the allowed
  // app is its own window, and must not count as having left the app.
  const report = await shell(serial, 'dumpsys activity activities 2>/dev/null | grep -E "mLockTaskModeState|ResumedActivity"');
  const isPinned = /mLockTaskModeState=(PINNED|LOCKED)/.test(report);
  const resumed = report.split('\n').filter((line) => line.includes('ResumedActivity'));
  const isAllowedAppInFront = resumed.length > 0 && resumed.every((line) => line.includes(` ${config.restricted.packageName}/`));
  return { isPinned, isAllowedAppInFront, isIntact: isPinned && isAllowedAppInFront };
}

/**
 * Checks the device and repairs the lock if it was lost.
 * @param {string} serial
 * @returns {Promise<boolean>} true when a repair was needed
 */
async function enforceRestriction(serial) {
  const state = await readRestrictionState(serial);
  if (state.isIntact) return false;
  await pinAllowedApp(serial);
  return true;
}

module.exports = { isAllowedWhenRestricted, applyRestriction, enforceRestriction, readRestrictionState };
