const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, isLocalHttpHost, siteFromInventory } = require('../src/site-importer');

// ─── normalizeUrl: the local-host http exception ─────────────────────────────

test('explicit http:// is honoured for local development hosts', () => {
  assert.equal(normalizeUrl('http://localhost:8890'), 'http://localhost:8890');
  assert.equal(normalizeUrl('http://127.0.0.1:8890'), 'http://127.0.0.1:8890');
  assert.equal(normalizeUrl('http://[::1]:8890'), 'http://[::1]:8890');
  assert.equal(normalizeUrl('http://mysite.test'), 'http://mysite.test');
  assert.equal(normalizeUrl('http://mysite.local'), 'http://mysite.local');
  assert.equal(normalizeUrl('http://app.localhost'), 'http://app.localhost');
});

test('explicit http:// on a real host is still coerced to https', () => {
  assert.equal(normalizeUrl('http://staging.client.com'), 'https://staging.client.com');
  // "test"/"local" must be the TLD, not merely part of the name.
  assert.equal(normalizeUrl('http://www.test.com'), 'https://www.test.com');
  assert.equal(normalizeUrl('http://mylocal.com'), 'https://mylocal.com');
});

test('bare hosts and https inputs behave as before', () => {
  assert.equal(normalizeUrl('staging.client.com'), 'https://staging.client.com');
  assert.equal(normalizeUrl('https://staging.client.com/'), 'https://staging.client.com');
  assert.equal(normalizeUrl('  https://x.com//  '), 'https://x.com');
  // A bare local-looking host still defaults to https — only an EXPLICIT
  // http:// expresses plain-HTTP intent.
  assert.equal(normalizeUrl('mysite.test'), 'https://mysite.test');
});

test('isLocalHttpHost edge cases', () => {
  assert.equal(isLocalHttpHost('[::1]'), true);
  assert.equal(isLocalHttpHost('LOCALHOST'), true);
  assert.equal(isLocalHttpHost('sub.mysite.test'), true);
  assert.equal(isLocalHttpHost('test.beardbot.dev'), false);
  assert.equal(isLocalHttpHost('127.0.0.2'), false);
});

// ─── siteFromInventory ───────────────────────────────────────────────────────

const inventoryFixture = {
  site: { name: 'Beardbot Test', url: 'https://test.beardbot.dev/', environment: 'production' },
  pages: [
    { id: 1, slug: 'shop', path: '/shop/', title: 'Shop', template: 'default' },
    { id: 2, slug: 'contact', path: '/contact/', title: 'Contact', template: 'default' }
  ],
  woocommerce: {
    active: true,
    paths: { shop: '/store/', cart: '/cart/' },
    test_product_candidates: [
      { id: 9, name: 'Test Product', slug: 'test-product', path: '/product/test-product/', price: '1' }
    ]
  }
};

test('siteFromInventory maps name, pages, product samples, and shop path', () => {
  const derived = siteFromInventory(inventoryFixture, new URL('https://test.beardbot.dev'));

  assert.equal(derived.name, 'Beardbot Test');
  assert.equal(derived.isWooCommerce, true);
  assert.equal(derived.shopPath, '/store/');
  assert.deepEqual(derived.pages, ['/', '/contact/', '/product/test-product/', '/shop/']);
});

test('siteFromInventory caps pages at 25 and product samples at 3', () => {
  const many = {
    site: { name: 'Big Site' },
    pages: Array.from({ length: 40 }, (_, i) => ({ path: `/page-${String(i).padStart(2, '0')}/` })),
    woocommerce: {
      active: true,
      paths: {},
      test_product_candidates: Array.from({ length: 5 }, (_, i) => ({ path: `/product/p${i}/` }))
    }
  };
  const derived = siteFromInventory(many, new URL('https://big.example.com'));

  assert.equal(derived.pages.filter(p => p.startsWith('/page-')).length, 25);
  assert.equal(derived.pages.filter(p => p.startsWith('/product/')).length, 3);
  assert.equal(derived.shopPath, '/shop/');
});

test('siteFromInventory tolerates a minimal non-woo inventory', () => {
  const derived = siteFromInventory({ site: {}, pages: [] }, new URL('https://www.plain.example.com'));

  assert.equal(derived.name, 'plain.example.com');
  assert.equal(derived.isWooCommerce, false);
  assert.deepEqual(derived.pages, ['/']);
});
