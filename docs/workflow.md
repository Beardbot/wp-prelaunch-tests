# Developer Workflow — Pre-launch Stage Gates

Tests are run at three defined checkpoints during a new site build. Running tests is not a one-off event before launch — it is a checkpoint at each stage.

## Stage 1 — Feature complete (staging)

**When:** A feature is built and deployed to the staging environment.

**What to run:** The relevant journey(s) for that specific feature.

```bash
prelaunch-test my-client
```

**What to check:** The new journey passes. Fix any selector or flow issues before moving on.

**Common actions at this stage:**
- Add `data-wpt` attributes to new interactive elements in Elementor
- Add the journey to `sites.json` with the correct `journeyOptions`
- Fix any issues surfaced by the journey

---

## Stage 2 — Content complete (staging)

**When:** Content is populated, the site is structurally complete, and ready for final review.

**What to run:** All journeys for the site.

```bash
prelaunch-test my-client
```

**What to check:**
- All configured journeys pass
- No broken links
- No unexpected console errors
- Pages load within acceptable time

---

## Stage 3 — Pre-launch (staging)

**When:** Final sign-off before going live.

**What to run:** Full test run including a visual diff baseline capture.

```bash
# Capture the visual baseline
baseline my-client

# Do a final content/layout review

# Run tests — visual diff will compare against the baseline you just captured
prelaunch-test my-client
```

**What to check:**
- All journeys pass
- Visual diff is clean (no unexpected layout changes)
- Link checker shows no broken links
- Console errors are clean

A clean result here is the go/no-go signal for launch.

---

## Post-launch — production smoke (optional)

**When:** After go-live, to confirm the deploy; or weekly via CI for launched sites.

**What to run:** Smoke-only checks against the live site. Requires `productionUrl` in the site's config entry.

```bash
prelaunch-test my-client --production
```

This loads each configured page on the production URL and checks for console errors. **Functional journeys, form submissions, and visual diffs never run against production** — staging only.

For launched sites whose staging environment has been decommissioned, keep a config entry with `productionUrl` only and run `--production` checks on a schedule.

---

## Triggering tests from a deploy script

The webhook server (`npm run server`) accepts a post-deploy trigger. Add this to the end of your staging deploy script:

```bash
curl -s -X POST "https://your-test-host:3001/run" \
  -H "Content-Type: application/json" \
  -d "{\"secret\": \"$WP_PRELAUNCH_SECRET\", \"site\": \"my-client\"}"
```

The server responds immediately with `{"status": "accepted"}` and runs the tests in the background. Omit `site` to run all configured sites. `WP_PRELAUNCH_SECRET` must match the value in the test server's `.env`.

Tests can also be triggered from the GitHub Actions UI (the **Scheduled site tests** workflow has a manual `workflow_dispatch` trigger with an optional site key input) — no local setup needed.

---

## Adding a test for a new feature

1. Add `data-wpt` attributes to key interactive elements in Elementor (Advanced → Attributes)
2. Open `config/sites.json`, find the site entry
3. Standard scenarios (contact form, search, login, WooCommerce): add the template name to `journeys` and fill in `journeyOptions`
4. Unique plugins (LMS, booking, Gravity Forms with complex logic): create `journeys/custom/client-name.js`
5. Run `prelaunch-test <key>` and fix until green

## Adding a new site

```bash
add-site https://staging.example.com
```

This crawls the sitemap, detects WooCommerce, extracts pages, and writes a config entry to `sites.json`. Review the generated entry and add any additional journeys and `journeyOptions` manually.

## Maintenance-mode staging (wp-login auth)

Most staging sites are hidden behind an Elementor maintenance page — nothing is
visible without a logged-in WordPress session. Enable a login bootstrap so every
check (screenshots, links, console, journeys) runs as a logged-in visitor:

```json
{
  "key": "my-client",
  "url": "https://staging.my-client.com",
  "auth": { "type": "wp-login" }
}
```

- Optional `"loginPath"` overrides the default `/wp-login.php`.
- Credentials live in `.env`, never `sites.json`: `WP_LOGIN_USER` / `WP_LOGIN_PASSWORD`,
  with per-site overrides `WP_LOGIN_USER_<KEY>` / `WP_LOGIN_PASSWORD_<KEY>` (site key
  uppercased, hyphens/dots → underscores). This is a **WordPress user** whose role
  Elementor's maintenance mode lets through — not the WooCommerce test customer.
- The login happens once per site at the start of the run; cookies persist for the
  whole run via the single browser context.
- The WordPress admin bar is hidden automatically before every visual-diff
  screenshot, so logged-in runs and baselines are not polluted.
- If the login flag is absent the site runs anonymously, exactly as before. If the
  flag is set but login fails (bad/missing credentials, wrong `loginPath`), that
  site's run is marked failed with a clear error instead of silently capturing the
  maintenance page.
- `--production` smoke runs are always anonymous — `auth` is ignored there.

**Known limitations (not solved by this flag):**

- `add-site` fetches raw HTML and cannot authenticate, so on a maintenance-mode
  site it reads the maintenance page (wrong title, no nav, WooCommerce undetected).
  Enter the config for these sites manually.
- Logged-in sessions bypass WordPress page caching, so checks exercise the uncached
  path. Acceptable pre-launch, but worth knowing when comparing timings.
- A logged-out flow such as the `templates/login` journey cannot run on a
  maintenance-mode site: the maintenance bypass has already authenticated the
  session, so `/my-account` renders the account dashboard instead of a login form
  and the journey finds no fields to fill. Use `templates/smoke` (or a journey that
  assumes a logged-in user) for these sites. `TEST_CUSTOMER_*` credentials are not
  used when `wp-login` auth is enabled.

### Running the end-to-end check

A full run against a real maintenance-mode staging site is the acceptance test for
this feature. There is no site-URL env var — the URL lives in `sites.json` with the
rest of the site's config; `.env` only holds the credentials.

1. Add a site entry to `config/sites.json` with the `auth` flag and a couple of
   pages behind the maintenance page:

   ```json
   {
     "name": "My Client (staging)",
     "key": "my-client",
     "url": "https://staging.my-client.com",
     "pages": ["/", "/about"],
     "journeys": ["templates/login"],
     "auth": { "type": "wp-login" }
   }
   ```

2. Put the WordPress login (a user whose role Elementor's maintenance mode lets
   through) in `.env` — global vars, or per-site to match the key above:

   ```bash
   WP_LOGIN_USER_MY_CLIENT=staging-editor
   WP_LOGIN_PASSWORD_MY_CLIENT=...
   ```

3. Capture a baseline, then run the full suite:

   ```bash
   baseline my-client
   prelaunch-test my-client
   ```

**Expected:** the run authenticates once (`✓ Logged in — session active for this
run`), smoke + links + console + the login journey all pass, and the screenshots
under `data/sites/my-client/screenshots/` show the real pages with no admin bar. As
a control, temporarily remove the `auth` block and re-run — the same pages should
now capture only the maintenance page.

## Excluding elements from screenshots

Full-page screenshots capture `position: fixed` elements — most commonly an
Elementor **sticky header** — stamped into the middle of the page, which pollutes
baselines and produces false visual diffs. Hide such elements with
`screenshots.exclude_selectors`, an array of CSS selectors that are set to
`display: none` before every capture (baseline and test).

Configure it globally, per-site, or both — the lists are merged:

```json
{
  "sites": [
    {
      "key": "my-client",
      "url": "https://staging.my-client.com",
      "screenshots": { "exclude_selectors": [".site-specific-widget"] }
    }
  ],
  "settings": {
    "screenshots": {
      "exclude_selectors": ["header[data-elementor-type=\"header\"] .elementor-sticky"]
    }
  }
}
```

The Elementor sticky-header selector above is a sensible global default for
Elementor builds. Invalid selectors are logged as a warning and skipped rather
than failing the run. Selectors are applied right after page load, before the
scroll pass, so the sticky clone never forms.

## Staging environment checklist

Before running tests against a staging environment, confirm:

- Stripe (or payment gateway) is in **test mode**
- CAPTCHA is **disabled** on contact forms
- A test product exists at a low price (for WooCommerce journeys)
- A test customer account exists (`testcustomer@youragency.com`)
- Cookie consent banner has a `[data-wpt="cookie-dismiss"]` attribute on its dismiss button
- Elementor entrance animations are disabled (Elementor → Settings → Advanced → Disable scroll effects) — or leave enabled and rely on the scroll-then-screenshot behaviour
