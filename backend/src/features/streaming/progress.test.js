'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STAGES, progressMessage } = require('./progress');

test('the percentage only goes up from one stage to the next, and stays below 100', () => {
  const percents = Object.values(STAGES).map((entry) => entry.percent);

  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.equal(new Set(percents).size, percents.length);
  assert.ok(percents.every((percent) => percent > 0 && percent < 100));
});

test('a progress message carries the stage, its percentage and a line of text', () => {
  assert.deepEqual(progressMessage('booted'), { type: 'progress', stage: 'booted', percent: 75, label: 'Android has booted' });
});

test('an unknown stage is refused', () => {
  assert.throws(() => progressMessage('teleported'), /unknown stage/);
});
