// Measures input-to-display latency inside the page, using one clock.
//
// One trial: read the pixels around a point, send a touch-down at that point, and stop
// the clock when a drawn video frame shows a change there. The point is the Back button,
// which Android highlights as soon as it is pressed. The finger is then slid off the
// button before it is lifted, so no Back press happens. The device must be in portrait. What this includes: page -> server -> device -> render -> encode
// -> server -> page -> decode -> draw. What it leaves out: the mouse or touch hardware
// before the browser sees the event, and the monitor after the canvas is drawn.

const REGION_HALF_PX = 24;
const CHANGE_THRESHOLD = 6; // mean difference per colour channel, 0-255
const TRIAL_TIMEOUT_MS = 2000;
const SETTLE_MS = 900; // lets the dot disappear before the next baseline is taken
const RGBA_CHANNELS = 4;
// Centre of the Back button as a fraction of the screen (178, 1230 on a 720 x 1280 device).
const BACK_BUTTON_X = 178 / 720;
const BACK_BUTTON_Y = 1230 / 1280;
const SLIDE_AWAY = 0.25; // of the screen height

/**
 * @param {number[]} samples
 * @returns {{ count: number, median: number, p95: number, min: number, max: number } | null}
 */
export function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  // Nearest-rank method: the smallest value with at least 95 % of samples at or below it.
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  return { count: sorted.length, median, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * Mean absolute difference of the colour channels of two RGBA pixel arrays (alpha ignored).
 * @param {Uint8ClampedArray | number[]} a
 * @param {Uint8ClampedArray | number[]} b
 * @returns {number}
 */
export function meanColourDifference(a, b) {
  let total = 0;
  let channels = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (i % RGBA_CHANNELS === RGBA_CHANNELS - 1) continue;
    total += Math.abs(a[i] - b[i]);
    channels += 1;
  }
  return channels === 0 ? 0 : total / channels;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {CanvasRenderingContext2D} options.context
 * @param {(message: object) => void} options.send
 * @param {number} options.pointerId touch slot reserved for the probe
 */
export function createLatencyProbe({ canvas, context, send, pointerId }) {
  let armed = null;

  // The Back button of the navigation bar (portrait layout). Android highlights it the
  // moment it is pressed, and a Back press on the home screen changes nothing else.
  const point = () => ({
    x: Math.round(canvas.width * BACK_BUTTON_X),
    y: Math.round(canvas.height * BACK_BUTTON_Y),
  });

  function readRegion() {
    const { x, y } = point();
    const left = Math.max(0, x - REGION_HALF_PX);
    const top = Math.max(0, y - REGION_HALF_PX);
    return context.getImageData(left, top, REGION_HALF_PX * 2, REGION_HALF_PX * 2).data;
  }

  /** Call right after each video frame is drawn. `arrivedAt` is when its data reached the page. */
  function onFrameDrawn(arrivedAt) {
    if (!armed) return;
    if (meanColourDifference(readRegion(), armed.baseline) < CHANGE_THRESHOLD) return;
    const drawnAt = performance.now();
    const result = { totalMs: drawnAt - armed.sentAt, browserMs: arrivedAt === undefined ? null : drawnAt - arrivedAt };
    const { resolve } = armed;
    armed = null;
    resolve(result);
  }

  async function runTrial() {
    await sleep(SETTLE_MS);
    const { x, y } = point();
    const result = await new Promise((resolve) => {
      const trial = { baseline: readRegion(), sentAt: performance.now(), resolve };
      armed = trial;
      send({ t: 'touch', a: 'down', id: pointerId, x, y });
      // Only this trial's own timer may give up on it; by the time the timer fires, a
      // later trial may already be armed.
      setTimeout(() => {
        if (armed !== trial) return;
        armed = null;
        resolve(null);
      }, TRIAL_TIMEOUT_MS);
    });
    // Lifting the finger away from the button cancels the press.
    const away = Math.max(0, y - Math.round(canvas.height * SLIDE_AWAY));
    send({ t: 'touch', a: 'move', id: pointerId, x, y: away });
    send({ t: 'touch', a: 'up', id: pointerId, x, y: away });
    return result;
  }

  /**
   * @param {number} count
   * @param {(done: number) => void} onProgress
   * @param {() => boolean} [shouldStop] checked before each tap
   * @returns {Promise<{ total: object | null, browser: object | null, timeouts: number, samplesMs: number[] }>}
   */
  async function run(count, onProgress, shouldStop = () => false) {
    const results = [];
    let timeouts = 0;
    for (let i = 0; i < count && !shouldStop(); i += 1) {
      const result = await runTrial();
      if (result) results.push(result);
      else timeouts += 1;
      onProgress(i + 1);
    }
    const totals = results.map((r) => r.totalMs);
    return {
      total: summarize(totals),
      browser: summarize(results.map((r) => r.browserMs).filter((ms) => ms !== null)),
      timeouts,
      samplesMs: totals.map((ms) => Math.round(ms)),
    };
  }

  return { onFrameDrawn, run };
}
