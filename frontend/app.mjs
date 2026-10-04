import { codecStringFromConfig, concatBytes } from './h264.mjs';
import { attachInput, attachSoftKeyboard } from './input.mjs';
import { createLatencyProbe, summarize } from './latency.mjs';
import { INITIAL_STATE, nextState } from './state.mjs';
import { renderLatencyReport } from './latencyPanel.mjs';
import { rememberRecording, recordingUrl, fetchRecordingInfo, renderRecordingList } from './recordingsPanel.mjs';

const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const STATS_INTERVAL_MS = 1000;
const WS_CLOSE_BAD_CODE = 4401;
const WS_CLOSE_TRY_AGAIN = 1013;
const WS_CLOSE_SESSION_ENDED = 4410;
const WS_CLOSE_BUSY = 4429;
const WS_CLOSE_ADDRESS_LIMIT = 4430;
const BUSY_RETRY_MS = 5000;
const ACCESS_CODE_KEY = 'accessCode';
// Identifies this tab's device session, so a reload or a short network drop resumes the same device.
const SESSION_TOKEN_KEY = 'sessionToken';
const MAX_TRACKED_FRAMES = 120;
const LATENCY_TRIALS = 40;
const ROUND_TRIP_PINGS = 10;
const PING_TIMEOUT_MS = 2000;
// The probe uses the first touch slot: a Clock-only session accepts no other.
const PROBE_POINTER_ID = 0;
const LOADING_TIMEOUT_MS = 120_000; // no new stage for this long means the start has failed
const ENDING_TIMEOUT_MS = 15_000;
const REVEAL_MS = 400; // "100%" stays visible this long before the live view fades in
const NOTICE_MS = 6000;
const RECORDING_POLL_MS = 700;
const RECORDING_POLL_TRIES = 30;
const NARROW_WINDOW_PX = 760; // matches the media query in style.css
const SIDE_PX = 220;
const SIDE_WITH_PANEL_PX = 356;
const MIN_STAGE_PX = 120;

const byId = (id) => document.getElementById(id);
const canvas = byId('screen');
const context = canvas.getContext('2d');
const percentEl = byId('percent');
const barEl = byId('bar');
const barFill = byId('bar-fill');
const loadingStatus = byId('loading-status');
const errorText = byId('error-text');
const codeForm = byId('code-form');
const codeInput = byId('code-input');
const statsEl = byId('stats');
const modeLabel = byId('mode-label');
const primaryButton = byId('primary');
const latencyButton = byId('latency-run');
const downloadLink = byId('download');
const noticeEl = byId('notice');
const stageNote = byId('stage-note');
const recordingVideo = byId('recording');
const latencyPanel = byId('latency-panel');
const latencyBody = byId('latency-body');
const recordingsDrawer = byId('recordings');
const recordingsOpen = byId('recordings-open');
const stage = byId('stage');
const keyboardField = byId('keyboard');
const keyboardButton = byId('keyboard-open');

let state = INITIAL_STATE;
let socket = null;
let decoder = null;
let configBytes = null; // SPS/PPS, sent in front of the next key frame
let isWaitingForKeyFrame = true;
let latestFrame = null; // only used by the ?draw=raf comparison path
let reconnectDelayMs = RECONNECT_MIN_MS;
let framesDrawn = 0;
let lastPastedText = null;
let progressPercent = 0;
let loadingTimer = null;
let endingTimer = null;
let noticeTimer = null;
let retryTimer = null;
let endedToken = null; // the session whose recording the ended view shows
const shouldDrawOnAnimationFrame = new URLSearchParams(location.search).get('draw') === 'raf';
const input = attachInput(canvas, (message) => sendMessage(message));
const frameArrivals = new Map(); // frame timestamp -> when its data reached this page
const pendingPings = new Map(); // ping id -> function that settles it
const probe = createLatencyProbe({ canvas, context, send: (message) => sendMessage(message), pointerId: PROBE_POINTER_ID });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (state === 'live' && socket && socket.readyState === WebSocket.OPEN) stageNote.textContent = '';
  if (!isEnded) statsEl.hidden = false;
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

function setProgress(percent, label) {
  // A reconnect replays earlier stages; the number never goes backwards within one start.
  progressPercent = Math.max(progressPercent, percent);
  percentEl.textContent = `${progressPercent}%`;
  barFill.style.width = `${progressPercent}%`;
  barEl.setAttribute('aria-valuenow', String(progressPercent));
  if (label) loadingStatus.textContent = label;
  clearTimeout(loadingTimer);
  if (state === 'loading') loadingTimer = setTimeout(() => fail('The device did not start in time.'), LOADING_TIMEOUT_MS);
}

function resetProgress() {
  progressPercent = 0;
  setProgress(0, 'Connecting');
}

function fail(message) {
  clearTimeout(loadingTimer);
  clearTimeout(endingTimer);
  clearTimeout(retryTimer);
  errorText.textContent = message;
  dispatch('failed');
  // Whatever was half-started is given up; Retry begins a new session.
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  if (socket) socket.close();
}

function notice(text) {
  noticeEl.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.textContent = ''; }, NOTICE_MS);
}

// ---------------------------------------------------------------- video

function drawFrame(frame) {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    fitStage();
  }
  context.drawImage(frame, 0, 0);
  const arrivedAt = frameArrivals.get(frame.timestamp);
  frameArrivals.delete(frame.timestamp);
  frame.close();
  framesDrawn += 1;
  probe.onFrameDrawn(arrivedAt);
}

// Older drawing path, kept only to compare latency (open the page with ?draw=raf):
// the newest frame waits for the browser's next animation frame.
function drawLatestFrame() {
  if (latestFrame) {
    const frame = latestFrame;
    latestFrame = null;
    drawFrame(frame);
  }
  requestAnimationFrame(drawLatestFrame);
}

// The first decoded frame is the last step of loading: 100 %, then the live view.
function onFirstFrameOfLoading() {
  setProgress(100, 'Live');
  clearTimeout(loadingTimer);
  setTimeout(() => dispatch('firstFrame'), REVEAL_MS);
}

// By default a frame is drawn the moment it is decoded. Waiting for the next animation
// frame adds up to one screen refresh of delay, and browsers slow animation frames to
// about one per second in a window that is not in front.
function onDecodedFrame(frame) {
  if (state === 'loading' && progressPercent < 100) onFirstFrameOfLoading();
  if (state === 'live' || state === 'latency') stageNote.textContent = '';
  if (!shouldDrawOnAnimationFrame) return drawFrame(frame);
  if (latestFrame) latestFrame.close();
  latestFrame = frame;
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  configBytes = null;
  isWaitingForKeyFrame = true;
}

function configureDecoder(bytes) {
  const codec = codecStringFromConfig(bytes);
  if (!codec) throw new Error('config packet without an SPS');
  closeDecoder();
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error: (err) => restartStream(`decoder error: ${err.message}`),
  });
  // No `description` means the decoder expects Annex B data, which is what we receive.
  decoder.configure({ codec, optimizeForLatency: true });
  configBytes = bytes;
}

function handlePacket(buffer) {
  const view = new DataView(buffer);
  const flags = view.getUint8(0);
  const ptsUs = Number(view.getBigUint64(1));
  const payload = new Uint8Array(buffer, PACKET_HEADER_BYTES);

  if (flags & FLAG_CONFIG) return configureDecoder(payload.slice());
  if (!decoder) return;

  const isKeyFrame = (flags & FLAG_KEY_FRAME) !== 0;
  if (isWaitingForKeyFrame && !isKeyFrame) return;
  isWaitingForKeyFrame = false;

  frameArrivals.set(ptsUs, performance.now());
  if (frameArrivals.size > MAX_TRACKED_FRAMES) frameArrivals.delete(frameArrivals.keys().next().value);
  decoder.decode(new EncodedVideoChunk({
    type: isKeyFrame ? 'key' : 'delta',
    timestamp: ptsUs,
    data: isKeyFrame ? concatBytes(configBytes, payload) : payload,
  }));
}

// ---------------------------------------------------------------- messages from the server

function handleDeviceState(message) {
  if (message.token) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, message.token);
    rememberRecording(message.token);
  }
  // The server decides the kind of session; this is display only.
  if (message.mode) modeLabel.textContent = message.mode === 'restricted' ? 'Clock app only' : 'Full device';
}

// Text copied on the device goes straight to this computer's clipboard. Browsers allow
// that only on HTTPS and only for the page in front, so the outcome is always said.
async function receiveDeviceClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    notice('Copied from the device to this computer.');
  } catch {
    notice('The device copied some text, but this browser blocked putting it on your clipboard. Click the screen and press Ctrl+C again.');
  }
}

function handleMessage(event) {
  try {
    if (typeof event.data !== 'string') return handlePacket(event.data);
    const message = JSON.parse(event.data);
    if (message.type === 'codec' && message.codec !== 'h264') throw new Error(`unsupported codec ${message.codec}`);
    if (message.type === 'device') handleDeviceState(message);
    if (message.type === 'progress' && state === 'loading' && progressPercent < 100) setProgress(message.percent, message.label);
    // The device also reports the text we just pasted into it; that is not a device copy.
    if (message.type === 'clipboard' && message.text !== lastPastedText) receiveDeviceClipboard(message.text);
    if (message.type === 'pong' && pendingPings.has(message.id)) pendingPings.get(message.id)();
  } catch (err) {
    restartStream(err.message);
  }
}

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (message.t === 'paste') {
    lastPastedText = message.text;
    notice('Pasted into the device.');
  }
  socket.send(JSON.stringify(message));
}

// ---------------------------------------------------------------- connection

// Drops the connection; the close handler then reconnects to the same session.
function restartStream(reason) {
  stageNote.textContent = `Reconnecting (${reason})`;
  if (socket) socket.close();
}

// The access code arrives in the link as "#code=..." (the part after # is never sent
// to the server in the page request) or is typed into the form. It is kept for this tab only.
function readAccessCode() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('code');
  if (fromLink) {
    sessionStorage.setItem(ACCESS_CODE_KEY, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem(ACCESS_CODE_KEY) || '';
}

function askForAccessCode() {
  sessionStorage.removeItem(ACCESS_CODE_KEY);
  fail('This site needs an access code.');
  codeForm.hidden = false;
  codeInput.focus();
}

// The server has ended the session: asked for, idle, or gone while this page was away.
function onSessionEnded(reason) {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  clearTimeout(endingTimer);
  if (state === 'loading') return fail(`The session could not start: ${reason || 'no reason given'}.`);
  if (!dispatch('sessionEnded')) return;
  statsEl.textContent = `Session ended: ${reason || 'no reason given'}`;
  showRecordingOf(token);
}

function retryLater(message) {
  if (state === 'loading') loadingStatus.textContent = message;
  else stageNote.textContent = message;
  retryTimer = setTimeout(connect, BUSY_RETRY_MS);
}

function handleClose(event) {
  closeDecoder();
  input.reset();
  if (state === 'error' || state === 'ended') return;
  if (event.code === WS_CLOSE_BAD_CODE) return askForAccessCode();
  if (event.code === WS_CLOSE_SESSION_ENDED) return onSessionEnded(event.reason);
  if (event.code === WS_CLOSE_BUSY) return retryLater('All devices are in use. This page tries again every few seconds.');
  if (event.code === WS_CLOSE_ADDRESS_LIMIT) return retryLater('Your network address already has the most devices allowed at once. End one of them; this page tries again every few seconds.');
  const reason = event.code === WS_CLOSE_TRY_AGAIN && event.reason ? event.reason : 'connection lost';
  if (state === 'loading') loadingStatus.textContent = `Reconnecting (${reason})`;
  else stageNote.textContent = `Reconnecting (${reason})`;
  retryTimer = setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = new URLSearchParams({ code: readAccessCode() });
  // Without a mode in the link the server gives its default (the Clock app only).
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode) query.set('mode', mode);
  const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (sessionToken) query.set('session', sessionToken);
  // Past the loading screen, only the same device will do; a lost session ends the visit.
  if (state !== 'loading') query.set('resume', 'only');
  socket = new WebSocket(`${scheme}://${location.host}/stream?${query}`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', handleMessage);
  socket.addEventListener('close', handleClose);
}

// ---------------------------------------------------------------- ending and the recording

function endSession() {
  if (!dispatch('endRequested')) return;
  sendMessage({ t: 'end' });
  endingTimer = setTimeout(() => fail('The server did not confirm that the session ended.'), ENDING_TIMEOUT_MS);
}

// The recording takes the device's place. The file is complete a moment after the
// session ends; until the server says so, the player stays hidden.
async function showRecordingOf(token) {
  endedToken = token;
  stageNote.textContent = 'Preparing recording…';
  downloadLink.setAttribute('aria-disabled', 'true');
  downloadLink.removeAttribute('href');
  for (let attempt = 0; attempt < RECORDING_POLL_TRIES && token; attempt += 1) {
    let info = null;
    try {
      info = await fetchRecordingInfo(token);
    } catch {
      // A failed request is tried again like a recording that is not ready.
    }
    if (state !== 'ended' || endedToken !== token) return; // a new session has started meanwhile
    if (info && info.isComplete) {
      stageNote.textContent = '';
      recordingVideo.src = recordingUrl(token, false);
      recordingVideo.hidden = false;
      // Starts by itself where the browser allows it; the controls are there otherwise.
      recordingVideo.muted = true;
      recordingVideo.play().catch(() => {});
      downloadLink.href = recordingUrl(token, true);
      downloadLink.removeAttribute('aria-disabled');
      return;
    }
    await sleep(RECORDING_POLL_MS);
  }
  if (state === 'ended' && endedToken === token) stageNote.textContent = 'This session has no recording.';
}

function startNewSession() {
  clearTimeout(retryTimer);
  endedToken = null;
  recordingVideo.pause();
  recordingVideo.removeAttribute('src');
  recordingVideo.load();
  recordingVideo.hidden = true;
  stageNote.textContent = '';
  statsEl.textContent = '';
  codeForm.hidden = true;
  closeLatencyPanel();
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!dispatch('restart')) return;
  resetProgress();
  connect();
}

// ---------------------------------------------------------------- latency check

function pingOnce(id) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      pendingPings.delete(id);
      resolve(null);
    }, PING_TIMEOUT_MS);
    pendingPings.set(id, () => {
      clearTimeout(timer);
      pendingPings.delete(id);
      resolve(performance.now() - startedAt);
    });
    sendMessage({ t: 'ping', id });
  });
}

function closeLatencyPanel() {
  latencyPanel.hidden = true;
  fitStage();
}

async function runLatencyCheck() {
  if (!dispatch('latencyStart')) return null;
  const showCount = (done) => { latencyButton.textContent = `Running… ${done}/${LATENCY_TRIALS}`; };
  latencyButton.classList.add('running');
  showCount(0);
  const isAbandoned = () => state !== 'latency';
  const roundTrips = [];
  for (let id = 1; id <= ROUND_TRIP_PINGS && !isAbandoned(); id += 1) {
    const ms = await pingOnce(id);
    if (ms !== null) roundTrips.push(ms);
  }
  const result = await probe.run(LATENCY_TRIALS, showCount, isAbandoned);
  const report = {
    when: new Date().toISOString(),
    total: result.total,
    browser: result.browser,
    roundTrip: summarize(roundTrips),
    timeouts: result.timeouts,
    samplesMs: result.samplesMs,
    video: `${canvas.width}x${canvas.height}`,
  };
  // If the session ended during the check there is nothing meaningful to show.
  if (!dispatch('latencyDone')) return report;
  renderLatencyReport(latencyBody, report);
  latencyPanel.hidden = false;
  fitStage();
  canvas.focus();
  return report;
}

// ---------------------------------------------------------------- start

function toggleRecordings(isOpen) {
  recordingsDrawer.hidden = !isOpen;
  recordingsOpen.setAttribute('aria-expanded', String(isOpen));
  const player = byId('recordings-player');
  if (isOpen) return renderRecordingList(byId('recording-list'), player);
  player.pause();
  player.hidden = true;
  return null;
}

function start() {
  document.body.dataset.state = state;
  render();
  if (!('VideoDecoder' in window)) {
    return fail('This browser cannot decode the stream (WebCodecs is missing). Use a current Chrome, Edge, Firefox or Safari over HTTPS or localhost.');
  }
  setInterval(() => {
    if (state === 'live' || state === 'latency') statsEl.textContent = `${framesDrawn} frames/s, ${canvas.width}x${canvas.height}`;
    // A second with drawn frames means the stream is healthy, so the next retry can be quick.
    if (framesDrawn > 0) reconnectDelayMs = RECONNECT_MIN_MS;
    framesDrawn = 0;
  }, STATS_INTERVAL_MS);
  if (shouldDrawOnAnimationFrame) requestAnimationFrame(drawLatestFrame);
  window.addEventListener('resize', fitStage);
  attachSoftKeyboard(keyboardField, (message) => sendMessage(message));
  // Focusing the invisible field inside the tap is what makes a phone show its keyboard.
  keyboardButton.addEventListener('click', () => keyboardField.focus());
  primaryButton.addEventListener('click', () => (state === 'ended' ? startNewSession() : endSession()));
  latencyButton.addEventListener('click', runLatencyCheck);
  byId('latency-close').addEventListener('click', closeLatencyPanel);
  byId('retry').addEventListener('click', startNewSession);
  recordingsOpen.addEventListener('click', () => toggleRecordings(recordingsDrawer.hidden));
  byId('recordings-close').addEventListener('click', () => toggleRecordings(false));
  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sessionStorage.setItem(ACCESS_CODE_KEY, codeInput.value.trim());
    codeInput.value = '';
    startNewSession();
  });
  resetProgress();
  connect();
}

start();
