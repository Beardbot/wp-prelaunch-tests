const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeRunId,
  RUN_ID_PATTERN,
  evaluatePreflight,
  journeyBlockReason,
  assembleEffects
} = require('../src/sensor-run');

// ─── makeRunId ───────────────────────────────────────────────────────────────

const FIXED_NOW = new Date(2026, 6, 29, 14, 5, 9); // 2026-07-29T14:05:09 local

test('run ids carry the site key, timestamp, and hex suffix', () => {
  const runId = makeRunId('test.beardbot.dev', FIXED_NOW, () => 0.5);
  assert.equal(runId, 'wpt_test_beardbot_dev_20260729T140509_800000');
});

test('run ids always satisfy the plugin validation pattern', () => {
  const keys = [
    'test.beardbot.dev',
    'UPPER.Case-Key',
    'çafé.ünïcode.example',
    '...',
    'a-very-long-hostname-that-goes-on-and-on.some-subdomain.example.com.au'
  ];
  for (const key of keys) {
    const runId = makeRunId(key, FIXED_NOW);
    assert.match(runId, RUN_ID_PATTERN, `run id for "${key}" must match: ${runId}`);
  }
});

test('a site key with no usable characters falls back to a placeholder', () => {
  assert.match(makeRunId('...', FIXED_NOW, () => 0), /^wpt_site_/);
});

// ─── evaluatePreflight ───────────────────────────────────────────────────────

function preflightFixture({ verdict = 'staging', checks = [] } = {}) {
  return {
    api_version: 1,
    environment: { wp_environment_type: 'staging', verdict, signals: [] },
    checks
  };
}

test('a staging verdict with all checks passing blocks nothing', () => {
  const policy = evaluatePreflight(preflightFixture({
    checks: [{ id: 'not_production', status: 'pass', detail: '' }]
  }), {});

  assert.equal(policy.blockAll, null);
  assert.equal(policy.paymentBlock, null);
  assert.deepEqual(policy.advisories, []);
});

test('a production verdict blocks all journeys with no override', () => {
  const policy = evaluatePreflight(
    preflightFixture({ verdict: 'production' }),
    { sensors: { allowUnknownEnvironment: true } }
  );

  assert.match(policy.blockAll, /production/);
});

test('an unknown verdict fails closed unless the site opts in', () => {
  const blocked = evaluatePreflight(preflightFixture({ verdict: 'unknown' }), {});
  assert.match(blocked.blockAll, /allowUnknownEnvironment/);

  const allowed = evaluatePreflight(
    preflightFixture({ verdict: 'unknown' }),
    { sensors: { allowUnknownEnvironment: true } }
  );
  assert.equal(allowed.blockAll, null);
});

test('a missing environment section is treated as unknown, not staging', () => {
  const policy = evaluatePreflight({ checks: [] }, {});
  assert.match(policy.blockAll, /unknown/);
});

test('a failing payment gateway check scopes to checkout journeys only', () => {
  const policy = evaluatePreflight(preflightFixture({
    checks: [{ id: 'payment_gateway_test_mode', status: 'fail', detail: 'Stripe is in live mode' }]
  }), {});

  assert.equal(policy.blockAll, null);
  assert.equal(policy.paymentBlock, 'Stripe is in live mode');
  assert.match(journeyBlockReason(policy, 'templates/woocommerce'), /Stripe is in live mode/);
  assert.match(journeyBlockReason(policy, 'custom/express-checkout'), /Stripe is in live mode/);
  assert.equal(journeyBlockReason(policy, 'templates/contact-form'), null);
  assert.equal(journeyBlockReason(policy, 'templates/search'), null);
});

test('non-blocking failed or unknown checks become advisories', () => {
  const policy = evaluatePreflight(preflightFixture({
    checks: [
      { id: 'not_production', status: 'pass', detail: '' },
      { id: 'payment_gateway_test_mode', status: 'unknown', detail: 'Unrecognised gateway' },
      { id: 'captcha_disabled', status: 'fail', detail: 'reCAPTCHA active on Contact' },
      { id: 'sitemap_present', status: 'pass', detail: '' },
      { id: 'test_product_exists', status: 'unknown', detail: 'WooCommerce inactive' }
    ]
  }), {});

  assert.deepEqual(policy.advisories.map(a => a.id), ['captcha_disabled', 'test_product_exists']);
  // unknown payment state is advisory-adjacent but never blocks
  assert.equal(policy.paymentBlock, null);
});

test('a sitewide block reason applies to every journey', () => {
  const policy = evaluatePreflight(preflightFixture({ verdict: 'production' }), {});
  assert.match(journeyBlockReason(policy, 'templates/search'), /Blocked by preflight/);
  assert.equal(journeyBlockReason(null, 'templates/search'), null);
});

// ─── assembleEffects ─────────────────────────────────────────────────────────

const passedContactForm = { name: 'templates/contact-form', passed: true, flaky: false };

test('all expected event types observed corroborates the journey', () => {
  const events = [
    { event_type: 'form_submission', provider: 'elementor_pro', summary: {} },
    { event_type: 'mail', provider: '', summary: {} }
  ];
  const effects = assembleEffects([passedContactForm], events);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].corroborated, true);
  assert.deepEqual(effects[0].missing, []);
  assert.deepEqual(effects[0].observed, [
    { event_type: 'form_submission', provider: 'elementor_pro', count: 1 },
    { event_type: 'mail', provider: null, count: 1 }
  ]);
});

test('a missing expected event type is a corroboration miss', () => {
  const events = [{ event_type: 'form_submission', provider: 'elementor_pro', summary: {} }];
  const effects = assembleEffects([passedContactForm], events);

  assert.equal(effects[0].corroborated, false);
  assert.deepEqual(effects[0].missing, ['mail']);
});

test('an empty events list is a miss on everything expected', () => {
  const effects = assembleEffects([passedContactForm], []);
  assert.equal(effects[0].corroborated, false);
  assert.deepEqual(effects[0].missing, ['form_submission', 'mail']);
});

test('failed journeys and unavailable events resolve to null, not a miss', () => {
  const failed = { name: 'templates/contact-form', passed: false, flaky: false };
  assert.equal(assembleEffects([failed], [])[0].corroborated, null);

  assert.equal(assembleEffects([passedContactForm], null)[0].corroborated, null);
});

test('journeys without expectations or that were blocked produce no entry', () => {
  const journeys = [
    { name: 'templates/search', passed: true },
    { name: 'templates/contact-form', passed: false, blocked: true }
  ];
  assert.deepEqual(assembleEffects(journeys, []), []);
});

test('repeated events are counted, not collapsed', () => {
  const events = [
    { event_type: 'mail', provider: '' },
    { event_type: 'mail', provider: '' },
    { event_type: 'form_submission', provider: 'elementor_pro' }
  ];
  const effects = assembleEffects([passedContactForm], events);
  const mail = effects[0].observed.find(o => o.event_type === 'mail');
  assert.equal(mail.count, 2);
});
