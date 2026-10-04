'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const { logger } = require('./logger');
const { createRecorder } = require('./recorder');
const { sessionIdOf } = require('./sessionManager');

// Where recordings live and who may fetch them. A recording is named after its session's
// id, and is handed out only to someone who shows that session's secret token.

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const FILE_SUFFIX = '.mp4';

const pathOfId = (id) => path.join(config.recordings.dir, `${id}${FILE_SUFFIX}`);

/** @param {string} sessionId */
function startRecording(sessionId) {
  fs.mkdirSync(config.recordings.dir, { recursive: true, mode: 0o700 });
  return createRecorder({ filePath: pathOfId(sessionId), maxBytes: config.recordings.maxBytes, log: logger.info });
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

/**
 * Answers GET /recording?session=<token>[&download=1].
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {Record<string, string>} extraHeaders
 */
function serveRecording(req, res, params, extraHeaders) {
  const token = params.get('session') ?? '';
  const notFound = () => {
    res.writeHead(404, { 'content-type': 'text/plain', ...extraHeaders });
    res.end('no recording for this session');
  };
  if (!TOKEN_PATTERN.test(token)) return notFound();
  const id = sessionIdOf(token);
  fs.stat(pathOfId(id), (err, stats) => {
    if (err || stats.size === 0) return notFound();
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
    if (params.get('download') === '1') headers['content-disposition'] = `attachment; filename="session-${id}${FILE_SUFFIX}"`;
    res.writeHead(range ? 206 : 200, headers);
    fs.createReadStream(pathOfId(id), { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

/**
 * Deletes recordings older than the keeping time, then the oldest ones while the folder
 * is over its size limit. Recordings of running sessions are left alone.
 * @param {(sessionId: string) => boolean} isLive
 */
function cleanUpRecordings(isLive) {
  const { dir, keepMs, maxTotalBytes } = config.recordings;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(FILE_SUFFIX));
  } catch {
    return; // nothing has been recorded yet
  }
  try {
    const files = names
      .filter((name) => !isLive(name.slice(0, -FILE_SUFFIX.length)))
      .map((name) => ({ name, stats: fs.statSync(path.join(dir, name)) }))
      .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
    let total = files.reduce((sum, entry) => sum + entry.stats.size, 0);
    for (const { name, stats } of files) {
      const isExpired = Date.now() - stats.mtimeMs > keepMs;
      if (!isExpired && total <= maxTotalBytes) continue;
      fs.unlinkSync(path.join(dir, name));
      total -= stats.size;
      logger.info(`recording ${name} deleted (${isExpired ? 'older than the keeping time' : 'folder over its size limit'})`);
    }
  } catch (err) {
    logger.error(`recording cleanup failed: ${err.message}`);
  }
}

module.exports = { startRecording, serveRecording, cleanUpRecordings, parseRange };
