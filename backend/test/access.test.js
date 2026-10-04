'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAccessCodeValid, isOriginAllowed } = require('../src/access');

test('accepts the right code and refuses wrong ones', () => {
  assert.equal(isAccessCodeValid('s3cret-code', 's3cret-code'), true);
  assert.equal(isAccessCodeValid('s3cret-code', 's3cret-cod'), false);
  assert.equal(isAccessCodeValid('s3cret-code', 's3cret-code '), false);
  assert.equal(isAccessCodeValid('s3cret-code', ''), false);
});

test('refuses values that are not strings', () => {
  for (const given of [null, undefined, 5, ['s3cret-code'], {}]) {
    assert.equal(isAccessCodeValid('s3cret-code', given), false);
  }
});

test('an empty configured code turns the check off', () => {
  assert.equal(isAccessCodeValid('', null), true);
  assert.equal(isAccessCodeValid('', 'anything'), true);
});

test('allows the page that was served from the same host', () => {
  assert.equal(isOriginAllowed('https://device.example.com', 'device.example.com'), true);
  assert.equal(isOriginAllowed('http://localhost:8080', 'localhost:8080'), true);
});

test('refuses other sites, other ports and malformed origins', () => {
  assert.equal(isOriginAllowed('https://evil.example', 'device.example.com'), false);
  assert.equal(isOriginAllowed('http://localhost:9999', 'localhost:8080'), false);
  assert.equal(isOriginAllowed('null', 'device.example.com'), false);
  assert.equal(isOriginAllowed('https://device.example.com', undefined), false);
});

test('allows requests with no Origin header (non-browser tools)', () => {
  assert.equal(isOriginAllowed(undefined, 'device.example.com'), true);
});
