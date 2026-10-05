'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoParser, MAX_PACKET_BYTES } = require('./videoParser');

const H264_ID = Buffer.from([0x68, 0x32, 0x36, 0x34]);

function sessionPacket(width, height) {
  const packet = Buffer.alloc(12);
  packet[0] = 0x80;
  packet.writeUInt32BE(width, 4);
  packet.writeUInt32BE(height, 8);
  return packet;
}

function mediaPacket({ isConfig = false, isKeyFrame = false, ptsUs = 0, payload }) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(BigInt(ptsUs), 0);
  header[0] |= (isConfig ? 0x40 : 0) | (isKeyFrame ? 0x20 : 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function sampleStream() {
  return Buffer.concat([
    H264_ID,
    sessionPacket(720, 1280),
    mediaPacket({ isConfig: true, payload: Buffer.from([0, 0, 0, 1, 0x67, 0x42]) }),
    mediaPacket({ isKeyFrame: true, ptsUs: 1000, payload: Buffer.from([0, 0, 0, 1, 0x65, 9, 9]) }),
    mediaPacket({ ptsUs: 34000, payload: Buffer.from([0, 0, 0, 1, 0x41]) }),
  ]);
}

test('parses codec, session and media packets from one chunk', () => {
  const events = createVideoParser().push(sampleStream());

  assert.deepEqual(events.map((e) => e.type), ['codec', 'session', 'packet', 'packet', 'packet']);
  assert.equal(events[0].codec, 'h264');
  assert.deepEqual({ width: events[1].width, height: events[1].height }, { width: 720, height: 1280 });
  assert.equal(events[2].isConfig, true);
  assert.equal(events[3].isKeyFrame, true);
  assert.equal(events[3].ptsUs, 1000);
  assert.equal(events[4].isKeyFrame, false);
  assert.equal(events[4].ptsUs, 34000);
  assert.deepEqual([...events[4].data], [0, 0, 0, 1, 0x41]);
});

test('gives the same events when the stream arrives one byte at a time', () => {
  const stream = sampleStream();
  const whole = createVideoParser().push(stream);
  const parser = createVideoParser();
  const pieces = [];
  for (const byte of stream) pieces.push(...parser.push(Buffer.from([byte])));

  assert.equal(pieces.length, whole.length);
  pieces.forEach((event, i) => {
    assert.equal(event.type, whole[i].type);
    if (event.type === 'packet') assert.deepEqual([...event.data], [...whole[i].data]);
  });
});

test('keeps PTS values above 32 bits and strips the flag bits from them', () => {
  const ptsUs = 2 ** 40 + 5;
  const stream = Buffer.concat([H264_ID, mediaPacket({ isKeyFrame: true, ptsUs, payload: Buffer.from([1]) })]);

  const [, packet] = createVideoParser().push(stream);

  assert.equal(packet.ptsUs, ptsUs);
});

test('returns nothing until a packet is complete', () => {
  const stream = sampleStream();
  const parser = createVideoParser();

  assert.deepEqual(parser.push(stream.subarray(0, 3)), []);
  assert.equal(parser.push(stream.subarray(3, 20)).length, 2);
});

test('throws on an unknown codec id', () => {
  assert.throws(() => createVideoParser().push(Buffer.from([1, 2, 3, 4])), /unknown video codec/);
});

test('throws when a packet claims to be larger than the limit', () => {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(MAX_PACKET_BYTES + 1, 8);

  assert.throws(() => createVideoParser().push(Buffer.concat([H264_ID, header])), /exceeds the limit/);
});
