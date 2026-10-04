import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATE, nextState } from '../../frontend/state.mjs';

const walk = (events, from = INITIAL_STATE) => events.reduce((state, event) => nextState(state, event), from);

test('a normal visit: loading, live, ending, ended, and round again', () => {
  assert.equal(INITIAL_STATE, 'loading');
  assert.equal(walk(['firstFrame']), 'live');
  assert.equal(walk(['firstFrame', 'endRequested']), 'ending');
  assert.equal(walk(['firstFrame', 'endRequested', 'sessionEnded']), 'ended');
  assert.equal(walk(['firstFrame', 'endRequested', 'sessionEnded', 'restart']), 'loading');
});

test('the latency check is a side trip from live and back', () => {
  assert.equal(walk(['firstFrame', 'latencyStart']), 'latency');
  assert.equal(walk(['firstFrame', 'latencyStart', 'latencyDone']), 'live');
});

test('a session the server ends (idle, or lost while away) goes straight to ended', () => {
  assert.equal(walk(['firstFrame', 'sessionEnded']), 'ended');
  assert.equal(walk(['firstFrame', 'latencyStart', 'sessionEnded']), 'ended');
});

test('a session that ends before any video was shown is an error, with a retry', () => {
  assert.equal(walk(['sessionEnded']), 'error');
  assert.equal(walk(['failed']), 'error');
  assert.equal(walk(['failed', 'restart']), 'loading');
});

test('events that do not apply to the current state change nothing', () => {
  assert.equal(nextState('loading', 'endRequested'), 'loading');
  assert.equal(nextState('loading', 'latencyStart'), 'loading');
  assert.equal(nextState('ending', 'latencyStart'), 'ending');
  assert.equal(nextState('ended', 'firstFrame'), 'ended');
  assert.equal(nextState('live', 'restart'), 'live');
  assert.equal(nextState('latency', 'endRequested'), 'latency');
});

test('an unknown state is a programming error', () => {
  assert.throws(() => nextState('sideways', 'restart'), /unknown state/);
});
