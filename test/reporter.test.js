const test = require('node:test');
const assert = require('node:assert/strict');
const { esc } = require('../src/reporter');

test('esc neutralises every HTML metacharacter', () => {
  assert.equal(
    esc(`<img src=x onerror="alert('1')" & more>`),
    '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot; &amp; more&gt;'
  );
});

test('esc passes plain strings through and stringifies non-strings', () => {
  assert.equal(esc('Contact page returned status 404'), 'Contact page returned status 404');
  assert.equal(esc(12.5), '12.5');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('a step error containing markup cannot escape its element', () => {
  // The realistic case this fixes: Playwright errors quote selectors, which
  // regularly contain angle brackets and quotes.
  const error = `locator('input[name="email"]') resolved to <input class="broken">`;
  const escaped = esc(error);
  assert.ok(!escaped.includes('<'));
  assert.ok(!escaped.includes('"'));
});
