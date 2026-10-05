import { recordingUrl, fetchRecordingInfo } from './recordingsPanel.mjs';

// After a session ends, its recording takes the device's place. The file is complete a
// moment after the session ends; until the server says so, the player stays hidden.

const POLL_MS = 700;
const POLL_TRIES = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {HTMLVideoElement} options.video
 * @param {HTMLAnchorElement} options.downloadLink
 * @param {HTMLElement} options.note a line of text over the stage
 * @param {() => boolean} options.isEnded whether the page is still showing an ended session
 */
export function createEndedView({ video, downloadLink, note, isEnded }) {
  let shownToken = null; // the session whose recording is, or is about to be, on show

  /** @param {string | null} token the ended session's token; null when it was never known */
  async function show(token) {
    shownToken = token;
    note.textContent = 'Preparing recording…';
    downloadLink.setAttribute('aria-disabled', 'true');
    downloadLink.removeAttribute('href');
    const isStillWanted = () => isEnded() && shownToken === token;
    for (let attempt = 0; attempt < POLL_TRIES && token; attempt += 1) {
      let info = null;
      try {
        info = await fetchRecordingInfo(token);
      } catch {
        // A failed request is tried again like a recording that is not ready.
      }
      if (!isStillWanted()) return; // a new session has started meanwhile
      if (info && info.isComplete) {
        note.textContent = '';
        video.src = recordingUrl(token, false);
        video.hidden = false;
        // Starts by itself where the browser allows it; the controls are there otherwise.
        video.muted = true;
        video.play().catch(() => {});
        downloadLink.href = recordingUrl(token, true);
        downloadLink.removeAttribute('aria-disabled');
        return;
      }
      await sleep(POLL_MS);
    }
    if (isStillWanted()) note.textContent = 'This session has no recording.';
  }

  function clear() {
    shownToken = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
  }

  return { show, clear };
}
