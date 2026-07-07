const path = require('path');
const fs = require('fs');

function resolveJourneyPath(journeyName) {
  // Named prefixes: templates/ and custom/ map to subdirectories
  if (journeyName.startsWith('templates/') || journeyName.startsWith('custom/')) {
    return path.join(__dirname, '..', 'journeys', `${journeyName}.js`);
  }
  // Bare names (e.g. 'woocommerce') resolve to templates/ for backwards compatibility
  return path.join(__dirname, '..', 'journeys', 'templates', `${journeyName}.js`);
}

async function runJourney(journeyName, site, context) {
  const journeyPath = resolveJourneyPath(journeyName);

  if (!fs.existsSync(journeyPath)) {
    return {
      name: journeyName,
      passed: false,
      flaky: false,
      failedStep: `Journey file not found: ${journeyPath}`,
      steps: []
    };
  }

  const journey = require(journeyPath);

  // First attempt.
  const first = await journey.run(site, context);
  if (first.passed) {
    return { ...first, name: journeyName, flaky: false };
  }

  // One automatic retry. Journeys open their own page via context.newPage(), so
  // re-running run() gives a fresh page for free. A single timeout on a slow
  // staging host otherwise reads as a defect; one retry separates flake from a
  // real failure without masking a deterministic bug (which still fails twice).
  const retry = await journey.run(site, context);
  if (retry.passed) {
    // Passed only on the retry: a real pass, but flagged flaky so it is never
    // indistinguishable from a clean pass in any report or notification.
    return {
      ...retry,
      name: journeyName,
      flaky: true,
      firstAttemptFailure: first.failedStep
    };
  }

  // Failed on both attempts — a deterministic failure. Surface the retry result.
  return { ...retry, name: journeyName, flaky: false, retried: true };
}

module.exports = { runJourney };
