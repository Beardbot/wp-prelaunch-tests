const { createStepRunner } = require('../../src/step');
const { envForSite } = require('../../src/env-credentials');

async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/login']) || {};
  const loginPath = opts.loginPath || '/my-account';
  const successPath = opts.successPath || '/my-account';
  const successSelector = opts.successSelector || '[data-wpt="member-dashboard"], .woocommerce-MyAccount-navigation, .wc-block-customer-account';

  // Credentials from env — per-site override first, then global fallback
  const email = envForSite(site.key, 'TEST_CUSTOMER_EMAIL').value;
  const password = envForSite(site.key, 'TEST_CUSTOMER_PASSWORD').value;

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Login page loads', async () => {
      const response = await page.goto(site.url + loginPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`Login page returned status ${response?.status()}`);
    });

    await step('Fill login credentials', async () => {
      if (!email || !password) throw new Error('TEST_CUSTOMER_EMAIL and TEST_CUSTOMER_PASSWORD must be set in .env');
      await page.getByLabel(/username|email/i, { exact: false }).first().fill(email);
      await page.getByLabel(/password/i, { exact: false }).first().fill(password);
    });

    await step('Submit login form', async () => {
      await page.getByRole('button', { name: /log in|sign in/i }).click();
      await page.waitForLoadState('domcontentloaded');
    });

    await step('Dashboard or member area loads', async () => {
      // Confirm we're on the expected page and not back on the login form
      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('wp-login')) {
        throw new Error('Still on login page after submit — credentials may be wrong');
      }
      await page.locator(successSelector).first().waitFor({ timeout: 10000 });
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
