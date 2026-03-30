const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSlackTimestamp, resolveRedirectTarget } = require('../redirect.js');

test('normalizeSlackTimestamp converts Slack archive timestamps', () => {
  assert.equal(normalizeSlackTimestamp('1710500000123456'), '1710500000.123456');
  assert.equal(normalizeSlackTimestamp('1710500000'), '1710500000');
  assert.equal(normalizeSlackTimestamp(''), '');
});

test('resolveRedirectTarget handles app_redirect pages', () => {
  const result = resolveRedirectTarget('https://slack.com/app_redirect?channel=C123&team=T456', {});
  assert.deepEqual(result, {
    action: 'redirect',
    target: 'https://app.slack.com/client/T456/C123',
  });
});

test('resolveRedirectTarget handles archives pages with cached workspace mapping', () => {
  const result = resolveRedirectTarget(
    'https://acme.slack.com/archives/C123/p1710500000123456?thread_ts=1710500000.123456',
    { acme: 'T456' }
  );
  assert.deepEqual(result, {
    action: 'redirect',
    target: 'https://app.slack.com/client/T456/C123/1710500000.123456?thread_ts=1710500000.123456',
  });
});

test('resolveRedirectTarget blocks protocol launch when team mapping is missing', () => {
  const result = resolveRedirectTarget('https://acme.slack.com/archives/C123/p1710500000123456', {});
  assert.deepEqual(result, { action: 'block-protocol' });
});

test('resolveRedirectTarget ignores unrelated pages', () => {
  assert.equal(resolveRedirectTarget('https://app.slack.com/client/T123/C456', {}), null);
});
