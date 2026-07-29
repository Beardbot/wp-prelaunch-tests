const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { envKeySuffix, envForSite } = require('../src/env-credentials');

beforeEach(() => {
  delete process.env.TEST_CRED_NAME;
  delete process.env.TEST_CRED_NAME_TEST_BEARDBOT_DEV;
});

test('envKeySuffix mangles every non-alphanumeric to underscore and uppercases', () => {
  assert.equal(envKeySuffix('test.beardbot.dev'), 'TEST_BEARDBOT_DEV');
  assert.equal(envKeySuffix('example-shop'), 'EXAMPLE_SHOP');
  assert.equal(envKeySuffix('a.b-c_d'), 'A_B_C_D');
});

test('per-site override wins over the global fallback', () => {
  process.env.TEST_CRED_NAME = 'global-value';
  process.env.TEST_CRED_NAME_TEST_BEARDBOT_DEV = 'site-value';

  const resolved = envForSite('test.beardbot.dev', 'TEST_CRED_NAME');
  assert.equal(resolved.value, 'site-value');
});

test('global fallback applies when no per-site override exists', () => {
  process.env.TEST_CRED_NAME = 'global-value';

  const resolved = envForSite('test.beardbot.dev', 'TEST_CRED_NAME');
  assert.equal(resolved.value, 'global-value');
});

test('resolution reports the exact env var names for error messages', () => {
  const resolved = envForSite('test.beardbot.dev', 'TEST_CRED_NAME');

  assert.equal(resolved.value, undefined);
  assert.equal(resolved.perSiteName, 'TEST_CRED_NAME_TEST_BEARDBOT_DEV');
  assert.equal(resolved.globalName, 'TEST_CRED_NAME');
  assert.equal(resolved.suffix, 'TEST_BEARDBOT_DEV');
});
