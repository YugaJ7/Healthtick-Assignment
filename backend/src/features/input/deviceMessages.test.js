'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceMessageParser, MAX_CLIPBOARD_BYTES } = require('./deviceMessages');

function clipboardMessage(text) {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

const ACK = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 7]);
const UHID = Buffer.from([2, 0, 1, 0, 3, 0xaa, 0xbb, 0xcc]);

test('reads clipboard text, including non-English characters', () => {
  const events = createDeviceMessageParser().push(clipboardMessage('नमस्ते hello'));

  assert.deepEqual(events, [{ type: 'clipboard', text: 'नमस्ते hello' }]);
});

test('skips acknowledgements and UHID output between clipboard messages', () => {
  const stream = Buffer.concat([ACK, clipboardMessage('one'), UHID, clipboardMessage('two')]);

  const events = createDeviceMessageParser().push(stream);

  assert.deepEqual(events.map((e) => e.text), ['one', 'two']);
});

test('gives the same result when the bytes arrive one at a time', () => {
  const stream = Buffer.concat([clipboardMessage('héllo'), ACK, clipboardMessage('')]);
  const parser = createDeviceMessageParser();
  const events = [];
  for (const byte of stream) events.push(...parser.push(Buffer.from([byte])));

  assert.deepEqual(events.map((e) => e.text), ['héllo', '']);
});

test('throws on an unknown message type', () => {
  assert.throws(() => createDeviceMessageParser().push(Buffer.from([9, 0, 0])), /unknown device message type/);
});

test('throws when the clipboard claims to be larger than the limit', () => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(MAX_CLIPBOARD_BYTES + 1, 1);

  assert.throws(() => createDeviceMessageParser().push(header), /exceeds the limit/);
});
