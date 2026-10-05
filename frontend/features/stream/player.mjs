import { codecStringFromConfig, concatBytes } from './h264.mjs';

// Turns the video packets from the server into pictures on the canvas.
// Packet layout: [flags u8][timestamp, microseconds, u64 big-endian][H.264 Annex B bytes].

const PACKET_HEADER_BYTES = 9;
const FLAG_CONFIG = 0x01;
const FLAG_KEY_FRAME = 0x02;
const MAX_TRACKED_FRAMES = 120;

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {CanvasRenderingContext2D} options.context
 * @param {boolean} options.shouldDrawOnAnimationFrame the older drawing path, kept to compare latency
 * @param {() => void} options.onDecoded called for every decoded frame, before it is drawn
 * @param {(arrivedAt: number | undefined) => void} options.onDrawn called after a frame is drawn,
 *   with the time its data reached the page
 * @param {() => void} options.onSizeChange the video changed size (first frame, rotation)
 * @param {(message: string) => void} options.onError the decoder gave up
 */
export function createPlayer({ canvas, context, shouldDrawOnAnimationFrame, onDecoded, onDrawn, onSizeChange, onError }) {
  let decoder = null;
  let configBytes = null; // SPS/PPS, sent in front of the next key frame
  let isWaitingForKeyFrame = true;
  let latestFrame = null; // only used by the animation-frame path
  let framesDrawn = 0;
  const frameArrivals = new Map(); // frame timestamp -> when its data reached this page

  function drawFrame(frame) {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      onSizeChange();
    }
    context.drawImage(frame, 0, 0);
    const arrivedAt = frameArrivals.get(frame.timestamp);
    frameArrivals.delete(frame.timestamp);
    frame.close();
    framesDrawn += 1;
    onDrawn(arrivedAt);
  }

  // Older drawing path (open the page with ?draw=raf): the newest frame waits for the
  // browser's next animation frame.
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
    onDecoded();
    if (!shouldDrawOnAnimationFrame) return drawFrame(frame);
    if (latestFrame) latestFrame.close();
    latestFrame = frame;
  }

  /** Forgets the decoder; the next configuration packet starts a new one. */
  function close() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    configBytes = null;
    isWaitingForKeyFrame = true;
  }

  function configure(bytes) {
    const codec = codecStringFromConfig(bytes);
    if (!codec) throw new Error('config packet without an SPS');
    close();
    decoder = new VideoDecoder({
      output: onDecodedFrame,
      error: (err) => onError(`decoder error: ${err.message}`),
    });
    // No `description` means the decoder expects Annex B data, which is what we receive.
    decoder.configure({ codec, optimizeForLatency: true });
    configBytes = bytes;
  }

  /**
   * @param {ArrayBuffer} buffer one binary WebSocket message
   * @throws when a configuration packet cannot be understood
   */
  function handlePacket(buffer) {
    const view = new DataView(buffer);
    const flags = view.getUint8(0);
    const ptsUs = Number(view.getBigUint64(1));
    const payload = new Uint8Array(buffer, PACKET_HEADER_BYTES);

    if (flags & FLAG_CONFIG) return configure(payload.slice());
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

  /** Frames drawn since the last call; the count starts again from zero. */
  function takeFrameCount() {
    const count = framesDrawn;
    framesDrawn = 0;
    return count;
  }

  if (shouldDrawOnAnimationFrame) requestAnimationFrame(drawLatestFrame);
  return { handlePacket, close, takeFrameCount };
}
