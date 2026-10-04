'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecorder } = require('../src/recorder');
const { topLevelBoxes, frameTiming } = require('../testHelpers/boxes');

const START = Buffer.from([0, 0, 0, 1]);
const CONFIG = Buffer.concat([START, Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xaa]), START, Buffer.from([0x68, 0xce, 0x3c, 0x80])]);
const sessionEvent = { type: 'session', width: 720, height: 1280 };
const configEvent = { type: 'packet', isConfig: true, isKeyFrame: false, ptsUs: 0, data: CONFIG };
const frame = (ptsMs, isKeyFrame = false) => ({
  type: 'packet', isConfig: false, isKeyFrame, ptsUs: ptsMs * 1000,
  data: Buffer.concat([START, Buffer.from([isKeyFrame ? 0x65 : 0x41, 1, 2, 3])]),
});

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: 0 };
  const logs = [];
  const filePath = path.join(dir, 'session.mp4');
  const recorder = createRecorder({ filePath, maxBytes: 1_000_000, log: (line) => logs.push(line), now: () => clock.ms, ...options });
  const timings = () => {
    const buffer = fs.readFileSync(filePath);
    return topLevelBoxes(buffer).filter((entry) => entry.type === 'moof').map((moof) => frameTiming(buffer, moof));
  };
  return { recorder, filePath, clock, logs, timings };
}

test('writes a header, then one piece per frame with the time between frames', async (t) => {
  const { recorder, filePath, timings } = setup(t);

  for (const event of [{ type: 'codec', codec: 'h264' }, sessionEvent, configEvent, frame(0, true), frame(40), frame(500)]) recorder.write(event);
  await recorder.close();

  const types = topLevelBoxes(fs.readFileSync(filePath)).map((entry) => entry.type);
  assert.deepEqual(types, ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
  assert.deepEqual(timings(), [
    { timeMs: 0, durationMs: 40, isKeyFrame: true },
    { timeMs: 40, durationMs: 460, isKeyFrame: false },
    { timeMs: 500, durationMs: 33, isKeyFrame: false },
  ]);
});

test('frames before the first key frame are left out', async (t) => {
  const { recorder, timings } = setup(t);

  for (const event of [sessionEvent, configEvent, frame(0), frame(40), frame(80, true)]) recorder.write(event);
  await recorder.close();

  assert.deepEqual(timings().map((entry) => entry.isKeyFrame), [true]);
});

test('a second stream of the same session continues on the same timeline', async (t) => {
  const { recorder, clock, timings } = setup(t);
  for (const event of [sessionEvent, configEvent, frame(0, true), frame(40)]) recorder.write(event);

  clock.ms = 10_000; // the viewer reloads the page ten seconds in; timestamps start again
  for (const event of [sessionEvent, configEvent, frame(0, true), frame(40)]) recorder.write(event);
  await recorder.close();

  assert.deepEqual(timings().map((entry) => entry.timeMs), [0, 40, 10_000, 10_040]);
  assert.equal(timings()[1].durationMs, 9960);
});

test('the key frame after a new stream carries the parameter sets again', async (t) => {
  const { recorder, filePath } = setup(t);

  for (const event of [sessionEvent, configEvent, frame(0, true)]) recorder.write(event);
  await recorder.close();

  const buffer = fs.readFileSync(filePath);
  const mdat = topLevelBoxes(buffer).find((entry) => entry.type === 'mdat');
  // length-prefixed SPS first: 00 00 00 05 67 ...
  assert.deepEqual([...buffer.subarray(mdat.start + 8, mdat.start + 13)], [0, 0, 0, 5, 0x67]);
});

test('stops at the size limit and says so', async (t) => {
  const { recorder, filePath, logs } = setup(t, { maxBytes: 1200 });

  recorder.write(sessionEvent);
  recorder.write(configEvent);
  for (let i = 0; i < 50; i += 1) recorder.write(frame(i * 40, i === 0));
  await recorder.close();

  assert.ok(fs.statSync(filePath).size <= 1200);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /size limit/);
});

test('nothing is written when no video arrived', async (t) => {
  const { recorder, filePath } = setup(t);

  recorder.write(sessionEvent);
  await recorder.close();

  assert.equal(fs.existsSync(filePath), false);
});

test('a malformed packet stops the recording instead of throwing', async (t) => {
  const { recorder, logs } = setup(t);
  recorder.write(sessionEvent);
  recorder.write(configEvent);

  assert.doesNotThrow(() => recorder.write({ type: 'packet', isConfig: false, isKeyFrame: true, ptsUs: 0, data: null }));
  await recorder.close();

  assert.equal(logs.length, 1);
});
