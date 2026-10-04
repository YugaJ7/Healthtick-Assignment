import test from 'node:test';
import assert from 'node:assert/strict';
import { codecStringFromConfig, concatBytes, nalUnitOffsets } from '../../frontend/h264.mjs';

// SPS (type 7) for Constrained Baseline level 3.1, then a PPS (type 8).
const CONFIG = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);

test('finds the NAL units after 4-byte and 3-byte start codes', () => {
  assert.deepEqual(nalUnitOffsets(CONFIG), [4, 13]);
  assert.deepEqual(nalUnitOffsets(Uint8Array.from([0, 0, 1, 0x65, 0, 0, 1, 0x41])), [3, 7]);
});

test('builds the codec string from the SPS profile, constraint and level bytes', () => {
  assert.equal(codecStringFromConfig(CONFIG), 'avc1.42c01f');
});

test('pads single-digit hex values', () => {
  const config = Uint8Array.from([0, 0, 1, 0x67, 0x42, 0x00, 0x0a, 0xff]);

  assert.equal(codecStringFromConfig(config), 'avc1.42000a');
});

test('returns null when there is no SPS', () => {
  assert.equal(codecStringFromConfig(Uint8Array.from([0, 0, 1, 0x68, 1, 2, 3, 4])), null);
  assert.equal(codecStringFromConfig(new Uint8Array(0)), null);
});

test('returns null when the SPS is cut short', () => {
  assert.equal(codecStringFromConfig(Uint8Array.from([0, 0, 1, 0x67, 0x42])), null);
});

test('concatBytes joins without changing its inputs', () => {
  const first = Uint8Array.from([1, 2]);
  const second = Uint8Array.from([3]);

  assert.deepEqual([...concatBytes(first, second)], [1, 2, 3]);
  assert.deepEqual([...first], [1, 2]);
});
