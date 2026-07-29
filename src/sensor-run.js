'use strict';

// Pure logic for the orchestrator's sensor integration: run-id minting,
// preflight policy, and effect corroboration. Lives outside orchestrator.js
// (which reads sites.json at require time) so it is unit-testable.
//
// Policy lives HERE, runner-side, on purpose: the plugin's preflight route
// only reports check results — which checks block a run is decided in this
// file, so policy changes never require redeploying PHP to client sites.

// ─── Run IDs ─────────────────────────────────────────────────────────────────

// The plugin's Recorder validates run ids against ^[A-Za-z0-9_-]{8,64}$ and
// silently records nothing on a mismatch — so the format here must always
// satisfy it, for any site key.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function makeRunId(siteKey, now = new Date(), random = Math.random) {
  // 32 chars keeps the total ≤ 59 even before the pattern's own 64 cap.
  const mangledKey = String(siteKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    || 'site';

  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const suffix = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');

  return `wpt_${mangledKey}_${stamp}_${suffix}`;
}

// ─── Preflight policy ────────────────────────────────────────────────────────

// The two checks that can block journeys. Everything else the preflight
// reports is advisory: surfaced in the report and console, never gating.
const BLOCKING_CHECK_IDS = new Set(['not_production', 'payment_gateway_test_mode']);

// Turn one preflight response into the runner's policy for this run.
//
// - verdict "production": journeys would write to a live site — block them
//   all and fail the site. No override exists by design.
// - verdict anything but "staging": fail closed (block all) unless the site
//   opts in via sensors.allowUnknownEnvironment.
// - payment_gateway_test_mode failing: a real-money gateway is live — block
//   only the journeys that can reach a checkout.
function evaluatePreflight(preflight, site) {
  const environment = preflight.environment || {};
  const verdict = environment.verdict || 'unknown';
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];

  let blockAll = null;
  if (verdict === 'production') {
    blockAll = 'the environment verdict is "production" — journeys would write to a live site';
  } else if (verdict !== 'staging' && !(site.sensors && site.sensors.allowUnknownEnvironment)) {
    blockAll = `the environment verdict is "${verdict}" — set sensors.allowUnknownEnvironment ` +
      'in the site config to run journeys anyway';
  }

  const payment = checks.find(c => c.id === 'payment_gateway_test_mode');
  const paymentBlock = payment && payment.status === 'fail' ? payment.detail : null;

  const advisories = checks.filter(c => c.status !== 'pass' && !BLOCKING_CHECK_IDS.has(c.id));

  return { verdict, blockAll, paymentBlock, advisories };
}

// The block reason for one journey under a policy, or null when it may run.
// The payment block is scoped to journeys that can reach a checkout.
function journeyBlockReason(policy, journeyName) {
  if (!policy) return null;
  if (policy.blockAll) {
    return `Blocked by preflight: ${policy.blockAll}`;
  }
  if (policy.paymentBlock) {
    const name = String(journeyName).toLowerCase();
    if (name.includes('woocommerce') || name.includes('checkout')) {
      return `Blocked by preflight: a payment gateway is in live mode — ${policy.paymentBlock}`;
    }
  }
  return null;
}

// ─── Effect corroboration ────────────────────────────────────────────────────

// Which server-side effects each journey template is expected to cause.
// Journeys not listed here are never corroborated (nothing server-side is
// expected of a search or a smoke check).
const EFFECT_EXPECTATIONS = {
  'templates/contact-form': ['form_submission', 'mail']
};

// Build the per-journey effects entries from the run's recorded events.
//
// corroborated is a tri-state: true (every expected event type observed),
// false (journey passed in the browser but an expected effect is missing —
// the discrepancy this whole feature exists to catch), or null (nothing to
// judge: the journey was blocked/failed, or events could not be fetched).
// Events are per-run, not per-journey, so two journeys expecting the same
// event type would share observations — fine for v1's expectation map.
function assembleEffects(journeys, events) {
  const effects = [];

  for (const journey of journeys || []) {
    const expected = EFFECT_EXPECTATIONS[journey.name];
    if (!expected || journey.blocked) continue;

    if (!journey.passed) {
      effects.push({
        journey: journey.name, expected, observed: [],
        corroborated: null, note: 'journey failed — corroboration not applicable'
      });
      continue;
    }
    if (events === null) {
      effects.push({
        journey: journey.name, expected, observed: [],
        corroborated: null, note: 'sensor events unavailable'
      });
      continue;
    }

    const observed = summarizeObserved(events, expected);
    const observedTypes = new Set(events.map(e => e.event_type));
    const missing = expected.filter(type => !observedTypes.has(type));

    effects.push({
      journey: journey.name, expected, observed,
      corroborated: missing.length === 0, missing
    });
  }

  return effects;
}

// Group the relevant events as [{event_type, provider, count}] for display.
function summarizeObserved(events, expected) {
  const groups = new Map();
  for (const event of events) {
    if (!expected.includes(event.event_type)) continue;
    const key = `${event.event_type}|${event.provider || ''}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => {
    const [eventType, provider] = key.split('|');
    return { event_type: eventType, provider: provider || null, count };
  });
}

module.exports = {
  makeRunId,
  RUN_ID_PATTERN,
  evaluatePreflight,
  journeyBlockReason,
  assembleEffects,
  EFFECT_EXPECTATIONS
};
