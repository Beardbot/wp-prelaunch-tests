# wpt-sensors — the companion WordPress plugin

Read-only sensor surface for the runner, installed on staging sites. It exists
to close the blind spots of outside-in testing: authoritative site inventory,
a machine-checked pre-flight audit, and server-side verification that a test
run's UI success actually produced its effects (form entry, mail handoff,
order). Decided and scoped in
[issue #18](https://github.com/Beardbot/wp-prelaunch-tests/issues/18).

**This is a stub.** Each implementation slice extends this document with only
what it actually ships; anything not described here does not exist yet.

## What exists today

- Plugin skeleton at `wp-plugin/wpt-sensors/` — activates on WordPress 6.0+ /
  PHP 8.1+, grants the `manage_wpt_sensors` capability to administrators on
  activation and removes it on deactivation.
- The authenticated REST gate (see Security model below) and one proving
  route: `GET /?rest_route=/wpt-sensors/v1/version` returns
  `{ "api_version": 1, "plugin_version": "0.1.0" }`.

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
`wpt_sensors_rest_preflight` filter (403) → authenticated via a WordPress
application password (401) → holding the `manage_wpt_sensors` capability
(403). Failed attempts are throttled 5-per-15-minutes per address+username,
and a locked-out caller never reaches the password hash comparison. The
`wpt-sensors/v1` namespace is scrubbed from the public `/wp-json/` index.

A dedicated service user should hold *only* the sensor capability:

```
wp user create wpt-sensors sensors@yourdomain.invalid --role=subscriber
wp user add-cap wpt-sensors manage_wpt_sensors
wp user application-password create wpt-sensors runner
```

The application password goes in the runner's `.env` (never in `sites.json`);
the env var names and per-site override convention land with the runner-side
slice.

## Provenance and the extraction trigger

The security guard classes and their unit tests are **copies**, not
reimplementations:

| File | Copied from (staging-setup repo) |
|---|---|
| `wpt-sensors/includes/Rest/Controller.php` | `plugin/beardbot-setup/includes/Rest/Controller.php` |
| `wpt-sensors/includes/Rest/Throttle.php` | `plugin/beardbot-setup/includes/Rest/Throttle.php` |
| `tests/Unit/RestPermissionTest.php` | `tests/Unit/RestPermissionTest.php` |
| `tests/Unit/RestThrottleTest.php` | `tests/Unit/RestThrottleTest.php` |

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

Unit tests are pure PHP with no WordPress. The provisioned-WordPress
integration harness arrives in the next slice.
