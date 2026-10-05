'use strict';

// The stages a new session passes through, in order, and the percentage the page shows
// for each. Every stage is a real event on the server; nothing here is timed.
// The page adds the last step itself: 100 % when it has decoded the first video frame.
const STAGES = Object.freeze({
  requested: { percent: 5, label: 'Session accepted' },
  created: { percent: 20, label: 'Device created' },
  reachable: { percent: 35, label: 'Android is starting' },
  booting: { percent: 55, label: 'Android is booting' },
  booted: { percent: 75, label: 'Android has booted' },
  secured: { percent: 80, label: 'Device locked down' },
  streaming: { percent: 85, label: 'Video stream started' },
  control: { percent: 95, label: 'Input channel connected' },
});

/**
 * @param {keyof typeof STAGES} stage
 * @returns {{ type: 'progress', stage: string, percent: number, label: string }}
 */
function progressMessage(stage) {
  const entry = STAGES[stage];
  if (!entry) throw new Error(`unknown stage "${stage}"`);
  return { type: 'progress', stage, percent: entry.percent, label: entry.label };
}

module.exports = { STAGES, progressMessage };
