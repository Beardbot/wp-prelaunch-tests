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
      failedStep: `Journey file not found: ${journeyPath}`,
      steps: []
    };
  }

  const journey = require(journeyPath);
  const result = await journey.run(site, context);
  return { name: journeyName, ...result };
}

module.exports = { runJourney };
