'use strict';

// Minimal logger: one line per event with a UTC timestamp, to stdout or stderr.
// systemd / Docker collect these streams, so no log files are managed here.

function write(stream, level, message) {
  stream.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

const logger = Object.freeze({
  info: (message) => write(process.stdout, 'INFO', message),
  error: (message) => write(process.stderr, 'ERROR', message),
});

module.exports = { logger };
