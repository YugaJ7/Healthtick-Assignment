'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../../shared/config');
const { logger } = require('../../shared/logger');
const { createRecorder } = require('./recorder');
const { sessionIdOf } = require('../sessions/sessionManager');

// Where recordings live and who may fetch them. A recording is named after its session's
// id, and is handed out only to someone who shows that session's secret token. The
// server keeps no list of "a visitor's recordings": the visitor's browser remembers the
// tokens of its own sessions, and each token opens exactly one recording.
//
// Files per session: <id>.mp4 (the video) and, once the session has ended, <id>.json
// (start time, length, mode). The .json file is what marks a recording as complete.

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const VIDEO_SUFFIX = '.mp4';
const FACTS_SUFFIX = '.json';
// A video with no facts file that nobody is writing to: the backend stopped mid-session.
const ABANDONED_AFTER_MS = 5000;

const live = new Map(); // session id -> { recorder, startedAt, mode }
const videoPath = (id) => path.join(config.recordings.dir, `${id}${VIDEO_SUFFIX}`);
const factsPath = (id) => path.join(config.recordings.dir, `${id}${FACTS_SUFFIX}`);

/**
 * The recorder of a running session; it is created on first use.
 * @param {string} sessionId
 * @param {string} mode
 */
function recorderFor(sessionId, mode) {
  if (!live.has(sessionId)) {
    fs.mkdirSync(config.recordings.dir, { recursive: true, mode: 0o700 });
    const recorder = createRecorder({ filePath: videoPath(sessionId), maxBytes: config.recordings.maxBytes, log: logger.info });
    live.set(sessionId, { recorder, startedAt: Date.now(), mode });
  }
  return live.get(sessionId).recorder;
}

/**
 * Closes a session's recording and writes its facts file. Never rejects.
 * @param {string} sessionId
 */
async function finishRecording(sessionId) {
  const entry = live.get(sessionId);
  if (!entry) return;
  try {
    await entry.recorder.close();
    if (!fs.existsSync(videoPath(sessionId))) return; // no video was ever streamed
    const facts = { id: sessionId, startedAt: entry.startedAt, mode: entry.mode, durationMs: entry.recorder.durationMs() };
    fs.writeFileSync(factsPath(sessionId), JSON.stringify(facts), { mode: 0o600 });
  } catch (err) {
    logger.error(`could not finish recording ${sessionId}: ${err.message}`);
  } finally {
    live.delete(sessionId);
  }
}

/**
 * Which bytes of a file a request asks for (video players ask for parts).
 * @param {string | undefined} header the Range request header
 * @param {number} size file size in bytes
 * @returns {{ start: number, end: number } | null} null when the header is absent or unusable
 */
function parseRange(header, size) {
  const match = typeof header === 'string' ? RANGE_PATTERN.exec(header) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start <= end && start < size ? { start, end } : null;
}

// The session id behind a request's token, or null when the token is not one.
function idFromRequest(params) {
  const token = params.get('session') ?? '';
  return TOKEN_PATTERN.test(token) ? sessionIdOf(token) : null;
}

function notFound(res, extraHeaders) {
  res.writeHead(404, { 'content-type': 'text/plain', ...extraHeaders });
  res.end('no recording for this session');
}

/**
 * Answers GET /recording?session=<token>[&download=1].
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {Record<string, string>} extraHeaders
 */
function serveRecording(req, res, params, extraHeaders) {
  const id = idFromRequest(params);
  if (id === null) return notFound(res, extraHeaders);
  fs.stat(videoPath(id), (err, stats) => {
    if (err || stats.size === 0) return notFound(res, extraHeaders);
    const range = parseRange(req.headers.range, stats.size);
    const { start, end } = range ?? { start: 0, end: stats.size - 1 };
    const headers = {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      ...extraHeaders,
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${stats.size}`;
    if (params.get('download') === '1') headers['content-disposition'] = `attachment; filename="session-${id}${VIDEO_SUFFIX}"`;
    res.writeHead(range ? 206 : 200, headers);
    fs.createReadStream(videoPath(id), { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

/**
 * What is known about one recording.
 * @param {string} id session id
 * @returns {{ id: string, startedAt: number, mode: string | null, durationMs: number | null, sizeBytes: number, isComplete: boolean } | null}
 */
function describeRecording(id) {
  let stats;
  try {
    stats = fs.statSync(videoPath(id));
  } catch {
    return null;
  }
  if (stats.size === 0) return null;
  try {
    const facts = JSON.parse(fs.readFileSync(factsPath(id), 'utf8'));
    return { id, startedAt: facts.startedAt, mode: facts.mode, durationMs: facts.durationMs, sizeBytes: stats.size, isComplete: true };
  } catch {
    // No facts file yet: the session is running, is being closed, or was cut off.
  }
  const entry = live.get(id);
  if (entry) return { id, startedAt: entry.startedAt, mode: entry.mode, durationMs: null, sizeBytes: stats.size, isComplete: false };
  const isAbandoned = Date.now() - stats.mtimeMs > ABANDONED_AFTER_MS;
  return { id, startedAt: Math.round(stats.birthtimeMs), mode: null, durationMs: null, sizeBytes: stats.size, isComplete: isAbandoned };
}

/**
 * Answers GET /recording/info?session=<token> with JSON.
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {Record<string, string>} extraHeaders
 */
function serveRecordingInfo(res, params, extraHeaders) {
  const id = idFromRequest(params);
  const description = id === null ? null : describeRecording(id);
  if (description === null) return notFound(res, extraHeaders);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...extraHeaders });
  res.end(JSON.stringify(description));
}

/**
 * Deletes recordings older than the keeping time, then the oldest ones while the folder
 * is over its size limit. Recordings of running sessions are left alone.
 */
function cleanUpRecordings() {
  const { dir, keepMs, maxTotalBytes } = config.recordings;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(VIDEO_SUFFIX));
  } catch {
    return; // nothing has been recorded yet
  }
  try {
    const files = names
      .map((name) => name.slice(0, -VIDEO_SUFFIX.length))
      .filter((id) => !live.has(id))
      .map((id) => ({ id, stats: fs.statSync(videoPath(id)) }))
      .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
    let total = files.reduce((sum, entry) => sum + entry.stats.size, 0);
    for (const { id, stats } of files) {
      const isExpired = Date.now() - stats.mtimeMs > keepMs;
      if (!isExpired && total <= maxTotalBytes) continue;
      fs.unlinkSync(videoPath(id));
      fs.rmSync(factsPath(id), { force: true });
      total -= stats.size;
      logger.info(`recording ${id} deleted (${isExpired ? 'older than the keeping time' : 'folder over its size limit'})`);
    }
  } catch (err) {
    logger.error(`recording cleanup failed: ${err.message}`);
  }
}

module.exports = { recorderFor, finishRecording, serveRecording, serveRecordingInfo, describeRecording, cleanUpRecordings, parseRange };
