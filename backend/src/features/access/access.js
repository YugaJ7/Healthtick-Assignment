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

/**
 * The visitor's network address, for the per-address session limit. The backend only
 * listens on this machine; visitors arrive through the web server, which writes their
 * address at the end of X-Forwarded-For. A request without that header was made on the
 * server itself (tests, administration) and has no visitor address.
 * @param {unknown} forwardedFor the X-Forwarded-For request header
 * @returns {string | null}
 */
function visitorAddress(forwardedFor) {
  if (typeof forwardedFor !== 'string') return null;
  const last = forwardedFor.split(',').pop().trim();
  return last === '' ? null : last;
}

/**
 * Reads the path and query of a request. Some request targets are not addresses at all
 * (a bare "//", for one); those give null instead of an exception, so one odd request
 * cannot bring the server down.
 * @param {string | undefined} target the request line's target (req.url)
 * @returns {URL | null}
 */
function parseTarget(target) {
  try {
    return new URL(target ?? '', 'http://localhost');
  } catch {
    return null;
  }
}

const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * Response headers for the page and its scripts. The policy allows scripts, styles and
 * connections from this site only: no inline script, no other origin.
 * @param {string | undefined} host the Host request header
 * @returns {Record<string, string>}
 */
function securityHeaders(host) {
  // Not every browser lets 'self' cover the WebSocket address, so it is named as well.
  const socket = typeof host === 'string' && HOST_PATTERN.test(host) ? ` wss://${host} ws://${host}` : '';
  const policy = [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "media-src 'self'",
    `connect-src 'self'${socket}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': policy,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

module.exports = { isAccessCodeValid, isOriginAllowed, visitorAddress, securityHeaders, parseTarget };
