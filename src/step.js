const fs = require('fs');
const path = require('path');

/**
 * Creates a step runner bound to a page and site key.
 * Each step captures a failure screenshot automatically.
 *
 * Usage:
 *   const { step, steps, getResult } = createStepRunner(page, site.key);
 *   await step('Page loads', async () => { ... });
 *   return getResult();
 */
function createStepRunner(page, siteKey) {
  const steps = [];
  let passed = true;
  let failedStep = null;

  async function step(name, fn) {
    if (!passed) return;
    try {
      await fn();
      steps.push({ name, status: 'pass' });
    } catch (err) {
      let screenshotPath = null;
      try {
        const failDir = path.join(__dirname, '..', 'data', 'sites', siteKey, 'failures');
        fs.mkdirSync(failDir, { recursive: true });
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        screenshotPath = path.join(failDir, `${Date.now()}-${slug}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch (_) {
        screenshotPath = null;
      }
      steps.push({ name, status: 'fail', error: err.message, screenshot: screenshotPath });
      passed = false;
      failedStep = `${name}: ${err.message}`;
    }
  }

  function getResult() {
    return { passed, failedStep, steps };
  }

  return { step, steps, getResult };
}

module.exports = { createStepRunner };
