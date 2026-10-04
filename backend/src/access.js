'use strict';

const crypto = require('node:crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

/**
 * Checks the shared access code a viewer sent. Hashing both sides first gives
 * equal-length inputs for the constant-time comparison.
 * @param {string} expected the configured code; an empty string turns the check off
 * @param {unknown} given what the viewer sent
 * @returns {boolean}
 */
function isAccessCodeValid(expected, given) {
  if (expected === '') return true;
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha256(expected), sha256(given));
}

/**
 * A page on another site must not be able to open our WebSocket from a visitor's browser.
 * Browsers always send Origin on WebSocket requests; tools such as curl send none, and
 * those still need the access code.
 * @param {string | undefined} origin the Origin request header
 * @param {string | undefined} host the Host request header
 * @returns {boolean}
 */
function isOriginAllowed(origin, host) {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

module.exports = { isAccessCodeValid, isOriginAllowed };
