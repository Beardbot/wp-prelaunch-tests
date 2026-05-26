const { createStepRunner } = require('../../src/step');

/**
 * Smoke test: verifies that a list of pages load successfully (2xx status)
 * and render without a visible error message.
 *
 * Use this for pages not covered by other journey templates.
 *
 * journeyOptions:
 *   pages: ['/custom-page', '/another-page']  — defaults to site.pages if omitted
 *   errorSelector: '.error-404, .wp-die-message'  — default
 */
async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/smoke']) || {};
  const pages = opts.pages || site.pages || ['/'];
  const errorSelector = opts.errorSelector || '.error-404, .wp-die-message, #error-page';

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    for (const pagePath of pages) {
      await step(`${pagePath} loads`, async () => {
        const response = await page.goto(site.url + pagePath, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!response) throw new Error('No response received');
        if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
        const errorVisible = await page.locator(errorSelector).isVisible().catch(() => false);
        if (errorVisible) throw new Error('Error page detected');
      });
    }
  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
