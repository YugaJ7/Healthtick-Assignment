'use strict';

// Parses the byte stream that scrcpy-server writes on its video socket.
// Format (scrcpy v4.1 doc/develop.md, "Protocol > Video and audio"):
//   u32 codec id, then a sequence of 12-byte session packets (first bit 1)
//   and media packets (first bit 0): 12-byte frame header followed by the payload.

const CODEC_ID_BYTES = 4;
const HEADER_BYTES = 12;
const SESSION_FLAG = 0x80;
const CONFIG_FLAG = 0x40;
const KEY_FRAME_FLAG = 0x20;
const CLIENT_RESIZED_FLAG = 0x01;
const PTS_MASK = (1n << 61n) - 1n;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;

const CODEC_NAMES = new Map([
  [0x68323634, 'h264'],
  [0x68323635, 'h265'],
  [0x00617631, 'av1'],
]);

function readSessionPacket(buffer, offset) {
  return {
    type: 'session',
    width: buffer.readUInt32BE(offset + 4),
    height: buffer.readUInt32BE(offset + 8),
    isClientResized: (buffer[offset + 3] & CLIENT_RESIZED_FLAG) !== 0,
  };
}

function readMediaPacket(buffer, offset, size) {
  const flags = buffer[offset];
  return {
    type: 'packet',
    isConfig: (flags & CONFIG_FLAG) !== 0,
    isKeyFrame: (flags & KEY_FRAME_FLAG) !== 0,
    ptsUs: Number(buffer.readBigUInt64BE(offset) & PTS_MASK),
    data: buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + size),
  };
}

// Returns a parser whose push(chunk) gives back the events completed by that chunk.
// TCP delivers arbitrary chunk sizes, so incomplete data is kept until the rest arrives.
function createVideoParser() {
  let pending = Buffer.alloc(0);
  let codec = null;

  function push(chunk) {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const events = [];
    let offset = 0;

    if (codec === null) {
      if (pending.length < CODEC_ID_BYTES) return events;
      const codecId = pending.readUInt32BE(0);
      codec = CODEC_NAMES.get(codecId) ?? null;
      if (codec === null) throw new Error(`unknown video codec id 0x${codecId.toString(16)}`);
      events.push({ type: 'codec', codec });
      offset = CODEC_ID_BYTES;
    }

    while (pending.length - offset >= HEADER_BYTES) {
      if (pending[offset] & SESSION_FLAG) {
        events.push(readSessionPacket(pending, offset));
        offset += HEADER_BYTES;
        continue;
      }
      const size = pending.readUInt32BE(offset + 8);
      if (size > MAX_PACKET_BYTES) throw new Error(`video packet of ${size} bytes exceeds the limit`);
      if (pending.length - offset < HEADER_BYTES + size) break;
      events.push(readMediaPacket(pending, offset, size));
      offset += HEADER_BYTES + size;
    }

    pending = pending.subarray(offset);
    return events;
  }

  return { push };
}

module.exports = { createVideoParser, HEADER_BYTES, MAX_PACKET_BYTES };
