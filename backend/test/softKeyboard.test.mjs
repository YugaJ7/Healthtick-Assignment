import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTyping } from '../../frontend/input.mjs';

test('typing adds characters at the end', () => {
  assert.deepEqual(diffTyping('', 'h'), { backspaces: 0, text: 'h' });
  assert.deepEqual(diffTyping('hel', 'hello'), { backspaces: 0, text: 'lo' });
});

test('deleting removes characters from the end', () => {
  assert.deepEqual(diffTyping('hello', 'hell'), { backspaces: 1, text: '' });
  assert.deepEqual(diffTyping('hello', ''), { backspaces: 5, text: '' });
});

test('an autocorrected word is removed back to where it differs and typed again', () => {
  assert.deepEqual(diffTyping('teh', 'the '), { backspaces: 2, text: 'he ' });
  assert.deepEqual(diffTyping('wake up tomorow', 'wake up tomorrow'), { backspaces: 2, text: 'row' });
});

test('nothing changed means nothing to send', () => {
  assert.deepEqual(diffTyping('same', 'same'), { backspaces: 0, text: '' });
});

test('characters outside the basic plane count as one each', () => {
  assert.deepEqual(diffTyping('ok \u{1F600}', 'ok '), { backspaces: 1, text: '' });
  assert.deepEqual(diffTyping('', '\u{1F600}'), { backspaces: 0, text: '\u{1F600}' });
});
