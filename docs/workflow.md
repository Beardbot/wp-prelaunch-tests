# Developer Workflow — Pre-launch Stage Gates

Tests are run at three defined checkpoints during a new site build. Running tests is not a one-off event before launch — it is a checkpoint at each stage.

## Stage 1 — Feature complete (staging)

**When:** A feature is built and deployed to the staging environment.

**What to run:** The relevant journey(s) for that specific feature.

```bash
test my-client
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
test my-client
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
test my-client
```

**What to check:**
- All journeys pass
- Visual diff is clean (no unexpected layout changes)
- Link checker shows no broken links
- Console errors are clean

A clean result here is the go/no-go signal for launch.

---

## Adding a test for a new feature

1. Add `data-wpt` attributes to key interactive elements in Elementor (Advanced → Attributes)
2. Open `config/sites.json`, find the site entry
3. Standard scenarios (contact form, search, login, WooCommerce): add the template name to `journeys` and fill in `journeyOptions`
4. Unique plugins (LMS, booking, Gravity Forms with complex logic): create `journeys/custom/client-name.js`
5. Run `test <key>` and fix until green

## Adding a new site

```bash
add-site https://staging.example.com
```

This crawls the sitemap, detects WooCommerce, extracts pages, and writes a config entry to `sites.json`. Review the generated entry and add any additional journeys and `journeyOptions` manually.

## Staging environment checklist

Before running tests against a staging environment, confirm:

- Stripe (or payment gateway) is in **test mode**
- CAPTCHA is **disabled** on contact forms
- A test product exists at a low price (for WooCommerce journeys)
- A test customer account exists (`testcustomer@youragency.com`)
- Cookie consent banner has a `[data-wpt="cookie-dismiss"]` attribute on its dismiss button
- Elementor entrance animations are disabled (Elementor → Settings → Advanced → Disable scroll effects) — or leave enabled and rely on the scroll-then-screenshot behaviour
