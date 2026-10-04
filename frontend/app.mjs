import { codecStringFromConfig, concatBytes } from './h264.mjs';
import { attachInput } from './input.mjs';

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
const BUSY_RETRY_MS = 5000;
const ACCESS_CODE_KEY = 'accessCode';
// Identifies this tab's device session, so a short network drop resumes the same device.
const SESSION_TOKEN_KEY = 'sessionToken';

const canvas = document.getElementById('screen');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const codeForm = document.getElementById('code-form');
const codeInput = document.getElementById('code-input');
const endedPanel = document.getElementById('ended');
const endedReason = document.getElementById('ended-reason');
const deviceButtons = document.getElementById('device-buttons');
const context = canvas.getContext('2d');

let socket = null;
let decoder = null;
let configBytes = null; // SPS/PPS, sent in front of the next key frame
let isWaitingForKeyFrame = true;
let latestFrame = null; // only the newest decoded frame is kept; older ones are dropped
let reconnectDelayMs = RECONNECT_MIN_MS;
let framesDrawn = 0;
const input = attachInput(canvas, (message) => sendMessage(message));

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function drawLatestFrame() {
  if (latestFrame) {
    const frame = latestFrame;
    latestFrame = null;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    context.drawImage(frame, 0, 0);
    frame.close();
    framesDrawn += 1;
  }
  requestAnimationFrame(drawLatestFrame);
}

function onDecodedFrame(frame) {
  if (latestFrame) latestFrame.close();
  latestFrame = frame;
  setStatus('live', 'Live');
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
  } catch (err) {
    restart(err.message);
  }
}

function handleDeviceState(message) {
  if (message.token) sessionStorage.setItem(SESSION_TOKEN_KEY, message.token);
  if (message.state === 'starting') setStatus('connecting', 'Starting your Android device (about 10 seconds)');
  if (message.state === 'ready') setStatus('connecting', 'Device ready, waiting for video');
}

function showSessionEnded(reason) {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  setStatus('ended', 'Session ended');
  endedReason.textContent = `Session ended: ${reason || 'no reason given'}. The device and everything on it were removed.`;
  endedPanel.hidden = false;
  deviceButtons.hidden = true;
}

function restart(reason) {
  setStatus('reconnecting', `Reconnecting (${reason})`);
  if (socket) socket.close();
}

function sendMessage(message) {
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
  const reason = event.code === WS_CLOSE_TRY_AGAIN && event.reason ? event.reason : 'connection lost';
  if (statusEl.dataset.state !== 'reconnecting') setStatus('reconnecting', `Reconnecting (${reason})`);
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = new URLSearchParams({ code: readAccessCode() });
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
  requestAnimationFrame(drawLatestFrame);
  for (const button of document.querySelectorAll('button[data-key]')) {
    button.addEventListener('click', () => {
      input.sendKeyPress(button.dataset.key);
      canvas.focus();
    });
  }
  document.getElementById('end-session').addEventListener('click', () => sendMessage({ t: 'end' }));
  document.getElementById('new-session').addEventListener('click', () => {
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
