import test from 'node:test';
import assert from 'node:assert/strict';
import { clientToVideoPoint } from '../../frontend/pointerMap.mjs';

const VIDEO_W = 720;
const VIDEO_H = 1280;

// Canvas rectangles as a browser would report them at different window sizes.
const RECTS = [
  { name: 'actual size', left: 0, top: 0, width: 720, height: 1280 },
  { name: 'small window', left: 438, top: 43, width: 419.0625, height: 745 },
  { name: 'phone, fractional offset', left: 16.5, top: 52.25, width: 180, height: 320 },
  { name: 'stretched on one axis', left: 10, top: 10, width: 720, height: 640 },
];

for (const rect of RECTS) {
  test(`corners and centre map to the device pixels (${rect.name})`, () => {
    const at = (fx, fy) => clientToVideoPoint(rect.left + rect.width * fx, rect.top + rect.height * fy, rect, VIDEO_W, VIDEO_H);

    assert.deepEqual(at(0, 0), { x: 0, y: 0 });
    assert.deepEqual(at(0.5, 0.5), { x: 360, y: 640 });
    // The last pixel is just inside the right and bottom edges.
    const lastX = rect.left + rect.width - rect.width / VIDEO_W / 2;
    const lastY = rect.top + rect.height - rect.height / VIDEO_H / 2;
    assert.deepEqual(clientToVideoPoint(lastX, lastY, rect, VIDEO_W, VIDEO_H), { x: 719, y: 1279 });
    assert.deepEqual(clientToVideoPoint(lastX, rect.top, rect, VIDEO_W, VIDEO_H), { x: 719, y: 0 });
    assert.deepEqual(clientToVideoPoint(rect.left, lastY, rect, VIDEO_W, VIDEO_H), { x: 0, y: 1279 });
  });
}

test('positions outside the canvas are clamped to the edge', () => {
  const rect = RECTS[1];

  assert.deepEqual(clientToVideoPoint(0, 0, rect, VIDEO_W, VIDEO_H), { x: 0, y: 0 });
  assert.deepEqual(clientToVideoPoint(5000, 5000, rect, VIDEO_W, VIDEO_H), { x: 719, y: 1279 });
  assert.deepEqual(clientToVideoPoint(rect.left + rect.width, rect.top + rect.height, rect, VIDEO_W, VIDEO_H), { x: 719, y: 1279 });
});

test('a rotated (landscape) video uses its own size', () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };

  assert.deepEqual(clientToVideoPoint(100 + 320, 50 + 180, rect, 1280, 720), { x: 640, y: 360 });
});

test('returns null while the canvas has no size', () => {
  assert.equal(clientToVideoPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, VIDEO_W, VIDEO_H), null);
  assert.equal(clientToVideoPoint(1, 1, RECTS[0], 0, 0), null);
});
