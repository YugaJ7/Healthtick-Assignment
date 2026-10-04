import { codecStringFromConfig, concatBytes } from './h264.mjs';
import { attachInput } from './input.mjs';

const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const STATS_INTERVAL_MS = 1000;

const canvas = document.getElementById('screen');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
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
  } catch (err) {
    restart(err.message);
  }
}

function restart(reason) {
  setStatus('reconnecting', `Reconnecting (${reason})`);
  if (socket) socket.close();
}

function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function scheduleReconnect() {
  closeDecoder();
  input.reset();
  if (statusEl.dataset.state !== 'reconnecting') setStatus('reconnecting', 'Connection lost, reconnecting');
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}/stream`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    setStatus('connecting', 'Connected, waiting for video');
  });
  socket.addEventListener('message', handleMessage);
  socket.addEventListener('close', scheduleReconnect);
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
  connect();
}

start();
