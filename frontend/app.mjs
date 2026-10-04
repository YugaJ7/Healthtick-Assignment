import { codecStringFromConfig, concatBytes } from './h264.mjs';
import { attachInput } from './input.mjs';
import { createLatencyProbe, summarize } from './latency.mjs';

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
// Identifies this tab's device session, so a short network drop resumes the same device.
const SESSION_TOKEN_KEY = 'sessionToken';
// 'full' is the whole device; 'restricted' is one app only, enforced by the server.
const SESSION_MODE_KEY = 'sessionMode';
// Tokens of this browser's recent sessions. After a session has ended its token opens
// nothing but that session's recording.
const RECORDINGS_KEY = 'recordings';
const MAX_LISTED_RECORDINGS = 10;
const RECORDING_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_FRAMES = 120;
const LATENCY_TRIALS = 40;
const ROUND_TRIP_PINGS = 10;
const PING_TIMEOUT_MS = 2000;
const PROBE_POINTER_ID = 9;

const canvas = document.getElementById('screen');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const codeForm = document.getElementById('code-form');
const codeInput = document.getElementById('code-input');
const endedPanel = document.getElementById('ended');
const endedReason = document.getElementById('ended-reason');
const deviceButtons = document.getElementById('device-buttons');
const context = canvas.getContext('2d');
const clipboardNote = document.getElementById('clipboard-note');
const deviceClipboard = document.getElementById('device-clipboard');
const latencyResult = document.getElementById('latency-result');
const switchModeButton = document.getElementById('switch-mode');
const recordingVideo = document.getElementById('recording');
const recordingDownload = document.getElementById('recording-download');
const recordingList = document.getElementById('recording-list');

let socket = null;
let decoder = null;
let configBytes = null; // SPS/PPS, sent in front of the next key frame
let isWaitingForKeyFrame = true;
let latestFrame = null; // only the newest decoded frame is kept; older ones are dropped
let reconnectDelayMs = RECONNECT_MIN_MS;
let framesDrawn = 0;
let lastPastedText = null;
let isSwitchingMode = false;
const shouldDrawOnAnimationFrame = new URLSearchParams(location.search).get('draw') === 'raf';
const input = attachInput(canvas, (message) => sendMessage(message));
const frameArrivals = new Map(); // frame timestamp -> when its data reached this page
const pendingPings = new Map(); // ping id -> function that settles it
const probe = createLatencyProbe({ canvas, context, send: (message) => sendMessage(message), pointerId: PROBE_POINTER_ID });

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function drawFrame(frame) {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
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

// By default a frame is drawn the moment it is decoded. Waiting for the next animation
// frame adds up to one screen refresh of delay, and browsers slow animation frames to
// about one per second in a window that is not in front.
function onDecodedFrame(frame) {
  setStatus('live', document.body.dataset.mode === 'restricted' ? 'Live, Clock app only' : 'Live');
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
    error: (err) => restart(`decoder error: ${err.message}`),
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

function handleMessage(event) {
  try {
    if (typeof event.data !== 'string') return handlePacket(event.data);
    const message = JSON.parse(event.data);
    if (message.type === 'codec' && message.codec !== 'h264') throw new Error(`unsupported codec ${message.codec}`);
    if (message.type === 'device') handleDeviceState(message);
    // The device also reports the text we just pasted into it; that is not a device copy.
    if (message.type === 'clipboard' && message.text !== lastPastedText) showDeviceClipboard(message.text);
    if (message.type === 'pong' && pendingPings.has(message.id)) pendingPings.get(message.id)();
  } catch (err) {
    restart(err.message);
  }
}

function wantedMode() {
  const fromLink = new URLSearchParams(location.search).get('mode');
  const stored = sessionStorage.getItem(SESSION_MODE_KEY);
  return (stored || fromLink) === 'restricted' ? 'restricted' : 'full';
}

// Shows which kind of session the server gave us. The server decides; this is display only.
function showMode(mode) {
  document.body.dataset.mode = mode;
  switchModeButton.textContent = mode === 'restricted' ? 'Switch to full device' : 'Switch to Clock only';
}

// Ends this session and starts a new one of the other kind (a new device either way).
function switchMode() {
  sessionStorage.setItem(SESSION_MODE_KEY, document.body.dataset.mode === 'restricted' ? 'full' : 'restricted');
  isSwitchingMode = true;
  sendMessage({ t: 'end' });
}

function recordingUrl(token, isDownload) {
  const query = new URLSearchParams({ session: token });
  if (isDownload) query.set('download', '1');
  return `/recording?${query}`;
}

// localStorage can be unavailable or hold anything; a bad value is treated as empty.
function loadRecordings() {
  try {
    const list = JSON.parse(localStorage.getItem(RECORDINGS_KEY) || '[]');
    return list.filter((entry) => /^[0-9a-f]{32}$/.test(entry.token) && Date.now() - entry.startedAt < RECORDING_KEEP_MS);
  } catch {
    return [];
  }
}

function rememberRecording(token, mode) {
  const list = loadRecordings();
  if (list.some((entry) => entry.token === token)) return;
  const updated = [{ token, mode, startedAt: Date.now() }, ...list].slice(0, MAX_LISTED_RECORDINGS);
  try {
    localStorage.setItem(RECORDINGS_KEY, JSON.stringify(updated));
  } catch {
    // Storage is blocked: the recording still exists, it is only not listed here.
  }
}

function link(text, href, opensNewTab) {
  const anchor = document.createElement('a');
  anchor.textContent = text;
  anchor.href = href;
  if (opensNewTab) {
    anchor.target = '_blank';
    anchor.rel = 'noopener';
  }
  return anchor;
}

function renderRecordings() {
  const items = loadRecordings().map((entry) => {
    const item = document.createElement('li');
    const kind = entry.mode === 'restricted' ? 'Clock only' : 'full device';
    item.append(`${new Date(entry.startedAt).toLocaleString()}, ${kind}`, link('Watch', recordingUrl(entry.token, false), true), link('Download', recordingUrl(entry.token, true), false));
    return item;
  });
  if (items.length === 0) items.push(Object.assign(document.createElement('li'), { textContent: 'No recordings yet.' }));
  recordingList.replaceChildren(...items);
}

function showRecording(token) {
  recordingVideo.src = recordingUrl(token, false);
  recordingVideo.hidden = false;
  recordingDownload.href = recordingUrl(token, true);
  recordingDownload.hidden = false;
}

function hideRecording() {
  recordingVideo.removeAttribute('src');
  recordingVideo.load();
  recordingVideo.hidden = true;
  recordingDownload.hidden = true;
}

function handleDeviceState(message) {
  if (message.token) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, message.token);
    rememberRecording(message.token, message.mode || 'full');
    renderRecordings();
  }
  if (message.mode) showMode(message.mode);
  if (message.state === 'starting') setStatus('connecting', 'Starting your Android device (about 10 seconds)');
  if (message.state === 'ready') setStatus('connecting', 'Device ready, waiting for video');
}

function showSessionEnded(reason) {
  const endedToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  if (isSwitchingMode) {
    isSwitchingMode = false;
    setStatus('connecting', 'Connecting');
    return connect();
  }
  setStatus('ended', 'Session ended');
  endedReason.textContent = `Session ended: ${reason || 'no reason given'}. The device and everything on it were removed.`;
  endedPanel.hidden = false;
  deviceButtons.hidden = true;
  if (endedToken) showRecording(endedToken);
}

// Browsers only allow clipboard access on HTTPS and usually only right after a click or
// key press, so every step says plainly whether it worked.
async function showDeviceClipboard(text) {
  deviceClipboard.value = text;
  try {
    await navigator.clipboard.writeText(text);
    clipboardNote.textContent = 'Copied from the device to this computer.';
  } catch {
    clipboardNote.textContent = 'The device copied some text. Press Copy to put it on this computer.';
  }
}

async function copyDeviceClipboard() {
  try {
    await navigator.clipboard.writeText(deviceClipboard.value);
    clipboardNote.textContent = 'Copied to this computer.';
  } catch {
    deviceClipboard.select();
    clipboardNote.textContent = 'This browser blocked copying. The text is selected: press Ctrl+C.';
  }
}

async function pasteIntoDevice() {
  try {
    const text = await navigator.clipboard.readText();
    if (text === '') {
      clipboardNote.textContent = 'The clipboard of this computer has no text.';
      return;
    }
    sendMessage({ t: 'paste', text });
    clipboardNote.textContent = 'Pasted into the device.';
  } catch {
    clipboardNote.textContent = 'This browser blocked reading the clipboard. Click the screen and press Ctrl+V instead.';
  }
  canvas.focus();
}

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

async function runLatencyTest() {
  latencyResult.textContent = 'Measuring the round trip to the server';
  const roundTrips = [];
  for (let id = 1; id <= ROUND_TRIP_PINGS; id += 1) {
    const ms = await pingOnce(id);
    if (ms !== null) roundTrips.push(ms);
  }
  const result = await probe.run(LATENCY_TRIALS, (done) => {
    latencyResult.textContent = `Tap ${done} of ${LATENCY_TRIALS}`;
  });
  const report = {
    when: new Date().toISOString(),
    inputToDisplayMs: result.total,
    browserPartMs: result.browser,
    roundTripToServerMs: summarize(roundTrips),
    timeouts: result.timeouts,
    samplesMs: result.samplesMs,
    video: `${canvas.width}x${canvas.height}`,
    browser: navigator.userAgent,
  };
  latencyResult.textContent = JSON.stringify(report, null, 2);
  return report;
}

function restart(reason) {
  setStatus('reconnecting', `Reconnecting (${reason})`);
  if (socket) socket.close();
}

function sendMessage(message) {
  if (message.t === 'paste') lastPastedText = message.text;
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// The access code arrives in the link as "#code=..." (the part after # is never sent
// to the server in the page request) or is typed into the form. It is kept for this tab only.
function readAccessCode() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('code');
  if (fromLink) {
    sessionStorage.setItem(ACCESS_CODE_KEY, fromLink);
    history.replaceState(null, '', location.pathname);
  }
  return sessionStorage.getItem(ACCESS_CODE_KEY) || '';
}

function askForAccessCode() {
  sessionStorage.removeItem(ACCESS_CODE_KEY);
  setStatus('error', 'Access code needed');
  codeForm.hidden = false;
  codeInput.focus();
}

function handleClose(event) {
  closeDecoder();
  input.reset();
  if (event.code === WS_CLOSE_BAD_CODE) return askForAccessCode();
  if (event.code === WS_CLOSE_SESSION_ENDED) return showSessionEnded(event.reason);
  if (event.code === WS_CLOSE_BUSY) {
    setStatus('reconnecting', 'All devices are in use. This page tries again every few seconds.');
    return setTimeout(connect, BUSY_RETRY_MS);
  }
  if (event.code === WS_CLOSE_ADDRESS_LIMIT) {
    setStatus('reconnecting', 'Your network address already has the most devices allowed at once. End one of them; this page tries again every few seconds.');
    return setTimeout(connect, BUSY_RETRY_MS);
  }
  const reason = event.code === WS_CLOSE_TRY_AGAIN && event.reason ? event.reason : 'connection lost';
  if (statusEl.dataset.state !== 'reconnecting') setStatus('reconnecting', `Reconnecting (${reason})`);
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = new URLSearchParams({ code: readAccessCode(), mode: wantedMode() });
  const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (sessionToken) query.set('session', sessionToken);
  socket = new WebSocket(`${scheme}://${location.host}/stream?${query}`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    setStatus('connecting', 'Connected, waiting for video');
  });
  socket.addEventListener('message', handleMessage);
  socket.addEventListener('close', handleClose);
}

function start() {
  if (!('VideoDecoder' in window)) {
    return setStatus('error', 'This browser cannot decode the stream (WebCodecs is missing). Use a current Chrome, Edge, Firefox or Safari over HTTPS or localhost.');
  }
  setStatus('connecting', 'Connecting');
  setInterval(() => {
    statsEl.textContent = `${framesDrawn} frames/s, ${canvas.width}x${canvas.height}`;
    // A second with drawn frames means the stream is healthy, so the next retry can be quick.
    if (framesDrawn > 0) reconnectDelayMs = RECONNECT_MIN_MS;
    framesDrawn = 0;
  }, STATS_INTERVAL_MS);
  if (shouldDrawOnAnimationFrame) requestAnimationFrame(drawLatestFrame);
  for (const button of document.querySelectorAll('button[data-key]')) {
    button.addEventListener('click', () => {
      input.sendKeyPress(button.dataset.key);
      canvas.focus();
    });
  }
  document.getElementById('end-session').addEventListener('click', () => sendMessage({ t: 'end' }));
  switchModeButton.addEventListener('click', switchMode);
  document.getElementById('paste').addEventListener('click', pasteIntoDevice);
  document.getElementById('copy-device').addEventListener('click', copyDeviceClipboard);
  document.getElementById('latency-run').addEventListener('click', runLatencyTest);
  renderRecordings();
  document.getElementById('new-session').addEventListener('click', () => {
    hideRecording();
    endedPanel.hidden = true;
    deviceButtons.hidden = false;
    setStatus('connecting', 'Connecting');
    connect();
  });
  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sessionStorage.setItem(ACCESS_CODE_KEY, codeInput.value.trim());
    codeInput.value = '';
    codeForm.hidden = true;
    setStatus('connecting', 'Connecting');
    connect();
  });
  connect();
}

start();
