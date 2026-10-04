'use strict';

const fs = require('node:fs');
const { parseParameterSets, splitNalUnits, toLengthPrefixed, initSegment, mediaSegment } = require('./mp4');

// Records one session's video to one MP4 file. It is fed the same events the viewer gets
// (see videoParser.js), so the recording is exactly what was streamed.
//
// A session can be streamed several times (page reload, reconnect): each stream starts
// with its own configuration packet and its own timestamps from zero. The recorder puts
// them on one timeline using the time each stream started.

const LAST_FRAME_MS = 33;
const MIN_FRAME_MS = 1;

/**
 * @param {object} options
 * @param {string} options.filePath
 * @param {number} options.maxBytes recording stops at this size
 * @param {(message: string) => void} options.log
 * @param {() => number} [options.now] clock in milliseconds
 */
function createRecorder({ filePath, maxBytes, log, now = Date.now }) {
  const startedAt = now();
  let file = null;
  let bytesWritten = 0;
  let isStopped = false;
  let videoSize = null;
  let parameterSets = null;
  let shouldRepeatParameterSets = false; // the next key frame carries them, after a new stream
  let streamOffsetMs = null; // added to a stream's own timestamps to get recording time
  let pending = null; // the newest frame; written once the next one tells how long it lasted
  let lastTimeMs = -MIN_FRAME_MS;
  let sequence = 0;

  function stop(why) {
    isStopped = true;
    log(`recording ${filePath} stopped: ${why}`);
  }

  function append(bytes) {
    if (isStopped) return;
    if (bytesWritten + bytes.length > maxBytes) return stop('size limit reached');
    if (!file) {
      file = fs.createWriteStream(filePath, { mode: 0o600 });
      file.on('error', (err) => stop(err.message));
    }
    bytesWritten += bytes.length;
    file.write(bytes);
  }

  function flushPending(untilMs) {
    if (!pending) return;
    sequence += 1;
    append(mediaSegment({ ...pending, sequence, durationMs: Math.max(MIN_FRAME_MS, untilMs - pending.timeMs) }));
    pending = null;
  }

  function writeFrame(packet) {
    if (!parameterSets || !videoSize) return;
    // Every stream, and the file itself, must begin with a key frame.
    if (streamOffsetMs === null && !packet.isKeyFrame) return;
    const ptsMs = packet.ptsUs / 1000;
    if (streamOffsetMs === null) streamOffsetMs = now() - startedAt - ptsMs;
    const timeMs = Math.max(lastTimeMs + MIN_FRAME_MS, Math.round(ptsMs + streamOffsetMs));
    if (bytesWritten === 0) append(initSegment({ ...parameterSets, ...videoSize }));
    flushPending(timeMs);

    const units = splitNalUnits(packet.data);
    if (packet.isKeyFrame && shouldRepeatParameterSets) {
      units.unshift(parameterSets.sps, parameterSets.pps);
      shouldRepeatParameterSets = false;
    }
    pending = { timeMs, isKeyFrame: packet.isKeyFrame, data: toLengthPrefixed(units) };
    lastTimeMs = timeMs;
  }

  function handle(event) {
    if (event.type === 'session') {
      // The header describes the first size only; a later size (rotation) is carried by
      // the parameter sets repeated in the stream.
      if (!videoSize) videoSize = { width: event.width, height: event.height };
      return;
    }
    if (event.type !== 'packet') return;
    if (!event.isConfig) return writeFrame(event);
    const parsed = parseParameterSets(event.data);
    if (!parsed) return;
    parameterSets = parsed;
    shouldRepeatParameterSets = true;
    streamOffsetMs = null;
  }

  /**
   * Never throws: a recording problem must not disturb the live stream.
   * @param {object} event an event from the video parser: codec, session or packet
   */
  function write(event) {
    if (isStopped) return;
    try {
      handle(event);
    } catch (err) {
      stop(err.message);
    }
  }

  /**
   * Writes the last frame and closes the file.
   * @returns {Promise<void>} settles when the file is complete on disk
   */
  function close() {
    if (pending) flushPending(pending.timeMs + LAST_FRAME_MS);
    isStopped = true;
    if (!file) return Promise.resolve();
    return new Promise((resolve) => file.end(resolve));
  }

  return { write, close };
}

module.exports = { createRecorder };
