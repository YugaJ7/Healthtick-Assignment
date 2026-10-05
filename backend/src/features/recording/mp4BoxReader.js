'use strict';

// Reads the outermost boxes of an MP4 buffer: [length u32][type 4 chars][payload].
function topLevelBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > buffer.length) throw new Error(`bad box at ${offset}`);
    boxes.push({ type: buffer.toString('latin1', offset + 4, offset + 8), start: offset, size });
    offset += size;
  }
  return boxes;
}

// Time and duration (ms) of the frame in one 'moof' box.
function frameTiming(buffer, moof) {
  const piece = buffer.subarray(moof.start, moof.start + moof.size);
  const tfdt = piece.indexOf(Buffer.from('tfdt')) + 4;
  const trun = piece.indexOf(Buffer.from('trun')) + 4;
  return { timeMs: Number(piece.readBigUInt64BE(tfdt + 4)), durationMs: piece.readUInt32BE(trun + 12), isKeyFrame: piece.readUInt32BE(trun + 20) === 0x02000000 };
}

module.exports = { topLevelBoxes, frameTiming };
