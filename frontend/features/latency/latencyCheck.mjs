import { createLatencyProbe, summarize } from './latency.mjs';
import { renderLatencyReport } from './latencyPanel.mjs';

// Runs the latency check: a few pings for the round trip to the server, then the taps
// (latency.mjs), and shows the result in the panel (latencyPanel.mjs).

const TRIALS = 40;
const ROUND_TRIP_PINGS = 10;
const PING_TIMEOUT_MS = 2000;
// The probe uses the first touch slot: a Clock-only session accepts no other.
const PROBE_POINTER_ID = 0;

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {CanvasRenderingContext2D} options.context
 * @param {(message: object) => void} options.send
 * @param {HTMLButtonElement} options.button shows the count while the check runs
 * @param {HTMLElement} options.panel
 * @param {HTMLElement} options.body the part of the panel that holds the result
 */
export function createLatencyCheck({ canvas, context, send, button, panel, body }) {
  const pendingPings = new Map(); // ping id -> function that settles it
  const probe = createLatencyProbe({ canvas, context, send, pointerId: PROBE_POINTER_ID });

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
      send({ t: 'ping', id });
    });
  }

  /**
   * @param {() => boolean} isAbandoned checked between steps; true stops the check early
   * @returns {Promise<object>} the report (see renderLatencyReport)
   */
  async function measure(isAbandoned) {
    const showCount = (done) => { button.textContent = `Running… ${done}/${TRIALS}`; };
    button.classList.add('running');
    showCount(0);
    const roundTrips = [];
    for (let id = 1; id <= ROUND_TRIP_PINGS && !isAbandoned(); id += 1) {
      const ms = await pingOnce(id);
      if (ms !== null) roundTrips.push(ms);
    }
    const result = await probe.run(TRIALS, showCount, isAbandoned);
    return {
      when: new Date().toISOString(),
      total: result.total,
      browser: result.browser,
      roundTrip: summarize(roundTrips),
      timeouts: result.timeouts,
      samplesMs: result.samplesMs,
      video: `${canvas.width}x${canvas.height}`,
    };
  }

  return {
    measure,
    show: (report) => {
      renderLatencyReport(body, report);
      panel.hidden = false;
    },
    hide: () => { panel.hidden = true; },
    onPong: (id) => {
      if (pendingPings.has(id)) pendingPings.get(id)();
    },
    onFrameDrawn: probe.onFrameDrawn,
  };
}
