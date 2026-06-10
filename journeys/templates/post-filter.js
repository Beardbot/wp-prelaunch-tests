const { createStepRunner } = require('../../src/step');

/**
 * Post filter test: applies a category/taxonomy filter on a blog or archive
 * page and asserts that posts appear. Handles both AJAX filtering (waits for
 * the filter request) and full-page-reload filtering.
 *
 * journeyOptions:
 *   path: '/blog'                                  — default; page with the filter
 *   filterSelector: '[data-wpt="post-filter"]'     — default; the filter control
 *   filterValue: 'News'                            — optional; option text for selects/term links
 *   resultSelector: 'article, .hentry'             — default
 *   minResults: 1                                  — default
 *   ajaxUrlPattern: 'admin-ajax\\.php'             — default; regex matched against request URLs
 */
async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/post-filter']) || {};
  const blogPath = opts.path || '/blog';
  const filterSelector = opts.filterSelector || '[data-wpt="post-filter"]';
  const filterValue = opts.filterValue || null;
  const resultSelector = opts.resultSelector || 'article, .hentry';
  const minResults = opts.minResults !== undefined ? opts.minResults : 1;
  const ajaxPattern = new RegExp(opts.ajaxUrlPattern || 'admin-ajax\\.php');

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Archive page loads with posts', async () => {
      const response = await page.goto(site.url + blogPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`Archive page returned status ${response?.status()}`);
      await page.locator(resultSelector).first().waitFor({ timeout: 10000 });
    });

    await step('Filter control visible', async () => {
      const filter = page.locator(filterSelector).first();
      await filter.scrollIntoViewIfNeeded();
      await filter.waitFor({ state: 'visible', timeout: 10000 });
    });

    await step('Apply filter', async () => {
      const filter = page.locator(filterSelector).first();
      // Resolves on the AJAX filter call; times out harmlessly for full-page-reload filters
      const ajaxResponse = page.waitForResponse(r => ajaxPattern.test(r.url()), { timeout: 10000 })
        .catch(() => null);

      const tag = await filter.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') {
        if (filterValue) {
          await filter.selectOption({ label: filterValue });
        } else {
          const values = await filter.locator('option').evaluateAll(
            options => options.filter(o => o.value !== '').map(o => o.value)
          );
          if (values.length === 0) throw new Error('Filter select has no available options');
          await filter.selectOption(values[0]);
        }
      } else if (filterValue) {
        const option = filter.getByText(filterValue, { exact: false }).first();
        if (await option.count() > 0) await option.click();
        else await filter.click();
      } else {
        await filter.click();
      }

      await ajaxResponse;
      await page.waitForLoadState('domcontentloaded');
    });

    await step('Filtered posts appear', async () => {
      if (minResults === 0) return;
      await page.locator(resultSelector).first().waitFor({ timeout: 10000 });
      const count = await page.locator(resultSelector).count();
      if (count < minResults) throw new Error(`Expected at least ${minResults} post(s) after filtering, found ${count}`);
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
