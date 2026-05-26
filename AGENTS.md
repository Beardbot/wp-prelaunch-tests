# WP Pre-launch Tests

Pre-launch functional testing for WordPress/Elementor sites. Tests run against staging environments at three build stages: feature complete, content complete, and pre-launch.

## Essential Commands

Run `npm link` once to register the global CLI commands.

```bash
baseline                              # capture baseline screenshots for all sites
baseline <key> [key2 ...]             # capture baseline for one or more sites
prelaunch-test                        # run tests for all sites
prelaunch-test <key> [key2 ...]       # run tests for one or more sites
add-site <url> [url2 ...]             # import one or more sites into sites.json
add-site <url> --dry-run              # preview generated config without writing
npm run server                        # start the optional webhook server
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
- `SITES_CONFIG` env var can point to a config file outside the project directory.
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

### Phase 2 — CI and ongoing monitoring
- `config/sites.ci.json` — committed config for CI (URLs only, no credentials)
- GitHub Actions workflow: `workflow_dispatch` + scheduled weekly run
- Post-deploy webhook trigger from deploy script
- Slack failure notifications in `src/notifier.js`
- New templates: `journeys/templates/product-filter.js`, `journeys/templates/post-filter.js`
- `productionUrl` site config field for post-launch smoke-only checks

### Phase 3 — Coverage and mobile (no fixed timeline)
- Mobile viewport runs (`{ width: 390, height: 844 }`)
- `visualMask` array in site config for dynamic content regions
- `--journey` CLI filter flag
