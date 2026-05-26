const ignoredErrorPatterns = [
  'google-analytics',
  'googletagmanager',
  'hotjar',
  'fonts.gstatic',
  'gravatar',
  'recaptcha',
  'maps.google.com',
  'iq.afterpay.com',
  'm.stripe.network',
  'stripecdn.com',
  'cash-f.squarecdn.com',
  'paypal.com/graphql?getapplepayconfig',
  'paypal.com/xoplatform/logger',
  'report-only content security policy directive: "frame-ancestors \'self\'"'
];

function shouldIgnoreError(text) {
  return ignoredErrorPatterns.some(pattern => text.toLowerCase().includes(pattern));
}

async function checkConsoleErrors(context, site, timeout = 15000) {
  const results = [];

  for (const pagePath of site.pages) {
    const url = site.url + pagePath;
    const errors = [];
    const warnings = [];
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!shouldIgnoreError(text)) errors.push({ type: 'console-error', text });
      } else if (msg.type() === 'warning') {
        warnings.push({ type: 'console-warning', text: msg.text() });
      }
    });

    page.on('pageerror', err => {
      errors.push({ type: 'page-error', text: err.message });
    });

    page.on('requestfailed', request => {
      const reqUrl = request.url();
      if (!shouldIgnoreError(reqUrl)) {
        errors.push({ type: 'request-failed', text: `Failed to load: ${reqUrl}` });
      }
    });

    try {
      await page.goto(url, { waitUntil: 'load', timeout });
    } catch (err) {
      errors.push({ type: 'load-error', text: err.message });
    } finally {
      await page.close();
    }

    results.push({ page: pagePath, url, errors, warnings });
  }

  return results;
}

module.exports = { checkConsoleErrors };
