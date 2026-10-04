'use strict';

const crypto = require('node:crypto');

// Keeps track of who has which device. One session = one device, created when the
// session opens and removed when it ends. A session ends when the user asks, when no
// viewer has been attached for `graceMs` (tab closed, connection lost), or when there
// has been no input for `idleMs`.

const TOKEN_BYTES = 16;
const ID_LENGTH = 8;

class BusyError extends Error {}

/**
 * @param {object} options
 * @param {(id: string) => Promise<object>} options.createDevice
 * @param {(device: object) => Promise<void>} options.removeDevice
 * @param {number} options.maxSessions
 * @param {number} options.graceMs
 * @param {number} options.idleMs
 * @param {(message: string) => void} options.log
 */
function createSessionManager({ createDevice, removeDevice, maxSessions, graceMs, idleMs, log }) {
  const sessions = new Map(); // token -> session

  function end(session, reason) {
    if (session.isEnded) return;
    session.isEnded = true;
    clearTimeout(session.graceTimer);
    clearTimeout(session.idleTimer);
    sessions.delete(session.token);
    log(`session ${session.id} ended: ${reason}`);
    if (session.onEnd) session.onEnd(reason);
    // The device may still be booting; remove it once that settles either way.
    session.ready.then((device) => removeDevice(device), () => {});
  }

  function restartIdleTimer(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => end(session, 'idle'), idleMs);
  }

  function create() {
    if (sessions.size >= maxSessions) throw new BusyError('all devices are in use');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    // The id appears in logs and container names; the token is the secret and never does.
    const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, ID_LENGTH);
    const session = { token, id, isEnded: false, isAttached: false, onEnd: null, graceTimer: null, idleTimer: null, ready: null };
    session.ready = createDevice(id);
    session.ready.catch((err) => end(session, `device failed: ${err.message}`));
    sessions.set(token, session);
    restartIdleTimer(session);
    log(`session ${id} created (${sessions.size}/${maxSessions})`);
    return session;
  }

  /**
   * Attaches a viewer. A known token resumes that session; anything else starts a new one.
   * @param {string | null} token
   * @param {(reason: string) => void} onEnd called once if the session ends while attached
   * @throws {BusyError} when a new session is needed and none is free
   */
  function attach(token, onEnd) {
    const existing = token ? sessions.get(token) : undefined;
    const session = existing ?? create();
    // A second viewer with the same token replaces the first.
    if (session.isAttached && session.onEnd) session.onEnd('opened in another window');
    clearTimeout(session.graceTimer);
    session.isAttached = true;
    session.onEnd = onEnd;
    return session;
  }

  /** The viewer went away. The device is kept for `graceMs` in case it comes back. */
  function detach(session, onEnd) {
    if (session.isEnded || session.onEnd !== onEnd) return;
    session.isAttached = false;
    session.onEnd = null;
    session.graceTimer = setTimeout(() => end(session, 'viewer left'), graceMs);
  }

  /** Call on every input from the user; it postpones the idle timeout. */
  function touch(session) {
    if (!session.isEnded) restartIdleTimer(session);
  }

  function endAll(reason) {
    for (const session of [...sessions.values()]) end(session, reason);
  }

  return { attach, detach, touch, end, endAll, count: () => sessions.size };
}

module.exports = { createSessionManager, BusyError };
