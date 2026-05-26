const { createStepRunner } = require('../../src/step');

async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/search']) || {};
  const query = opts.query || 'test';
  const minResults = opts.minResults !== undefined ? opts.minResults : 1;

  // Either navigate to a search URL directly, or use a form on a page
  const searchUrl = opts.searchUrl || `${site.url}/?s=${encodeURIComponent(query)}`;
  const formPath = opts.formPath || null;
  const formSelector = opts.formSelector || '[data-wpt="search-input"], input[type="search"], input[name="s"]';
  const resultSelector = opts.resultSelector || '.search-results article, .search-result, .hentry';

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    if (formPath) {
      await step('Page with search form loads', async () => {
        const response = await page.goto(site.url + formPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!response || response.status() >= 400) throw new Error(`Page returned status ${response?.status()}`);
        await page.locator(formSelector).first().waitFor({ timeout: 8000 });
      });

      await step('Enter search query', async () => {
        await page.locator(formSelector).first().fill(query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
      });
    } else {
      await step('Navigate to search results', async () => {
        const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!response || response.status() >= 400) throw new Error(`Search page returned status ${response?.status()}`);
      });
    }

    await step('Search results appear', async () => {
      if (minResults === 0) return;
      await page.locator(resultSelector).first().waitFor({ timeout: 10000 });
      const count = await page.locator(resultSelector).count();
      if (count < minResults) throw new Error(`Expected at least ${minResults} result(s), found ${count}`);
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
