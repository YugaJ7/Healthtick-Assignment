// The visitor's recordings. The server keeps no list per visitor: this browser remembers
// the secret token of each session it started, and a token opens exactly one recording.
// After a session has ended its token controls nothing; it only opens that recording.

const RECORDINGS_KEY = 'recordings';
const MAX_LISTED_RECORDINGS = 10;
const RECORDING_KEEP_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * @param {string} token
 * @param {boolean} isDownload
 * @returns {string}
 */
export function recordingUrl(token, isDownload) {
  const query = new URLSearchParams({ session: token });
  if (isDownload) query.set('download', '1');
  return `/recording?${query}`;
}

// localStorage can be unavailable or hold anything; a bad value is treated as empty.
function loadTokens() {
  try {
    const list = JSON.parse(localStorage.getItem(RECORDINGS_KEY) || '[]');
    return list.filter((entry) => TOKEN_PATTERN.test(entry.token) && Date.now() - entry.startedAt < RECORDING_KEEP_MS);
  } catch {
    return [];
  }
}

/** Remembers a session of this browser so its recording can be found later. */
export function rememberRecording(token) {
  const list = loadTokens();
  if (list.some((entry) => entry.token === token)) return;
  const updated = [{ token, startedAt: Date.now() }, ...list].slice(0, MAX_LISTED_RECORDINGS);
  try {
    localStorage.setItem(RECORDINGS_KEY, JSON.stringify(updated));
  } catch {
    // Storage is blocked: the recording still exists, it is only not listed here.
  }
}

/**
 * Asks the server about one recording.
 * @param {string} token
 * @returns {Promise<{ id: string, startedAt: number, mode: string | null, durationMs: number | null, isComplete: boolean } | null>}
 *   null when the server has no recording for this token
 */
export async function fetchRecordingInfo(token) {
  const response = await fetch(`/recording/info?${new URLSearchParams({ session: token })}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  return response.json();
}

/**
 * @param {number | null} durationMs null while the session runs, or when it was cut off
 * @param {boolean} isComplete
 */
export function formatDuration(durationMs, isComplete) {
  if (durationMs === null) return isComplete ? 'length not recorded' : 'in progress';
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(token, info, player) {
  const item = element('li');
  item.append(element('strong', new Date(info.startedAt).toLocaleString()));
  item.append(element('span', `${formatDuration(info.durationMs, info.isComplete)} · session ${info.id}`));
  const actions = element('span');
  const play = element('button', 'Play');
  play.type = 'button';
  play.disabled = !info.isComplete;
  play.addEventListener('click', () => {
    player.src = recordingUrl(token, false);
    player.hidden = false;
    player.play().catch(() => {}); // the visitor can press play themselves
  });
  const download = element('a', 'Download');
  if (info.isComplete) download.href = recordingUrl(token, true);
  else download.setAttribute('aria-disabled', 'true');
  actions.append(play, download);
  item.append(actions);
  return item;
}

/**
 * Fills the list with this browser's recordings that the server still has.
 * @param {HTMLElement} list
 * @param {HTMLVideoElement} player plays the chosen recording
 */
export async function renderRecordingList(list, player) {
  list.replaceChildren(element('li', 'Loading'));
  const tokens = loadTokens();
  const results = await Promise.all(tokens.map((entry) => fetchRecordingInfo(entry.token).catch(() => null)));
  const rows = tokens.flatMap((entry, index) => (results[index] ? [row(entry.token, results[index], player)] : []));
  list.replaceChildren(...(rows.length > 0 ? rows : [element('li', 'No recordings yet. Each session is recorded and kept for 24 hours.')]));
}
