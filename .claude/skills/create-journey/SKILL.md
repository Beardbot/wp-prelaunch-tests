---
name: create-journey
description: >-
  Author a custom Playwright journey for the wp-prelaunch-tests tool from a
  plain-language description of a flow plus a site key or staging URL. Use this
  whenever a developer wants to add, write, generate, or scaffold a custom
  journey / test flow for a WordPress-Elementor staging site — e.g. "write a
  journey that tests the booking widget on staging-acme", "add a test for the
  LMS enrol flow", "I need a custom journey for the Gravity Forms quote
  request", or any per-site flow the built-in templates (contact-form, search,
  login, woocommerce, smoke, product-filter, post-filter) don't cover. Drives
  the browser to find real selectors, writes journeys/custom/<key>.js, wires it
  into sites.json, runs prelaunch-test, and iterates to green — then leaves the
  diff for the developer to review. Prefer this over hand-writing a journey from
  scratch or over any API-based generator.
---

# Create a custom journey

## What this is for

The built-in templates cover the common flows. Everything site-specific — an
LMS course enrolment, a booking widget, a multi-step Gravity Forms sequence, a
bespoke checkout add-on — needs a **custom journey**: a Playwright script at
`journeys/custom/<key>.js` that walks the flow and asserts it actually worked.

Writing one by hand means reading the conventions, hunting for stable selectors
on the live site, matching the file contract, wiring it into config, and
running it until it's green. This skill does that loop with you, and hands the
result back for your review before anything is committed. **A human reviewing
and committing the journey is the point, not an afterthought** — an unreviewed
journey that silently asserts nothing is worse than no journey at all.

## Inputs you need from the developer

1. **A plain-language description of the flow** — what a user does and, crucially,
   *how you'd know it worked* (the success signal: a confirmation message, a URL
   change, a cart count, an item appearing). If the success signal is missing,
   ask for it. A journey with no real assertion is the failure mode this whole
   tool exists to prevent.
2. **A site key** (preferred — it must already exist in the config; run
   `add-site <url>` first if not) **or a staging URL**.

## Step 0 — Orient in the repo

Read these before writing anything; they are the source of truth, so don't
reinvent their conventions from memory:

- `docs/custom-journeys.md` — the `run(site, context)` contract, the file
  skeleton, timing rules, and default timeouts.
- `docs/selectors.md` — the full selector priority order.
- One template as a live reference — `journeys/templates/contact-form.js` is the
  best model (loads a page, fills fields, submits, **asserts a success message**).
- `src/step.js` — `createStepRunner`, which every journey uses so failure
  screenshots are captured automatically.

Then read the site's entry. The config is `config/sites.json` unless
`SITES_CONFIG` in `.env` points elsewhere (it may live in a shared folder) —
check `.env` first, then read the entry for this key: note `url`, `pages`,
existing `journeys`, `journeyOptions`, `cookieBannerSelector`, and `auth`.

## Step 1 — Inspect the live site

You cannot pick reliable selectors from imagination. Look at the real DOM.

**Handle maintenance-mode auth first.** If the site entry has
`"auth": { "type": "wp-login" }`, the staging site is hidden behind an Elementor
maintenance page — every URL renders the maintenance screen until a WordPress
session is logged in. Before walking the flow, authenticate the browser session
by logging in at `<url>/wp-login.php` (or the entry's `loginPath`) with a
WordPress user whose role the maintenance mode lets through. This mirrors what
the tool does at runtime (`authenticateWpLogin` in `src/wp-login.js`); skip it
and you will only ever see the maintenance page. See `docs/workflow.md` →
"Maintenance-mode staging". Note its limitation: a *logged-out* flow (like the
`templates/login` journey) can't be exercised on a maintenance-gated site,
because the session is already authenticated — assume a logged-in user.

**With a browser available** (Chrome MCP or Playwright): open the staging URL,
dismiss the cookie banner if `cookieBannerSelector` is set, and walk the
described flow yourself — navigate, click, fill — confirming each element you
intend to target actually exists and is stable.

**Without a browser** (or as a quick first pass): run
`generate-journey <key> --dry-run`. Its deterministic inspector prints the forms,
inputs, and `data-wpt` elements it finds per page — enough to draft selectors.
Fill gaps by reading page HTML with a short headless script, or by asking the
developer for the specific selector/label of anything you can't see.

## Step 2 — Choose selectors that will survive

Follow the priority order from `docs/selectors.md`. In short:

1. `[data-wpt="..."]` — **strongly preferred.** Survives Elementor layout changes
   and plugin updates.
2. `page.getByRole('button', { name: '...' })` — ARIA roles.
3. `page.getByLabel('Field Label')` — form fields.
4. WooCommerce-owned classes, then plugin-specific IDs.
5. **Never** Elementor-generated classes (`.elementor-element-a1b2c3`) — they
   change on every re-publish and will make the journey flake.

If the flow depends on an element that has no stable hook, **don't fall back to a
brittle selector.** Note it in the handoff as a `data-wpt` attribute the
developer should add in Elementor (Advanced → Attributes) — that's the tool's
whole convention, and adding it at build time is the intended fix.

## Step 3 — Write `journeys/custom/<key>.js`

Match the contract exactly: export `async run(site, context)` returning
`getResult()` from a `createStepRunner`. Use the template skeleton from
`docs/custom-journeys.md`. Key points:

- One `step('...', async () => { ... })` per meaningful action, named for what it
  does — the name is what shows in the report and the failure screenshot.
- **Assert the success signal, not just presence.** Waiting for a button to be
  visible proves nothing; wait for the confirmation text, the URL change, the
  cart-count increment — the thing that proves the flow actually completed. Model
  it on contact-form.js's "Success message appears" step.
- Timing: use `waitFor()` / `getByRole()` / `waitForResponse()` for AJAX — never
  `waitForTimeout()` except as a commented last resort. Defaults: 10s for
  element visibility, 30s for page loads (per `docs/custom-journeys.md`).
- If any values are likely to change per environment (a path, expected text),
  read them from `site.journeyOptions['custom/<key>']` with sensible defaults, so
  the journey is tunable without editing code. Optional — hardcoding what you
  discovered is fine for a first version.

## Step 4 — Wire it in and run it

Add `"custom/<key>"` to the site entry's `journeys` array (de-duplicate), plus
any `journeyOptions` you introduced. Write to the same config file you read in
Step 0 (respect `SITES_CONFIG`).

Then run it:

```
prelaunch-test <key>
```

This runs the site's **full** suite (visual diff, links, console, and every
journey) — there is no single-journey filter flag yet. To iterate faster on just
the new journey, you can temporarily narrow the site's `journeys` array to
`["custom/<key>"]` while you work, then restore the full list before handoff.

Read the result in the console and in the generated HTML report under
`data/reports/`. Iterate on selectors and timing until the journey passes.

## Step 5 — Distinguish a flaky pass from a real one

The runner retries a failed journey once and labels a retry-only pass as
**flaky** ("passed on retry"). If your new journey only passes on the retry,
don't call it done — a flaky journey usually means a selector or a wait is
racing the page. Tighten it (wait for the right readiness signal) until it
passes cleanly on the first attempt.

## Step 6 — Hand off for review

**Leave the changes uncommitted.** Summarise for the developer:

- the flow the journey covers and the success signal it asserts;
- each selector used and why (especially any non-`data-wpt` fallback);
- any `data-wpt` attributes you recommend adding in Elementor to make it more
  robust;
- any assumptions or anything you couldn't verify on the live site.

The developer reviews the diff, adds any recommended attributes, and commits. If
`prelaunch-test` surfaced what looks like a **real site defect** (not a selector
problem), report it plainly rather than papering over it with a looser
assertion — catching that is the job.

## Guardrails

- Verify every selector against the live DOM; never invent one.
- Don't weaken an assertion to force a green run. A journey that passes without
  proving the flow worked is a false negative waiting to embarrass a launch.
- Keep the journey deterministic and self-contained (it opens and closes its own
  page via `context.newPage()` / `page.close()`).
- Don't commit. The developer owns the review and the commit.
