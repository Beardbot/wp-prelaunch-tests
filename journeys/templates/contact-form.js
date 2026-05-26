const { createStepRunner } = require('../../src/step');

async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/contact-form']) || {};
  const formPath = opts.path || '/contact';
  const fields = opts.fields || [];
  const submitSelector = opts.submitSelector || '[data-wpt="contact-form-submit"]';
  const successText = opts.successText || 'Thank you';

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Contact page loads', async () => {
      const response = await page.goto(site.url + formPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`Contact page returned status ${response?.status()}`);
    });

    for (const field of fields) {
      await step(`Fill field: ${field.label}`, async () => {
        const input = page.getByLabel(field.label, { exact: false });
        await input.waitFor({ timeout: 8000 });
        await input.fill(field.value);
      });
    }

    await step('Submit form', async () => {
      await page.locator(submitSelector).click();
    });

    await step('Success message appears', async () => {
      await page.getByText(successText, { exact: false }).waitFor({ timeout: 15000 });
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
