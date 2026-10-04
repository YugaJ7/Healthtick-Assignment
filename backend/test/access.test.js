'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAccessCodeValid, isOriginAllowed, visitorAddress, securityHeaders } = require('../src/access');

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

test('takes the visitor address the web server wrote, not one the visitor sent', () => {
  assert.equal(visitorAddress('203.0.113.7'), '203.0.113.7');
  assert.equal(visitorAddress('10.0.0.1, 203.0.113.7'), '203.0.113.7');
  assert.equal(visitorAddress(' 2001:db8::1 '), '2001:db8::1');
});

test('a request without a forwarded address has no visitor address', () => {
  assert.equal(visitorAddress(undefined), null);
  assert.equal(visitorAddress(''), null);
  assert.equal(visitorAddress(['203.0.113.7']), null);
});

test('the content policy allows this site and its WebSocket only', () => {
  const policy = securityHeaders('device.example.com')['content-security-policy'];

  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /connect-src 'self' wss:\/\/device\.example\.com ws:\/\/device\.example\.com/);
  assert.doesNotMatch(policy, /unsafe/);
});

test('a malformed Host header cannot add anything to the content policy', () => {
  const policy = securityHeaders("evil.example; script-src *")['content-security-policy'];

  assert.match(policy, /connect-src 'self';/);
  assert.doesNotMatch(policy, /evil/);
});
