'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitNalUnits, parseParameterSets, toLengthPrefixed, initSegment, mediaSegment } = require('./mp4');
const { topLevelBoxes } = require('./mp4BoxReader');

const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xaa, 0xbb]);
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const START_3 = Buffer.from([0, 0, 1]);
const START_4 = Buffer.from([0, 0, 0, 1]);

test('splits a byte stream at three-byte and four-byte start codes', () => {
  const stream = Buffer.concat([START_4, SPS, START_3, PPS, START_4, Buffer.from([0x65, 0x01, 0x02])]);

  const units = splitNalUnits(stream);

  assert.deepEqual(units.map((unit) => [...unit]), [[...SPS], [...PPS], [0x65, 0x01, 0x02]]);
});

test('a stream without any start code has no units', () => {
  assert.deepEqual(splitNalUnits(Buffer.from([1, 2, 3, 4])), []);
  assert.deepEqual(splitNalUnits(Buffer.alloc(0)), []);
});

test('finds the two parameter sets in a configuration packet', () => {
  const sets = parseParameterSets(Buffer.concat([START_4, SPS, START_4, PPS]));

  assert.deepEqual([...sets.sps], [...SPS]);
  assert.deepEqual([...sets.pps], [...PPS]);
});

test('a configuration packet without both parameter sets is refused', () => {
  assert.equal(parseParameterSets(Buffer.concat([START_4, SPS])), null);
  assert.equal(parseParameterSets(Buffer.from([9, 9, 9])), null);
});

test('puts a four-byte length in front of each unit', () => {
  const data = toLengthPrefixed([Buffer.from([0xaa]), Buffer.from([0xbb, 0xcc])]);

  assert.deepEqual([...data], [0, 0, 0, 1, 0xaa, 0, 0, 0, 2, 0xbb, 0xcc]);
});

test('the file header is two well-formed boxes that carry the parameter sets', () => {
  const header = initSegment({ sps: SPS, pps: PPS, width: 720, height: 1280 });

  assert.deepEqual(topLevelBoxes(header).map((entry) => entry.type), ['ftyp', 'moov']);
  const avcC = header.indexOf(Buffer.from('avcC'));
  // version 1, then profile, compatibility and level copied from the SPS
  assert.deepEqual([...header.subarray(avcC + 4, avcC + 8)], [1, 0x42, 0xc0, 0x1f]);
  assert.ok(header.indexOf(SPS) > avcC);
  assert.ok(header.indexOf(PPS) > avcC);
});

test('a frame piece says where its bytes are, how long it lasts and whether it is a key frame', () => {
  const data = Buffer.from([0, 0, 0, 3, 0x65, 0x11, 0x22]);

  const piece = mediaSegment({ sequence: 5, timeMs: 1000, durationMs: 40, isKeyFrame: true, data });

  const boxes = topLevelBoxes(piece);
  assert.deepEqual(boxes.map((entry) => entry.type), ['moof', 'mdat']);
  const trun = piece.indexOf(Buffer.from('trun')) + 4;
  const dataOffset = piece.readUInt32BE(trun + 8);
  assert.deepEqual([...piece.subarray(dataOffset, dataOffset + data.length)], [...data]);
  assert.equal(piece.readUInt32BE(trun + 12), 40);
  assert.equal(piece.readUInt32BE(trun + 16), data.length);
  assert.equal(piece.readUInt32BE(trun + 20), 0x02000000);
  const tfdt = piece.indexOf(Buffer.from('tfdt')) + 4;
  assert.equal(piece.readBigUInt64BE(tfdt + 4), 1000n);
});

test('a frame that is not a key frame is marked as depending on others', () => {
  const piece = mediaSegment({ sequence: 1, timeMs: 0, durationMs: 33, isKeyFrame: false, data: Buffer.from([0, 0, 0, 1, 0x41]) });

  const trun = piece.indexOf(Buffer.from('trun')) + 4;
  assert.equal(piece.readUInt32BE(trun + 20), 0x01010000);
});
