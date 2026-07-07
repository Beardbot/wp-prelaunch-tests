# WP Pre-launch Tests

Pre-launch functional testing for WordPress/Elementor sites. Tests run against staging environments at three build stages: feature complete, content complete, and pre-launch.

## Essential Commands

Run `npm link` once to register the global CLI commands.

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

Without `npm link`:

```bash
npm run baseline -- <key>
npm run test -- <key>
npm run add-site -- <url>
```

## Runtime Outputs

- Baselines: `data/sites/{site-key}/baselines/`
- Test screenshots: `data/sites/{site-key}/screenshots/`
- Diff images: `data/sites/{site-key}/diffs/`
- Failure screenshots: `data/sites/{site-key}/failures/`
- HTML reports: `data/reports/report-*.html`
- Run history: `data/runs.db`

## Project Notes

- Default config: `config/sites.json` (gitignored). Template: `config/sites.example.json`.
- CI config: `config/sites.ci.json` (committed — staging URLs only, never credentials).
- `SITES_CONFIG` env var can point to a config file outside the project directory.
- `productionUrl` site field enables `--production` smoke-only runs. Journeys and visual diffs never run against production.
- `"auth": { "type": "wp-login" }` on a site logs in via `wp-login.php` once per run so maintenance-mode staging sites are testable; credentials come from `WP_LOGIN_USER`/`WP_LOGIN_PASSWORD` env vars (per-site override `_<KEY>`), never `sites.json`. See `docs/workflow.md` → "Maintenance-mode staging".
- Notifications: email (SMTP) and Slack (`SLACK_WEBHOOK_URL`), each gated by `settings.notifications.*.enabled`. Slack is failure-only.
- Journey templates live in `journeys/templates/`. Site-specific custom journeys in `journeys/custom/`.
- Bare journey names (e.g. `"woocommerce"`) resolve to `journeys/templates/` automatically.
- All journeys use `createStepRunner` from `src/step.js` — failure screenshots are captured automatically.
- Analytics and tracking requests are blocked in every browser context to avoid polluting client dashboards.
- CSS animations are disabled before visual diff screenshots to prevent false positives.

## Deeper Documentation

- `docs/workflow.md` — development stage gates, how to add a test, staging checklist
- `docs/selectors.md` — `data-wpt` convention, Elementor setup, selector priority order
- `docs/custom-journeys.md` — how to write a custom journey for unique per-site plugins

## Roadmap

Phase 1 is complete. The original architecture plan lives at:
`C:\Users\roshe\.claude\plans\i-want-to-plan-partitioned-cherny.md`

### Phase 2 — CI and ongoing monitoring — COMPLETE
- ~~`config/sites.ci.json`~~ — committed config for CI (URLs only, no credentials)
- ~~GitHub Actions workflow~~ — `.github/workflows/scheduled.yml` (`workflow_dispatch` + weekly Monday 8am AEST)
- ~~Post-deploy webhook trigger~~ — curl snippet documented in `docs/workflow.md`
- ~~Slack failure notifications~~ — `sendSlackNotification` in `src/notifier.js`
- ~~New templates~~ — `journeys/templates/product-filter.js`, `journeys/templates/post-filter.js`
- ~~`productionUrl` site config field~~ — `runProductionSmoke` in `src/orchestrator.js`, `--production` flag
- ~~`generate-journey` command~~ — complete (see `src/journey-generator.js`)

Remaining manual setup for CI: populate `config/sites.ci.json` with real sites, add GitHub repository secrets (`SMTP_*`, `SLACK_WEBHOOK_URL`, `TEST_CUSTOMER_*`).

### Phase 3 — Coverage and mobile (no fixed timeline)
- Mobile viewport runs (`{ width: 390, height: 844 }`)
- `visualMask` array in site config for dynamic content regions
- `--journey` CLI filter flag
