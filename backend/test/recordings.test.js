'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRange } = require('../src/recordings');

test('reads the byte ranges video players ask for', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
});

test('an absent or unusable range means the whole file', () => {
  for (const header of [undefined, '', 'bytes=-', 'bytes=abc-def', 'items=0-5', 'bytes=1000-', 'bytes=50-10']) {
    assert.equal(parseRange(header, 1000), null);
  }
});
