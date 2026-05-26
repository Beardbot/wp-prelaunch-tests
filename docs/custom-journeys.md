# Custom Journeys

Use a custom journey when the built-in templates don't cover a site's unique functionality — for example, an LMS course flow, a booking widget, a multi-step Gravity Forms sequence, or a bespoke WooCommerce add-on checkout.

## File location

```
journeys/custom/client-name.js
```

Reference in `sites.json`:

```json
"journeys": ["custom/client-name"]
```

## Contract

Every journey file must export a `run(site, context)` async function that returns `{ passed, failedStep, steps }`.

Use `createStepRunner` from `src/step.js` — it handles failure screenshots automatically.

## Template

```js
const { createStepRunner } = require('../../src/step');

async function run(site, context) {
  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Page loads', async () => {
      const response = await page.goto(site.url + '/your-page', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      if (!response || response.status() >= 400) {
        throw new Error(`HTTP ${response?.status()}`);
      }
    });

    await step('Key element visible', async () => {
      await page.locator('[data-wpt="your-element"]').waitFor({ timeout: 10000 });
    });

    await step('Action completes', async () => {
      await page.locator('[data-wpt="your-button"]').click();
      await page.getByText('Expected result text', { exact: false }).waitFor({ timeout: 10000 });
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
```

## Timing rules

- Use `waitFor()` / `getByRole()` — not `waitForTimeout()` — for element readiness
- Use `waitForLoadState('domcontentloaded')` for navigation
- Use `waitForResponse()` for AJAX-dependent content (filters, search results)
- Only use `waitForTimeout()` as a last resort, with a comment explaining why
- Default timeouts: 10s for element visibility, 30s for page loads

## Selector guidance

See [selectors.md](./selectors.md) for the full priority order. Short version:

1. `[data-wpt="..."]` — add via Elementor Advanced → Attributes
2. `page.getByLabel('Field Label')` — for form inputs
3. `page.getByRole('button', { name: 'Submit' })` — for interactive elements
4. Plugin-specific selectors — only if `data-wpt` is not practical
