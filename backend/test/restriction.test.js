'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedWhenRestricted } = require('../src/restriction');

test('lets ordinary use of the app through', () => {
  const allowed = [
    { t: 'touch', a: 'down', id: 0, x: 10, y: 10 },
    { t: 'touch', a: 'move', id: 0, x: 11, y: 10 },
    { t: 'scroll', x: 1, y: 1, dx: 0, dy: 1 },
    { t: 'text', text: 'wake up' },
    { t: 'key', a: 'down', key: 'Back' },
    { t: 'key', a: 'up', key: 'Enter' },
    { t: 'paste', text: 'label' },
    { t: 'copy' },
  ];
  for (const message of allowed) assert.equal(isAllowedWhenRestricted(message), true, JSON.stringify(message));
});

test('refuses the keys that leave an app', () => {
  assert.equal(isAllowedWhenRestricted({ t: 'key', a: 'down', key: 'Home' }), false);
  assert.equal(isAllowedWhenRestricted({ t: 'key', a: 'down', key: 'AppSwitch' }), false);
  assert.equal(isAllowedWhenRestricted({ t: 'key', a: 'down', key: 'Power' }), false);
  assert.equal(isAllowedWhenRestricted({ t: 'key', a: 'down' }), false);
});

test('refuses a second finger, which the unpin gesture needs', () => {
  assert.equal(isAllowedWhenRestricted({ t: 'touch', a: 'down', id: 1, x: 10, y: 10 }), false);
  assert.equal(isAllowedWhenRestricted({ t: 'touch', a: 'down', id: '0', x: 10, y: 10 }), false);
  assert.equal(isAllowedWhenRestricted({ t: 'touch', a: 'down', x: 10, y: 10 }), false);
});

test('refuses unknown message types and values that are not objects', () => {
  for (const message of [{ t: 'start-app', name: 'settings' }, { t: 'rotate' }, {}, null, 'key', 5, []]) {
    assert.equal(isAllowedWhenRestricted(message), false, JSON.stringify(message));
  }
});
