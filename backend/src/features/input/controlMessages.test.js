'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeClientMessage, InputError, MAX_TEXT_BYTES, MAX_CLIPBOARD_BYTES } = require('./controlMessages');

const VIDEO = { width: 1080, height: 1920 };
const hex = (buffer) => buffer.toString('hex');

// Expected bytes follow scrcpy's own test vectors (app/tests/test_control_msg_serialize.c),
// with the mouse-button fields set to 0 because we inject fingers.
test('encodes a touch down like scrcpy does', () => {
  const buffer = encodeClientMessage({ t: 'touch', a: 'down', id: 3, x: 100, y: 200 }, VIDEO);

  assert.equal(buffer.length, 32);
  assert.equal(hex(buffer), [
    '02', '00',
    '0000000000000003',
    '00000064', '000000c8',
    '0438', '0780',
    'ffff',
    '00000000', '00000000',
  ].join(''));
});

test('sends zero pressure on up and cancel', () => {
  const up = encodeClientMessage({ t: 'touch', a: 'up', id: 0, x: 1, y: 1 }, VIDEO);
  const cancel = encodeClientMessage({ t: 'touch', a: 'cancel', id: 0, x: 1, y: 1 }, VIDEO);

  assert.equal(up[1], 1);
  assert.equal(up.readUInt16BE(22), 0);
  assert.equal(cancel[1], 3);
  assert.equal(cancel.readUInt16BE(22), 0);
});

test('takes the screen size from the server, never from the browser', () => {
  const buffer = encodeClientMessage({ t: 'touch', a: 'move', id: 0, x: 5, y: 5, w: 1, h: 1, width: 1, height: 1 }, VIDEO);

  assert.equal(buffer.readUInt16BE(18), 1080);
  assert.equal(buffer.readUInt16BE(20), 1920);
});

test('encodes a scroll like scrcpy does', () => {
  const buffer = encodeClientMessage({ t: 'scroll', x: 260, y: 1026, dx: 16, dy: -16 }, VIDEO);

  assert.equal(buffer.length, 21);
  assert.equal(hex(buffer), ['03', '00000104', '00000402', '0438', '0780', '7fff', '8000', '00000000'].join(''));
});

test('encodes one wheel notch as one sixteenth of the range', () => {
  const buffer = encodeClientMessage({ t: 'scroll', x: 0, y: 0, dx: 0, dy: 1 }, VIDEO);

  assert.equal(buffer.readInt16BE(13), 0);
  assert.equal(buffer.readInt16BE(15), 2048);
});

test('encodes an allowed key', () => {
  const buffer = encodeClientMessage({ t: 'key', a: 'down', key: 'Back' });

  assert.equal(hex(buffer), ['00', '00', '00000004', '00000000', '00000000'].join(''));
  assert.equal(encodeClientMessage({ t: 'key', a: 'up', key: 'Enter' }).readInt32BE(2), 66);
});

test('encodes text as UTF-8 with a 4-byte length', () => {
  const buffer = encodeClientMessage({ t: 'text', text: 'hé' });

  assert.equal(hex(buffer), '01' + '00000003' + '68c3a9');
});

test('refuses touches outside the video', () => {
  for (const point of [{ x: 1080, y: 0 }, { x: 0, y: 1920 }, { x: -1, y: 0 }, { x: 1.5, y: 0 }, { x: '5', y: 0 }]) {
    assert.throws(() => encodeClientMessage({ t: 'touch', a: 'down', id: 0, ...point }, VIDEO), InputError);
  }
});

test('refuses touch and scroll before the video size is known', () => {
  assert.throws(() => encodeClientMessage({ t: 'touch', a: 'down', id: 0, x: 0, y: 0 }, null), /no video yet/);
  assert.throws(() => encodeClientMessage({ t: 'scroll', x: 0, y: 0, dx: 0, dy: 1 }, null), /no video yet/);
});

test('refuses unknown actions, pointer ids, keys and message types', () => {
  const bad = [
    { t: 'touch', a: 'hover', id: 0, x: 0, y: 0 },
    { t: 'touch', a: 'down', id: 10, x: 0, y: 0 },
    { t: 'touch', a: 'down', id: -1, x: 0, y: 0 },
    { t: 'key', a: 'down', key: 'Power' },
    { t: 'key', a: 'down', key: 26 },
    { t: 'key', a: 'hold', key: 'Back' },
    { t: 'scroll', x: 0, y: 0, dx: 0, dy: 17 },
    { t: 'scroll', x: 0, y: 0, dx: NaN, dy: 0 },
    { t: 'clipboard', text: 'x' },
    { t: 9 },
    {},
  ];
  for (const message of bad) assert.throws(() => encodeClientMessage(message, VIDEO), InputError, JSON.stringify(message));
});

test('refuses values that are not objects', () => {
  for (const value of [null, 'touch', 5, [], undefined]) {
    assert.throws(() => encodeClientMessage(value, VIDEO), InputError);
  }
});

test('encodes a paste like scrcpy does (set clipboard, then paste)', () => {
  const buffer = encodeClientMessage({ t: 'paste', text: 'hello, world!' });

  assert.equal(buffer.length, 27);
  assert.equal(hex(buffer), ['09', '0000000000000000', '01', '0000000d', Buffer.from('hello, world!').toString('hex')].join(''));
});

test('paste keeps non-English text as UTF-8', () => {
  const buffer = encodeClientMessage({ t: 'paste', text: 'नमस्ते' });

  assert.equal(buffer.readUInt32BE(10), Buffer.byteLength('नमस्ते'));
  assert.equal(buffer.subarray(14).toString('utf8'), 'नमस्ते');
});

test('refuses empty, non-string and over-long paste text', () => {
  assert.throws(() => encodeClientMessage({ t: 'paste', text: '' }), InputError);
  assert.throws(() => encodeClientMessage({ t: 'paste', text: null }), InputError);
  assert.throws(() => encodeClientMessage({ t: 'paste', text: 'a'.repeat(MAX_CLIPBOARD_BYTES + 1) }), InputError);
});

test('encodes a copy request (get clipboard with the copy key)', () => {
  assert.equal(hex(encodeClientMessage({ t: 'copy' })), '0801');
});

test('refuses empty, non-string and over-long text', () => {
  assert.throws(() => encodeClientMessage({ t: 'text', text: '' }), InputError);
  assert.throws(() => encodeClientMessage({ t: 'text', text: 5 }), InputError);
  assert.throws(() => encodeClientMessage({ t: 'text', text: 'a'.repeat(MAX_TEXT_BYTES + 1) }), InputError);
  assert.equal(encodeClientMessage({ t: 'text', text: 'a'.repeat(MAX_TEXT_BYTES) }).length, 5 + MAX_TEXT_BYTES);
});
