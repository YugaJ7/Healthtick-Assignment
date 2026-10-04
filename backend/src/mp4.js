'use strict';

// A minimal writer for fragmented MP4 holding one H.264 video track. The recording is the
// device's own H.264 stream put into a file with timestamps; nothing is re-encoded.
// "Fragmented" means the file is a header followed by small self-contained pieces, one
// per frame here, so a recording that is cut off at any point still plays.

const TIMESCALE = 1000; // timestamps and durations are in milliseconds
const TRACK_ID = 1;
const NAL_TYPE_MASK = 0x1f;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const SAMPLE_FLAGS_KEY_FRAME = 0x02000000; // depends on no other frame
const SAMPLE_FLAGS_OTHER_FRAME = 0x01010000; // depends on others, and is not a sync point
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400; // data offset, duration, size, flags
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const BOX_HEADER_BYTES = 8;

const u8 = (...values) => Buffer.from(values);
function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}
function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}
function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
const zeros = (count) => Buffer.alloc(count);
const ascii = (text) => Buffer.from(text, 'latin1');

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(BOX_HEADER_BYTES + payload.length), ascii(type), payload]);
}
const fullBox = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);

/**
 * Splits an H.264 "Annex B" byte stream (units separated by 00 00 01 start codes) into
 * its units, without the start codes.
 * @param {Buffer} data
 * @returns {Buffer[]}
 */
function splitNalUnits(data) {
  const units = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        // A four-byte start code has one more zero in front, which is not part of the unit.
        const end = data[i - 1] === 0 ? i - 1 : i;
        units.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
}

/**
 * Finds the two parameter sets a decoder needs in scrcpy's configuration packet.
 * @param {Buffer} configData Annex B bytes
 * @returns {{ sps: Buffer, pps: Buffer } | null}
 */
function parseParameterSets(configData) {
  const units = splitNalUnits(configData);
  const sps = units.find((unit) => (unit[0] & NAL_TYPE_MASK) === NAL_TYPE_SPS);
  const pps = units.find((unit) => (unit[0] & NAL_TYPE_MASK) === NAL_TYPE_PPS);
  return sps && pps && sps.length >= 4 ? { sps, pps } : null;
}

/**
 * MP4 stores each unit with its length in front instead of a start code.
 * @param {Buffer[]} units
 * @returns {Buffer}
 */
function toLengthPrefixed(units) {
  return Buffer.concat(units.flatMap((unit) => [u32(unit.length), unit]));
}

function sampleEntry({ sps, pps, width, height }) {
  const avcC = box('avcC',
    u8(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16(sps.length), sps,
    u8(1), u16(pps.length), pps);
  return box('avc1',
    zeros(6), u16(1), // data reference index
    zeros(16),
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    zeros(4), u16(1), // one frame per sample
    zeros(32), // compressor name
    u16(0x0018), u16(0xffff),
    avcC);
}

/**
 * The file header: what the video is and how to decode it. Written once.
 * @param {{ sps: Buffer, pps: Buffer, width: number, height: number }} video
 * @returns {Buffer}
 */
function initSegment(video) {
  const matrix = Buffer.concat(IDENTITY_MATRIX.map(u32));
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso6'), ascii('avc1'), ascii('mp41'));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u32(0x00010000), u16(0x0100), zeros(10), matrix, zeros(24), u32(TRACK_ID + 1));
  const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(TRACK_ID), zeros(4), u32(0), zeros(8), u16(0), u16(0), u16(0), zeros(2), matrix, u32(video.width * 65536), u32(video.height * 65536));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), zeros(1));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(video)),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', fullBox('vmhd', 0, 1, zeros(8)), dinf, stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(TRACK_ID), u32(1), u32(0), u32(0), u32(0)));
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/**
 * One frame as a self-contained piece of the file.
 * @param {object} sample
 * @param {number} sample.sequence counts up from 1
 * @param {number} sample.timeMs when the frame is shown, from the start of the recording
 * @param {number} sample.durationMs how long it stays on screen
 * @param {boolean} sample.isKeyFrame
 * @param {Buffer} sample.data the frame, length-prefixed (see toLengthPrefixed)
 * @returns {Buffer}
 */
function mediaSegment({ sequence, timeMs, durationMs, isKeyFrame, data }) {
  const build = (dataOffset) => box('moof',
    fullBox('mfhd', 0, 0, u32(sequence)),
    box('traf',
      fullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(TRACK_ID)),
      fullBox('tfdt', 1, 0, u64(timeMs)),
      fullBox('trun', 0, TRUN_FLAGS, u32(1), u32(dataOffset), u32(durationMs), u32(data.length),
        u32(isKeyFrame ? SAMPLE_FLAGS_KEY_FRAME : SAMPLE_FLAGS_OTHER_FRAME))));
  // The frame's bytes start right after this box and the header of the next one.
  const moofLength = build(0).length;
  return Buffer.concat([build(moofLength + BOX_HEADER_BYTES), box('mdat', data)]);
}

module.exports = { splitNalUnits, parseParameterSets, toLengthPrefixed, initSegment, mediaSegment };
