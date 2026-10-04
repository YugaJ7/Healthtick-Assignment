// The page is always in exactly one of these states. `nextState` is the whole rule book:
// an event that is not listed for the current state changes nothing.
//
//   loading -> live <-> latency
//   live -> ending -> ended -> loading
//   any failure -> error -> loading (Retry)

const TRANSITIONS = {
  loading: { firstFrame: 'live', sessionEnded: 'error', failed: 'error' },
  live: { latencyStart: 'latency', endRequested: 'ending', sessionEnded: 'ended', failed: 'error' },
  latency: { latencyDone: 'live', sessionEnded: 'ended', failed: 'error' },
  ending: { sessionEnded: 'ended', failed: 'error' },
  ended: { restart: 'loading' },
  error: { restart: 'loading' },
};

export const INITIAL_STATE = 'loading';

/**
 * @param {string} state
 * @param {string} event
 * @returns {string} the state after the event; the same state when the event does not apply
 */
export function nextState(state, event) {
  const table = TRANSITIONS[state];
  if (!table) throw new Error(`unknown state "${state}"`);
  return table[event] ?? state;
}
