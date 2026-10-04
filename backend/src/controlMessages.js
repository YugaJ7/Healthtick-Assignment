'use strict';

// Turns input messages from the browser (JSON) into scrcpy control messages (binary).
// The browser never sends scrcpy bytes itself: only the message kinds below can reach
// the device, and every field is checked here, on the server.
// Byte layouts: scrcpy v4.1 ControlMessageReader.java and app/tests/test_control_msg_serialize.c.

const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH_EVENT = 2;
const TYPE_INJECT_SCROLL_EVENT = 3;
const TYPE_GET_CLIPBOARD = 8;
const TYPE_SET_CLIPBOARD = 9;

const KEYCODE_MESSAGE_BYTES = 14;
const TOUCH_MESSAGE_BYTES = 32;
const SCROLL_MESSAGE_BYTES = 21;
const TEXT_HEADER_BYTES = 5;

const CLIPBOARD_HEADER_BYTES = 14;
const COPY_KEY_COPY = 1; // ask the device to press "copy" before it reports its clipboard
const PASTE_AFTER_SET = 1;

const MAX_TEXT_BYTES = 300; // scrcpy's own limit for one text message
const MAX_CLIPBOARD_BYTES = 16 * 1024; // our limit; scrcpy itself allows about 256 KB
const MAX_POINTERS = 10;
const MAX_SCROLL = 16; // scrcpy encodes scroll amounts in the range [-16, 16]
const PRESSURE_FULL = 0xffff;
const I16_MAX = 0x7fff;
const I16_MIN = -0x8000;

// Android MotionEvent / KeyEvent action values.
const TOUCH_ACTIONS = new Map([['down', 0], ['up', 1], ['move', 2], ['cancel', 3]]);
const KEY_ACTIONS = new Map([['down', 0], ['up', 1]]);

// Android KeyEvent keycodes the browser may ask for. Anything else is refused.
const KEYCODES = new Map([
  ['Home', 3], ['Back', 4], ['AppSwitch', 187],
  ['Enter', 66], ['Backspace', 67], ['Delete', 112], ['Tab', 61], ['Escape', 111],
  ['ArrowUp', 19], ['ArrowDown', 20], ['ArrowLeft', 21], ['ArrowRight', 22],
  ['MoveHome', 122], ['MoveEnd', 123],
]);

class InputError extends Error {}

function requireInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requireFromMap(map, value, name) {
  const mapped = typeof value === 'string' ? map.get(value) : undefined;
  if (mapped === undefined) throw new InputError(`unknown ${name}`);
  return mapped;
}

// Writes scrcpy's Position: x i32, y i32, screen width u16, screen height u16.
// The size comes from the server's own record of the video size, not from the browser;
// scrcpy ignores events whose size does not match the current video.
function writePosition(buffer, offset, message, videoSize) {
  buffer.writeInt32BE(requireInteger(message.x, 0, videoSize.width - 1, 'x'), offset);
  buffer.writeInt32BE(requireInteger(message.y, 0, videoSize.height - 1, 'y'), offset + 4);
  buffer.writeUInt16BE(videoSize.width, offset + 8);
  buffer.writeUInt16BE(videoSize.height, offset + 10);
}

function encodeTouch(message, videoSize) {
  const action = requireFromMap(TOUCH_ACTIONS, message.a, 'touch action');
  const isPressed = message.a === 'down' || message.a === 'move';
  const buffer = Buffer.alloc(TOUCH_MESSAGE_BYTES); // action button and buttons stay 0: a finger, not a mouse
  buffer[0] = TYPE_INJECT_TOUCH_EVENT;
  buffer[1] = action;
  buffer.writeBigInt64BE(BigInt(requireInteger(message.id, 0, MAX_POINTERS - 1, 'pointer id')), 2);
  writePosition(buffer, 10, message, videoSize);
  buffer.writeUInt16BE(isPressed ? PRESSURE_FULL : 0, 22);
  return buffer;
}

function scrollToFixedPoint(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_SCROLL) {
    throw new InputError(`${name} must be a number from -${MAX_SCROLL} to ${MAX_SCROLL}`);
  }
  const scaled = Math.trunc((value / MAX_SCROLL) * 2 ** 15);
  return Math.max(I16_MIN, Math.min(I16_MAX, scaled));
}

function encodeScroll(message, videoSize) {
  const buffer = Buffer.alloc(SCROLL_MESSAGE_BYTES);
  buffer[0] = TYPE_INJECT_SCROLL_EVENT;
  writePosition(buffer, 1, message, videoSize);
  buffer.writeInt16BE(scrollToFixedPoint(message.dx, 'dx'), 13);
  buffer.writeInt16BE(scrollToFixedPoint(message.dy, 'dy'), 15);
  return buffer;
}

function encodeKey(message) {
  const buffer = Buffer.alloc(KEYCODE_MESSAGE_BYTES); // repeat and meta state stay 0
  buffer[0] = TYPE_INJECT_KEYCODE;
  buffer[1] = requireFromMap(KEY_ACTIONS, message.a, 'key action');
  buffer.writeInt32BE(requireFromMap(KEYCODES, message.key, 'key'), 2);
  return buffer;
}

function encodeText(message) {
  if (typeof message.text !== 'string' || message.text.length === 0) throw new InputError('text must be a non-empty string');
  const text = Buffer.from(message.text, 'utf8');
  if (text.length > MAX_TEXT_BYTES) throw new InputError(`text is longer than ${MAX_TEXT_BYTES} bytes`);
  const header = Buffer.alloc(TEXT_HEADER_BYTES);
  header[0] = TYPE_INJECT_TEXT;
  header.writeUInt32BE(text.length, 1);
  return Buffer.concat([header, text]);
}

// Sets the device clipboard to the text and pastes it into the focused field.
function encodePaste(message) {
  if (typeof message.text !== 'string' || message.text.length === 0) throw new InputError('text must be a non-empty string');
  const text = Buffer.from(message.text, 'utf8');
  if (text.length > MAX_CLIPBOARD_BYTES) throw new InputError(`clipboard text is longer than ${MAX_CLIPBOARD_BYTES} bytes`);
  const header = Buffer.alloc(CLIPBOARD_HEADER_BYTES); // the sequence number (bytes 1-8) stays 0: no acknowledgement wanted
  header[0] = TYPE_SET_CLIPBOARD;
  header[9] = PASTE_AFTER_SET;
  header.writeUInt32BE(text.length, 10);
  return Buffer.concat([header, text]);
}

// Asks the device to copy the current selection; it answers with a clipboard message.
function encodeCopy() {
  return Buffer.from([TYPE_GET_CLIPBOARD, COPY_KEY_COPY]);
}

/**
 * @param {unknown} message parsed JSON from the browser
 * @param {{ width: number, height: number } | null} videoSize current video size, null before the first frame
 * @returns {Buffer} one scrcpy control message
 * @throws {InputError} when the message is not one of the allowed kinds or a field is out of range
 */
function encodeClientMessage(message, videoSize) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) throw new InputError('message must be an object');
  if (message.t === 'key') return encodeKey(message);
  if (message.t === 'text') return encodeText(message);
  if (message.t === 'paste') return encodePaste(message);
  if (message.t === 'copy') return encodeCopy();
  if (message.t === 'touch' || message.t === 'scroll') {
    if (!videoSize) throw new InputError('no video yet');
    return message.t === 'touch' ? encodeTouch(message, videoSize) : encodeScroll(message, videoSize);
  }
  throw new InputError('unknown message type');
}

module.exports = { encodeClientMessage, InputError, MAX_TEXT_BYTES, MAX_CLIPBOARD_BYTES };
