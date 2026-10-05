// Wires the page's features together: the state machine decides what the page shows, and
// each feature (stream, input, session, latency, recordings) does its own part.

import { attachInput, attachSoftKeyboard } from './features/input/input.mjs';
import { copyToThisComputer } from './features/input/clipboard.mjs';
import { createPlayer } from './features/stream/player.mjs';
import { INITIAL_STATE, nextState } from './features/session/state.mjs';
import { CLOSE, accessCode, sessionToken, createConnection } from './features/session/connection.mjs';
import { createLoadingScreen } from './features/session/loadingScreen.mjs';
import { createLatencyCheck } from './features/latency/latencyCheck.mjs';
import { rememberRecording, renderRecordingList } from './features/recordings/recordingsPanel.mjs';
import { createEndedView } from './features/recordings/endedView.mjs';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const BUSY_RETRY_MS = 5000;
const STATS_INTERVAL_MS = 1000;
const ENDING_TIMEOUT_MS = 15_000;
const REVEAL_MS = 400; // "100%" stays visible this long before the live view fades in
const NOTICE_MS = 6000;
const NARROW_WINDOW_PX = 760; // matches the media query in style.css
const SIDE_PX = 220;
const SIDE_WITH_PANEL_PX = 356;
const MIN_STAGE_PX = 120;

const byId = (id) => document.getElementById(id);
const canvas = byId('screen');
const context = canvas.getContext('2d');
const stage = byId('stage');
const stageNote = byId('stage-note');
const statsEl = byId('stats');
const modeLabel = byId('mode-label');
const noticeEl = byId('notice');
const primaryButton = byId('primary');
const latencyButton = byId('latency-run');
const latencyPanel = byId('latency-panel');
const recordingVideo = byId('recording');
const recordingsDrawer = byId('recordings');
const recordingsOpen = byId('recordings-open');
const keyboardField = byId('keyboard');
const keyboardButton = byId('keyboard-open');

let state = INITIAL_STATE;
let reconnectDelayMs = RECONNECT_MIN_MS;
let lastPastedText = null;
let endingTimer = null;
let noticeTimer = null;
let retryTimer = null;

const connection = createConnection({ onPacket: (buffer) => player.handlePacket(buffer), onMessage: handleMessage, onClose: handleClose, onFault: restartStream });
const input = attachInput(canvas, sendMessage);
const loading = createLoadingScreen({
  isLoading: () => state === 'loading',
  onTimeout: () => fail('The device did not start in time.'),
  onCodeSubmitted: (code) => {
    accessCode.store(code);
    startNewSession();
  },
});
const latency = createLatencyCheck({ canvas, context, send: sendMessage, button: latencyButton, panel: latencyPanel, body: byId('latency-body') });
const player = createPlayer({
  canvas,
  context,
  shouldDrawOnAnimationFrame: new URLSearchParams(location.search).get('draw') === 'raf',
  onDecoded: handleDecodedFrame,
  onDrawn: latency.onFrameDrawn,
  onSizeChange: fitStage,
  onError: restartStream,
});
const endedView = createEndedView({ video: recordingVideo, downloadLink: byId('download'), note: stageNote, isEnded: () => state === 'ended' });

// ---------------------------------------------------------------- state and layout

// Applies an event to the state machine (state.mjs). Returns whether the state changed.
function dispatch(event) {
  const to = nextState(state, event);
  if (to === state) return false;
  state = to;
  document.body.dataset.state = state;
  render();
  return true;
}

function render() {
  const isEnded = state === 'ended';
  primaryButton.textContent = isEnded ? 'Start a new session' : state === 'ending' ? 'Ending session…' : 'End session';
  primaryButton.className = isEnded ? 'go' : 'danger';
  primaryButton.disabled = state !== 'live' && !isEnded;
  latencyButton.disabled = state !== 'live';
  keyboardButton.disabled = state !== 'live';
  if (state !== 'latency') {
    latencyButton.textContent = 'Run latency check';
    latencyButton.classList.remove('running');
  }
  if (state === 'ending') stageNote.textContent = 'Ending session…';
  if (state === 'live' && connection.isOpen()) stageNote.textContent = '';
  fitStage();
}

// The device (or its recording) fills the window's height, or its width when that is the
// tighter limit, always in the device's own proportions. Touch positions are computed
// from the canvas's size on screen, so any size set here keeps them exact.
function fitStage() {
  const isNarrow = window.innerWidth <= NARROW_WINDOW_PX;
  const side = latencyPanel.hidden ? SIDE_PX : SIDE_WITH_PANEL_PX;
  // On a phone the stage is the space between the two bars, whatever that comes to;
  // on a wide window it is the full height, less a column on each side.
  const availableWidth = isNarrow ? stage.clientWidth : Math.max(MIN_STAGE_PX, window.innerWidth - 2 * side);
  const availableHeight = isNarrow ? stage.clientHeight : window.innerHeight;
  const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
  const width = `${Math.floor(canvas.width * scale)}px`;
  const height = `${Math.floor(canvas.height * scale)}px`;
  for (const target of [canvas, recordingVideo]) {
    target.style.width = width;
    target.style.height = height;
  }
}

function notice(text) {
  noticeEl.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.textContent = ''; }, NOTICE_MS);
}

function fail(message) {
  clearTimeout(endingTimer);
  clearTimeout(retryTimer);
  loading.showError(message);
  dispatch('failed');
  // Whatever was half-started is given up; Retry begins a new session.
  sessionToken.clear();
  connection.close();
}

// ---------------------------------------------------------------- messages

// The first decoded frame is the last step of loading: 100 %, then the live view.
function handleDecodedFrame() {
  if (state === 'loading' && !loading.isComplete()) {
    loading.set(100, 'Live');
    loading.stopTimer();
    setTimeout(() => dispatch('firstFrame'), REVEAL_MS);
  }
  if (state === 'live' || state === 'latency') stageNote.textContent = '';
}

function handleMessage(message) {
  if (message.type === 'codec' && message.codec !== 'h264') throw new Error(`unsupported codec ${message.codec}`);
  if (message.type === 'device') {
    if (message.token) {
      sessionToken.set(message.token);
      rememberRecording(message.token);
    }
    // The server decides the kind of session; this is display only.
    if (message.mode) modeLabel.textContent = message.mode === 'restricted' ? 'Clock app only' : 'Full device';
  }
  if (message.type === 'progress' && state === 'loading' && !loading.isComplete()) loading.set(message.percent, message.label);
  // The device also reports the text we just pasted into it; that is not a device copy.
  if (message.type === 'clipboard' && message.text !== lastPastedText) copyToThisComputer(message.text, notice);
  if (message.type === 'pong') latency.onPong(message.id);
}

function sendMessage(message) {
  if (!connection.isOpen()) return;
  if (message.t === 'paste') {
    lastPastedText = message.text;
    notice('Pasted into the device.');
  }
  connection.send(message);
}

// ---------------------------------------------------------------- connection

const connect = () => connection.connect({ isResumeOnly: state !== 'loading' });

// Drops the connection; the close handler then reconnects to the same session.
function restartStream(reason) {
  stageNote.textContent = `Reconnecting (${reason})`;
  connection.close();
}

// Says what is going on in the place the visitor is looking at.
function say(message) {
  if (state === 'loading') loading.status(message);
  else stageNote.textContent = message;
}

// The server has ended the session: asked for, idle, or gone while this page was away.
function handleSessionEnded(reason) {
  const token = sessionToken.get();
  sessionToken.clear();
  clearTimeout(endingTimer);
  if (state === 'loading') return fail(`The session could not start: ${reason || 'no reason given'}.`);
  if (!dispatch('sessionEnded')) return;
  statsEl.textContent = `Session ended: ${reason || 'no reason given'}`;
  endedView.show(token);
}

function handleClose(event) {
  player.close();
  input.reset();
  if (state === 'error' || state === 'ended') return;
  if (event.code === CLOSE.SESSION_ENDED) return handleSessionEnded(event.reason);
  if (event.code === CLOSE.BAD_CODE) {
    accessCode.clear();
    fail('This site needs an access code.');
    return loading.askForCode();
  }
  if (event.code === CLOSE.BUSY || event.code === CLOSE.ADDRESS_LIMIT) {
    say(event.code === CLOSE.BUSY
      ? 'All devices are in use. This page tries again every few seconds.'
      : 'Your network address already has the most devices allowed at once. End one of them; this page tries again every few seconds.');
    retryTimer = setTimeout(connect, BUSY_RETRY_MS);
    return;
  }
  say(`Reconnecting (${event.code === CLOSE.TRY_AGAIN && event.reason ? event.reason : 'connection lost'})`);
  retryTimer = setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

// ---------------------------------------------------------------- what the buttons do

function endSession() {
  if (!dispatch('endRequested')) return;
  sendMessage({ t: 'end' });
  endingTimer = setTimeout(() => fail('The server did not confirm that the session ended.'), ENDING_TIMEOUT_MS);
}

function startNewSession() {
  clearTimeout(retryTimer);
  endedView.clear();
  stageNote.textContent = '';
  statsEl.textContent = '';
  loading.hideCodeForm();
  closeLatencyPanel();
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!dispatch('restart')) return;
  loading.reset();
  connect();
}

function closeLatencyPanel() {
  latency.hide();
  fitStage();
}

async function runLatencyCheck() {
  if (!dispatch('latencyStart')) return;
  const report = await latency.measure(() => state !== 'latency');
  // If the session ended during the check there is nothing meaningful to show.
  if (!dispatch('latencyDone')) return;
  latency.show(report);
  fitStage();
  // The results are what the visitor asked for, so the keyboard focus goes to them.
  byId('latency-close').focus();
}

function toggleRecordings(isOpen) {
  recordingsDrawer.hidden = !isOpen;
  recordingsOpen.setAttribute('aria-expanded', String(isOpen));
  const drawerPlayer = byId('recordings-player');
  if (isOpen) {
    // Focus moves into the panel when it opens and back to its button when it closes.
    byId('recordings-close').focus();
    return renderRecordingList(byId('recording-list'), drawerPlayer);
  }
  drawerPlayer.pause();
  drawerPlayer.hidden = true;
  recordingsOpen.focus();
  return null;
}

// ---------------------------------------------------------------- start

function start() {
  document.body.dataset.state = state;
  render();
  if (!('VideoDecoder' in window)) {
    return fail('This browser cannot decode the stream (WebCodecs is missing). Use a current Chrome, Edge, Firefox or Safari over HTTPS or localhost.');
  }
  setInterval(() => {
    const frames = player.takeFrameCount();
    if (state === 'live' || state === 'latency') statsEl.textContent = `${frames} frames/s, ${canvas.width}x${canvas.height}`;
    // A second with drawn frames means the stream is healthy, so the next retry can be quick.
    if (frames > 0) reconnectDelayMs = RECONNECT_MIN_MS;
  }, STATS_INTERVAL_MS);
  window.addEventListener('resize', fitStage);
  attachSoftKeyboard(keyboardField, sendMessage);
  // Focusing the invisible field inside the tap is what makes a phone show its keyboard.
  keyboardButton.addEventListener('click', () => keyboardField.focus());
  primaryButton.addEventListener('click', () => (state === 'ended' ? startNewSession() : endSession()));
  latencyButton.addEventListener('click', runLatencyCheck);
  const dismissLatencyPanel = () => {
    closeLatencyPanel();
    latencyButton.focus();
  };
  byId('latency-close').addEventListener('click', dismissLatencyPanel);
  // Escape closes whichever panel the keyboard focus is in.
  latencyPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismissLatencyPanel();
  });
  recordingsDrawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleRecordings(false);
  });
  byId('retry').addEventListener('click', startNewSession);
  recordingsOpen.addEventListener('click', () => toggleRecordings(recordingsDrawer.hidden));
  byId('recordings-close').addEventListener('click', () => toggleRecordings(false));
  loading.reset();
  connect();
}

start();
