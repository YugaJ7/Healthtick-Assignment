// The WebSocket to the server, and the two things this tab remembers between
// connections: its session token and, where the site uses one, the access code.

/** Close codes the server uses; the page reacts to each. */
export const CLOSE = Object.freeze({
  TRY_AGAIN: 1013,
  BAD_CODE: 4401,
  SESSION_ENDED: 4410,
  BUSY: 4429,
  ADDRESS_LIMIT: 4430,
});

const ACCESS_CODE_KEY = 'accessCode';
const SESSION_TOKEN_KEY = 'sessionToken';

/** Identifies this tab's device session, so a reload or a short network drop resumes the same device. */
export const sessionToken = Object.freeze({
  get: () => sessionStorage.getItem(SESSION_TOKEN_KEY),
  set: (token) => sessionStorage.setItem(SESSION_TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(SESSION_TOKEN_KEY),
});

/**
 * The access code arrives in the link as "#code=..." (the part after # is never sent to
 * the server in the page request) or is typed into the form. It is kept for this tab only.
 */
export const accessCode = Object.freeze({
  read() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get('code');
    if (fromLink) {
      sessionStorage.setItem(ACCESS_CODE_KEY, fromLink);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(ACCESS_CODE_KEY) || '';
  },
  store: (code) => sessionStorage.setItem(ACCESS_CODE_KEY, code),
  clear: () => sessionStorage.removeItem(ACCESS_CODE_KEY),
});

/**
 * @param {object} handlers
 * @param {(buffer: ArrayBuffer) => void} handlers.onPacket a binary message (video)
 * @param {(message: object) => void} handlers.onMessage a JSON message
 * @param {(event: CloseEvent) => void} handlers.onClose
 * @param {(reason: string) => void} handlers.onFault a message could not be handled
 */
export function createConnection({ onPacket, onMessage, onClose, onFault }) {
  let socket = null;

  /**
   * @param {object} options
   * @param {boolean} options.isResumeOnly true once a device has been shown: only that same
   *   session will do, and the server says so if it is gone
   */
  function connect({ isResumeOnly }) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ code: accessCode.read() });
    // Without a mode in the link the server gives its default (the Clock app only).
    const mode = new URLSearchParams(location.search).get('mode');
    if (mode) query.set('mode', mode);
    const token = sessionToken.get();
    if (token) query.set('session', token);
    if (isResumeOnly) query.set('resume', 'only');
    socket = new WebSocket(`${scheme}://${location.host}/stream?${query}`);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data === 'string') onMessage(JSON.parse(event.data));
        else onPacket(event.data);
      } catch (err) {
        onFault(err.message);
      }
    });
    socket.addEventListener('close', onClose);
  }

  const isOpen = () => socket !== null && socket.readyState === WebSocket.OPEN;

  /** @returns {boolean} false when there was no open connection to send on */
  function send(message) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function close() {
    if (socket) socket.close();
  }

  return { connect, send, close, isOpen };
}
