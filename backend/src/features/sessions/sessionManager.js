'use strict';

const crypto = require('node:crypto');

// Keeps track of who has which device. One session = one device, created when the
// session opens and removed when it ends. A session ends when the user asks, when no
// viewer has been attached for `graceMs` (tab closed, connection lost), or when there
// has been no input for `idleMs`.

const TOKEN_BYTES = 16;
const ID_LENGTH = 8;

/** The public id of a session: a hash of its secret token. Used in logs and names. */
const sessionIdOf = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, ID_LENGTH);

class BusyError extends Error {}
class LimitError extends Error {}

/**
 * @param {object} options
 * @param {(id: string, mode: string, onStage: (stage: string) => void) => Promise<object>} options.createDevice
 * @param {(device: object) => Promise<void>} options.removeDevice
 * @param {number} options.maxSessions
 * @param {number} [options.maxPerOwner] most sessions one owner (visitor address) may hold
 * @param {number} options.graceMs
 * @param {number} options.idleMs
 * @param {(message: string) => void} options.log
 * @param {(session: object) => void} [options.onEnded] called once when a session has ended
 */
function createSessionManager({ createDevice, removeDevice, maxSessions, maxPerOwner = Infinity, graceMs, idleMs, log, onEnded = () => {} }) {
  const sessions = new Map(); // token -> session

  function end(session, reason) {
    if (session.isEnded) return;
    session.isEnded = true;
    clearTimeout(session.graceTimer);
    clearTimeout(session.idleTimer);
    sessions.delete(session.token);
    log(`session ${session.id} ended: ${reason}`);
    if (session.onEnd) session.onEnd(reason);
    onEnded(session);
    // The device may still be booting; remove it once that settles either way.
    session.ready.then((device) => removeDevice(device), () => {});
  }

  function restartIdleTimer(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => end(session, 'idle'), idleMs);
  }

  function create(mode, owner) {
    if (owner !== null) {
      const owned = [...sessions.values()].filter((session) => session.owner === owner).length;
      if (owned >= maxPerOwner) throw new LimitError('this address already has the most devices allowed');
    }
    if (sessions.size >= maxSessions) throw new BusyError('all devices are in use');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    // The id appears in logs and container names; the token is the secret and never does.
    const id = sessionIdOf(token);
    const session = { token, id, mode, owner, isEnded: false, isAttached: false, onEnd: null, graceTimer: null, idleTimer: null, ready: null, stage: 'requested', onStage: null };
    // The newest stage is kept, so a viewer that attaches later still learns where things are.
    session.ready = createDevice(id, mode, (stage) => {
      session.stage = stage;
      if (session.onStage) session.onStage(stage);
    });
    // The detail goes to the log; the visitor gets a plain reason.
    session.ready.catch((err) => {
      log(`session ${id} device failed: ${err.message}`);
      end(session, 'the device could not be started');
    });
    sessions.set(token, session);
    restartIdleTimer(session);
    log(`session ${id} created, ${mode} (${sessions.size}/${maxSessions})`);
    return session;
  }

  /**
   * Attaches a viewer. A known token resumes that session; anything else starts a new one.
   * @param {string | null} token
   * @param {(reason: string) => void} onEnd called once if the session ends while attached
   * @param {'full' | 'restricted'} mode used only when a new session is created; an
   *   existing session keeps the mode it was created with
   * @param {string | null} owner who a new session counts against (the visitor's address);
   *   null means not counted
   * @throws {BusyError} when a new session is needed and none is free
   * @throws {LimitError} when the owner already holds `maxPerOwner` sessions
   */
  function attach(token, onEnd, mode = 'full', owner = null) {
    const existing = token ? sessions.get(token) : undefined;
    const session = existing ?? create(mode, owner);
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

  return { attach, detach, touch, end, endAll, count: () => sessions.size, has: (token) => sessions.has(token) };
}

module.exports = { createSessionManager, sessionIdOf, BusyError, LimitError };
