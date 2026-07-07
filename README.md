# WP Pre-launch Tests

Pre-launch functional testing for WordPress/Elementor sites. Runs against staging environments at three build stages — feature complete, content complete, and pre-launch — using Playwright for journey automation and pixel-level visual diffing.

## Features

- **Journey templates** for common flows: contact form, search, login, WooCommerce add-to-cart/checkout, product/post filtering
- **Custom journeys** for unique per-site plugins (LMS, booking, Gravity Forms, etc.)
- **Visual diffing** — capture a baseline then compare on every test run
- **Link checker** and **console error detection** on every page
- **Email notifications** via SMTP, **Slack notifications** on failure
- **Webhook server** for triggering tests from a WordPress plugin or deploy script
- **Site importer** — crawls a sitemap and generates a `sites.json` entry automatically
- **Journey generator** — inspects a live staging site and generates `journeyOptions` config from its DOM
- **Production smoke checks** — post-launch page-load and console checks via `--production`
- **CI runs** — manually-triggered GitHub Actions workflow (weekly schedule disabled until there are launched sites worth monitoring)

## Requirements

- Node.js 18+
- Elementor Pro (for adding `data-wpt` attributes to interactive elements)

## Installation

```bash
npm install        # also installs Playwright's Chromium browser
npm link           # register global CLI commands (optional but recommended)
```

Copy the example config files:

```bash
cp .env.example .env
cp config/sites.example.json config/sites.json
```

Fill in `.env` with your SMTP credentials and webhook secret. Edit `config/sites.json` with your staging sites (or use `add-site` to generate entries automatically — see below).

## Usage

### With `npm link`

```bash
baseline                                  # capture baseline screenshots for all sites
baseline <key> [key2 ...]                 # capture baseline for one or more sites
prelaunch-test                            # run tests for all sites
prelaunch-test <key> [key2 ...]           # run tests for one or more sites
prelaunch-test [key ...] --production     # smoke-only checks against productionUrl
add-site <url> [url2 ...]                 # import one or more sites into sites.json
add-site <url> --dry-run                  # preview generated config without writing
generate-journey <key>                    # generate journeyOptions config from live DOM
generate-journey <key> --dry-run          # preview without writing
npm run server                            # start the optional webhook server
```

### Without `npm link`

```bash
npm run baseline -- <key>
npm run test -- <key>
npm run add-site -- <url>
```

## Workflow — Three Stage Gates

Tests are checkpoints during a build, not a one-off pre-launch step.

| Stage | When | What to run |
|---|---|---|
| **1 — Feature complete** | A feature is deployed to staging | `prelaunch-test <key>` — run the relevant journey(s) |
| **2 — Content complete** | Site is structurally finished, ready for review | `prelaunch-test <key>` — all journeys |
| **3 — Pre-launch** | Final sign-off | `baseline <key>` then `prelaunch-test <key>` — visual diff + all journeys |

A clean Stage 3 result is the go/no-go signal for launch.

## Adding a Site

```bash
add-site https://staging.example.com
```

This crawls the sitemap, detects WooCommerce, extracts pages, and writes a config entry to `sites.json`.

## Generating Journey Config

After `add-site`, run the journey generator to auto-populate `journeyOptions`:

```bash
generate-journey example-shop            # inspect live DOM and generate config
generate-journey example-shop --dry-run  # preview without writing
```

The generator opens the site in a headless browser, finds contact forms, search inputs, and login pages, and writes the appropriate `journeyOptions` directly into `sites.json`. No tokens are used for standard templates — the config is derived deterministically from the DOM.

If `data-wpt` elements are found that don't match any built-in template (e.g. an LMS, booking widget), the generator will note them. Set `ANTHROPIC_API_KEY` in `.env` to have it auto-generate a `journeys/custom/<key>.js` file for those elements using the Claude API.

## Running in CI

The [Scheduled site tests](.github/workflows/scheduled.yml) workflow is triggered manually from the GitHub Actions UI with an optional site key — no local setup required. The weekly schedule is intentionally disabled until there are launched sites worth monitoring: with an empty `sites.ci.json`, a scheduled run would test nothing yet report green. A run against an empty site list now fails loudly, so re-enabling the `schedule:` trigger later can never silently go green. It reads [`config/sites.ci.json`](config/sites.ci.json), a committed config with staging URLs only. Credentials come from repository secrets: `SMTP_*`, `SLACK_WEBHOOK_URL`, `TEST_CUSTOMER_EMAIL`, `TEST_CUSTOMER_PASSWORD`. HTML reports and failure screenshots are uploaded as a workflow artifact (30-day retention).

Deploy scripts can also trigger a run via the webhook server — see [`docs/workflow.md`](docs/workflow.md) for the post-deploy curl snippet.

## Notifications

- **Email** — set `notifications.email.enabled: true` in the config settings and fill the `SMTP_*` env vars. Sends on failure with a per-site breakdown.
- **Slack** — set `notifications.slack.enabled: true` and `SLACK_WEBHOOK_URL` (a Slack incoming webhook). Failure-only.

## Configuration — `config/sites.json`

Each entry in `sites` describes one staging site:

```json
{
  "name": "Example Shop",
  "key": "example-shop",
  "url": "https://staging.shop.example.com",
  "productionUrl": "https://shop.example.com",
  "pages": ["/", "/shop", "/contact"],
  "cookieBannerSelector": "[data-wpt='cookie-dismiss']",
  "journeys": ["templates/woocommerce", "templates/contact-form"],
  "auth": null,
  "journeyOptions": {
    "templates/woocommerce": {
      "shopPath": "/shop",
      "cartPath": "/cart",
      "checkoutPath": "/checkout"
    }
  }
}
```

See [`config/sites.example.json`](config/sites.example.json) for full examples including brochure and membership sites.

`productionUrl` is optional. When set, `prelaunch-test <key> --production` runs smoke-only checks (pages load, console clean) against the live site — functional journeys and visual diffs never run on production.

The `SITES_CONFIG` env var can point to a config file outside the project (e.g. a shared OneDrive folder):

```
SITES_CONFIG=C:\Users\You\OneDrive\wp-prelaunch\sites.json
```

## Outputs

| Path | Contents |
|---|---|
| `data/sites/{key}/baselines/` | Baseline screenshots |
| `data/sites/{key}/screenshots/` | Screenshots from the latest test run |
| `data/sites/{key}/diffs/` | Pixel diff images |
| `data/sites/{key}/failures/` | Failure screenshots captured by journey steps |
| `data/reports/report-*.html` | HTML test reports |
| `data/runs.db` | SQLite run history |

## Journey Templates

Built-in templates in `journeys/templates/`:

| Template | What it tests |
|---|---|
| `contact-form` | Fills and submits a contact form, asserts success text |
| `search` | Enters a search query, asserts minimum result count |
| `login` | Logs in with test customer credentials, asserts dashboard element |
| `woocommerce` | Adds a product to cart and proceeds through checkout |
| `smoke` | Page load and basic structure checks |
| `product-filter` | Applies a shop filter (AJAX or page reload), asserts results |
| `post-filter` | Applies a blog/archive filter, asserts posts appear |

## Custom Journeys

For unique per-site functionality, create `journeys/custom/client-name.js` and reference it in `sites.json` as `"custom/client-name"`.

Every custom journey exports a `run(site, context)` async function using `createStepRunner` from `src/step.js`:

```js
const { createStepRunner } = require('../../src/step');

async function run(site, context) {
  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Page loads', async () => {
      const response = await page.goto(site.url + '/your-page', { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status()}`);
    });

    await step('Key element visible', async () => {
      await page.locator('[data-wpt="your-element"]').waitFor({ timeout: 10000 });
    });
  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
```

See [`docs/custom-journeys.md`](docs/custom-journeys.md) for timing rules and full guidance.

## Selectors — `data-wpt` Attributes

Journey templates rely on `data-wpt` attributes for stable selectors that survive Elementor layout changes and plugin updates. Add them in **Elementor → Advanced → Attributes**.

**Selector priority order:**

1. `[data-wpt="..."]` — preferred
2. `page.getByRole(...)` — ARIA roles
3. `page.getByLabel(...)` — form fields
4. WooCommerce-owned classes
5. Plugin-specific IDs/classes
6. Elementor-generated classes — **avoid**

See [`docs/selectors.md`](docs/selectors.md) for the full convention and naming guide.

## Staging Environment Checklist

Before running tests, confirm:

- Payment gateway is in **test mode**
- CAPTCHA is **disabled** on contact forms
- A test product exists at a low price (WooCommerce)
- A test customer account exists (`testcustomer@youragency.com`)
- Cookie banner dismiss button has `[data-wpt="cookie-dismiss"]`
- Elementor entrance animations are disabled (or scroll effects will be handled automatically)

## Further Reading

- [`docs/workflow.md`](docs/workflow.md) — stage gates, how to add a test, staging checklist
- [`docs/selectors.md`](docs/selectors.md) — `data-wpt` convention, Elementor setup, selector priority
- [`docs/custom-journeys.md`](docs/custom-journeys.md) — writing custom journeys for unique per-site plugins
