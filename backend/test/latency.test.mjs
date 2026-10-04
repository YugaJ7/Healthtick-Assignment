import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, meanColourDifference } from '../../frontend/latency.mjs';

test('summarize reports median, 95th percentile, minimum and maximum', () => {
  const samples = Array.from({ length: 40 }, (_, i) => 40 - i); // 40 down to 1

  assert.deepEqual(summarize(samples), { count: 40, median: 20.5, p95: 38, min: 1, max: 40 });
});

test('summarize uses the middle value for an odd count and does not change its input', () => {
  const samples = [30, 10, 20];

  assert.equal(summarize(samples).median, 20);
  assert.deepEqual(samples, [30, 10, 20]);
});

test('summarize of a single sample', () => {
  assert.deepEqual(summarize([7]), { count: 1, median: 7, p95: 7, min: 7, max: 7 });
});

test('summarize of no samples is null', () => {
  assert.equal(summarize([]), null);
});

test('meanColourDifference ignores the alpha channel', () => {
  const a = [10, 20, 30, 255, 0, 0, 0, 255];
  const b = [13, 20, 24, 0, 0, 0, 0, 0];

  assert.equal(meanColourDifference(a, b), 9 / 6);
});

test('meanColourDifference of identical pixels is zero', () => {
  assert.equal(meanColourDifference([1, 2, 3, 4], [1, 2, 3, 4]), 0);
  assert.equal(meanColourDifference([], []), 0);
});
