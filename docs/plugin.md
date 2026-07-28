# beardbot-sensors — the companion WordPress plugin

Read-only sensor surface for the runner, installed on staging sites. It exists
to close the blind spots of outside-in testing: authoritative site inventory,
a machine-checked pre-flight audit, and server-side verification that a test
run's UI success actually produced its effects (form entry, mail handoff,
order). Decided and scoped in
[issue #18](https://github.com/Beardbot/wp-prelaunch-tests/issues/18).

**This is a stub.** Each implementation slice extends this document with only
what it actually ships; anything not described here does not exist yet.

## What exists today

- Plugin skeleton at `wp-plugin/beardbot-sensors/` — activates on WordPress 6.0+ /
  PHP 8.1+, grants the `manage_beardbot_sensors` capability to administrators on
  activation and removes it on deactivation.
- The authenticated REST gate (see Security model below) and one proving
  route: `GET /?rest_route=/beardbot-sensors/v1/version` returns
  `{ "api_version": 1, "plugin_version": "0.1.0" }`.
- The integration harness: a provisioning script for a throwaway local
  WordPress and a PHPUnit suite that exercises the REST gate over real HTTP
  (see Development below). It runs in CI against a MySQL service.
- The inventory route (see Endpoints below): the authoritative site inventory
  the runner consumes instead of sitemap and DOM guesswork.

## Endpoints

All routes are GET under `/?rest_route=/beardbot-sensors/v1/...`, behind the
same five-gate authorisation (see Security model), and every response carries
`api_version` and `plugin_version`. The runner treats an `api_version`
mismatch as plugin-absent.

- **`/version`** — the availability-and-contract probe. Returns only the two
  version fields.
- **`/inventory`** — assembled fresh on every call (no caching in v1):
  - `site` — `name`, `url`, `environment` (`wp_get_environment_type()`).
  - `pages[]` — published pages only (bounded at 200): `id`, `slug`, `path`
    (site-relative, navigable under any permalink structure), `title`,
    `template`.
  - `forms.plugins` — active flag + version for `elementor_pro`,
    `gravity_forms`, `wpforms`, `contact_form_7`.
  - `forms.instances[]` — one entry per discovered form: `provider`,
    `page_id`/`page_path` (null for Gravity Forms and WPForms, which register
    forms site-wide), `form_name`, `fields[]` (`type`, `label`, `required`,
    `custom_id`), `has_recaptcha`, `submit_text`. Elementor Pro forms are
    found by parsing `_elementor_data` post meta directly (bounded at 200
    documents) — Elementor does not need to be loaded. Captcha fields set
    `has_recaptcha` instead of appearing as fillable fields. Contact Form 7
    is a presence flag only in v1.
  - `woocommerce` — `active`, `version`, `paths` (shop/cart/checkout/
    myaccount where published), and `test_product_candidates[]` (max 5):
    purchasable, in-stock products priced at or under $5.00 or with "test"
    in the name or slug — the rule that decides what a test checkout may buy.
  - `theme` — `name`, `version`, `stylesheet`.
  - `plugins[]` — active plugins only: `file`, `name`, `version`.

## The read-only guarantee

Every route is GET and nothing in this plugin mutates WordPress state — no
core options, no posts, no users, ever. The plugin writes only to its own
storage: its throttle transients, and (in a later slice) its own event table
and schema-version option. This is a hard rule; PRs that would break it are
wrong by definition.

## Security model

Authentication and authorisation are copied from the beardbot-setup plugin's
proven REST gate (see Provenance below). A request must clear five gates, in
order: not throttled (429) → encrypted transport, with WordPress core's
`local`-environment exception (403) → not refused by the site's
`beardbot_sensors_rest_preflight` filter (403) → authenticated via a WordPress
application password (401) → holding the `manage_beardbot_sensors` capability
(403). Failed attempts are throttled 5-per-15-minutes per address+username,
and a locked-out caller never reaches the password hash comparison. The
`beardbot-sensors/v1` namespace is scrubbed from the public `/wp-json/` index.

A dedicated service user should hold *only* the sensor capability:

```
wp user create beardbot-sensors sensors@yourdomain.invalid --role=subscriber
wp user add-cap beardbot-sensors manage_beardbot_sensors
wp user application-password create beardbot-sensors runner
```

The application password goes in the runner's `.env` (never in `sites.json`);
the env var names and per-site override convention land with the runner-side
slice.

## Provenance and the extraction trigger

The security guard classes and their unit tests are **copies**, not
reimplementations:

| File | Copied from (staging-setup repo) |
|---|---|
| `beardbot-sensors/includes/Rest/Controller.php` | `plugin/beardbot-setup/includes/Rest/Controller.php` |
| `beardbot-sensors/includes/Rest/Throttle.php` | `plugin/beardbot-setup/includes/Rest/Throttle.php` |
| `tests/Unit/RestPermissionTest.php` | `tests/Unit/RestPermissionTest.php` |
| `tests/Unit/RestThrottleTest.php` | `tests/Unit/RestThrottleTest.php` |
| `tests/Integration/provision.sh` | `tests/Integration/provision.sh` |
| `tests/Integration/RestTestCase.php` | `tests/Integration/RestTestCase.php` |
| `tests/Integration/RestAuthTest.php` | `tests/Integration/RestAuthTest.php` |

All pinned to staging-setup commit
`e5b7beddd236f1ff48dece0cb9114dd7b8028fd8` (M3.4), with a provenance header in
each file stating exactly what was changed. When a security fix lands in the
source repo's gate, diff these copies against it and port the fix.

**Extraction trigger (recorded decision):** these guards stay duplicated
between the two plugins until a THIRD consumer appears — at that point they
move to a shared composer package rather than a third copy. Do not extract
earlier; do not copy a third time.

## Development

```
cd wp-plugin
composer install
vendor/bin/phpunit --testsuite unit
```

Unit tests are pure PHP with no WordPress.

The integration suite exercises the REST gate over real HTTP against a
provisioned throwaway WordPress. It needs wp-cli, the MySQL client binaries,
and a reachable throwaway MySQL server (the database it names is dropped and
recreated). On Windows, run it under Git Bash. Provision, then export the
path the script prints and run the suite:

```
bash tests/Integration/provision.sh
export BEARDBOT_SENSORS_TEST_WP_PATH=<path printed by the script>
vendor/bin/phpunit --testsuite integration
```

Without `BEARDBOT_SENSORS_TEST_WP_PATH` the suite self-skips, so a bare
`phpunit` run stays fast and WordPress-free. The provisioning also seeds the
fixtures later slices sense against: WooCommerce and Contact Form 7 active, a
$1.00 "Test Product", a `testcustomer@youragency.com` customer, and a page
carrying Elementor form-widget meta (Elementor itself is not installed —
the form scan parses the meta directly).
