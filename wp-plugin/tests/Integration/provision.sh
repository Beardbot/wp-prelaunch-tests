#!/usr/bin/env bash
#
# COPIED from the beardbot-setup plugin (staging-setup repo).
# Source: tests/Integration/provision.sh
# Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
# Changes: renames (BEARDBOT_SENSORS_TEST_* env vars, bbs-int.test URL,
# bbs_int_test database, beardbot-sensors plugin path); the beardbot-setup
# activation check is replaced with a plugin-status check (this plugin has no
# WP-CLI command); fixture seeding added for the sensor suites (WooCommerce,
# Contact Form 7, a $1.00 test product, a test customer, and a page carrying
# Elementor form-widget meta). The Windows/Git-Bash workarounds are kept
# verbatim — see the notes below for why each exists.
# Extraction trigger: a THIRD consumer of these guard classes moves them to a
# shared composer package. Recorded in docs/plugin.md.
#
# Provision a throwaway WordPress + MySQL install for the integration suite,
# with the beardbot-sensors plugin installed and active. Reproducible on
# any machine and in CI — nothing is assumed about the operator's environment.
#
# Requires: wp-cli (`wp`) AND the MySQL client binaries (`mysql`, `mysqladmin`)
# on PATH — the `wp db` commands below shell out to them, so a reachable server
# alone is not enough — plus a reachable MySQL server. The database named by
# DB_NAME is dropped and recreated, so point it at a throwaway server.
#
# On Windows, run it under Git Bash; core is fetched with Git Bash's own curl
# and GNU tar (see the Windows note below for why WP-CLI cannot do it there).
#
# Configure via environment (defaults shown):
#   WP_PATH      target WordPress directory        (default: a fresh temp dir)
#   WP_URL       site URL (https to match staging)  (default: https://bbs-int.test)
#   DB_NAME      database name (RECREATED)         (default: bbs_int_test)
#   DB_USER      database user                     (default: root)
#   DB_PASS      database password                 (default: empty)
#   DB_HOST      database host                     (default: 127.0.0.1)
#   ADMIN_USER   admin login                       (default: admin)
#   ADMIN_PASS   admin password                    (default: admin)
#   ADMIN_EMAIL  admin email                       (default: admin@example.com)
#
# On success it prints the line to export before running the suite:
#   export BEARDBOT_SENSORS_TEST_WP_PATH=<WP_PATH>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The wp-plugin/ subtree root (this script lives at wp-plugin/tests/Integration/).
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

WP_PATH="${WP_PATH:-$(mktemp -d)/wp}"
# HTTPS by default so the site matches a real staging site. The integration
# suite reaches the site through a plain-HTTP PHP built-in server and marks the
# environment `local` for the duration, so no TLS endpoint is required here.
WP_URL="${WP_URL:-https://bbs-int.test}"
DB_NAME="${DB_NAME:-bbs_int_test}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-}"
DB_HOST="${DB_HOST:-127.0.0.1}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"

# ─── Windows (Git Bash) support ───────────────────────────────────────────────
# Two host quirks, both in WP-CLI's tooling rather than this repo, are worked
# around here so the script runs unmodified. Neither branch changes behaviour
# on Linux/macOS or in CI.
#
#   - Composer's sh shim for `wp` (the one Git Bash resolves) does not raise
#     PHP's memory limit the way its .bat twin does, and the default 128M is
#     fatal during core extraction. WP-CLI's launcher honours WP_CLI_PHP_ARGS,
#     so a default is supplied when the caller has not set their own.
#   - `wp core download` cannot extract current WordPress on Windows at all:
#     PharData truncates archive paths longer than the ustar 100-character name
#     field (WordPress 7.0 ships one), and WP-CLI's `tar` fallback spawns its
#     subprocess with an empty environment, so cmd.exe has no PATH to find
#     tar.exe with. Git Bash's GNU tar handles the same tarball correctly, so
#     on Windows core is fetched and extracted with curl + tar instead.

ON_WINDOWS=false
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=true ;;
esac

if ${ON_WINDOWS}; then
  export WP_CLI_PHP_ARGS="${WP_CLI_PHP_ARGS:--d memory_limit=512M}"
fi

echo "==> Provisioning throwaway WordPress at ${WP_PATH}"
mkdir -p "${WP_PATH}"

echo "==> Downloading WordPress core"
# Keep default themes: WordPress needs an active theme.
if ${ON_WINDOWS}; then
  # The tarball is cached across runs and re-fetched only when wordpress.org
  # publishes a new release; the md5 comparison against the published checksum
  # is the same integrity check `wp core download` applies to its own download.
  TARBALL="${TMPDIR:-/tmp}/beardbot-wordpress-latest.tar.gz"
  EXPECTED_MD5="$(curl -fsSL https://wordpress.org/latest.tar.gz.md5)"

  tarball_ok() {
    [ -f "${TARBALL}" ] && [ "$(md5sum < "${TARBALL}" | cut -d' ' -f1)" = "${EXPECTED_MD5}" ]
  }

  if ! tarball_ok; then
    curl -fSL -o "${TARBALL}" https://wordpress.org/latest.tar.gz
  fi
  if ! tarball_ok; then
    echo "ERROR: WordPress tarball failed its md5 check after download." >&2
    exit 1
  fi

  tar xz --strip-components=1 --directory="${WP_PATH}" -f "${TARBALL}"
else
  wp core download --path="${WP_PATH}" --force
fi

echo "==> Writing wp-config.php"
wp config create \
  --path="${WP_PATH}" \
  --dbname="${DB_NAME}" \
  --dbuser="${DB_USER}" \
  --dbpass="${DB_PASS}" \
  --dbhost="${DB_HOST}" \
  --skip-check \
  --force

echo "==> Creating a clean database (${DB_NAME})"
wp db reset --path="${WP_PATH}" --yes 2>/dev/null || wp db create --path="${WP_PATH}"

echo "==> Installing WordPress"
wp core install \
  --path="${WP_PATH}" \
  --url="${WP_URL}" \
  --title="Beardbot Sensors Integration" \
  --admin_user="${ADMIN_USER}" \
  --admin_password="${ADMIN_PASS}" \
  --admin_email="${ADMIN_EMAIL}" \
  --skip-email

echo "==> Installing the beardbot-sensors plugin"
PLUGIN_DEST="${WP_PATH}/wp-content/plugins/beardbot-sensors"
rm -rf "${PLUGIN_DEST}"
cp -r "${PLUGIN_ROOT}/beardbot-sensors" "${PLUGIN_DEST}"
wp plugin activate beardbot-sensors --path="${WP_PATH}"

echo "==> Verifying the sensor plugin is active"
test "$(wp plugin get beardbot-sensors --field=status --path="${WP_PATH}")" = "active"

# ─── Sensor fixtures ─────────────────────────────────────────────────────────
# The inventory, preflight, and events suites need real things to sense.
# Contact Form 7 stands in for a form provider locally (Elementor free has no
# Forms widget; the Elementor Pro path is proven at acceptance on a real
# staging site), and the Elementor form-widget page below is plain post meta —
# FormScan parses `_elementor_data` directly, so Elementor itself is not
# required for the scan to find it.

echo "==> Installing fixture plugins (WooCommerce, Contact Form 7)"
wp plugin install woocommerce contact-form-7 --activate --path="${WP_PATH}"

echo "==> Seeding a Contact Form 7 form"
# CF7 usually creates its default form on activation; guarantee one exists
# either way, using CF7's own template so the form is genuinely submittable.
# (Checked via get_posts — WPCF7_ContactForm::count() only reflects the most
# recent find() query, so it reads 0 here even when a form exists.)
wp eval --path="${WP_PATH}" '
  $forms = get_posts(["post_type" => "wpcf7_contact_form", "post_status" => "any", "numberposts" => 1]);
  if (class_exists("WPCF7_ContactForm") && $forms === []) {
      WPCF7_ContactForm::get_template(["title" => "Integration contact form"])->save();
  }
'

echo "==> Seeding a \$1.00 test product"
wp eval --path="${WP_PATH}" '
  if (class_exists("WC_Product_Simple") && get_page_by_path("test-product", OBJECT, "product") === null) {
      $product = new WC_Product_Simple();
      $product->set_name("Test Product");
      $product->set_slug("test-product");
      $product->set_regular_price("1.00");
      $product->set_status("publish");
      $product->save();
  }
'

echo "==> Seeding the test customer"
wp user create testcustomer testcustomer@youragency.com \
  --role=customer \
  --user_pass=testcustomer-integration \
  --path="${WP_PATH}"

echo "==> Seeding a page carrying Elementor form-widget meta"
ELEMENTOR_DATA='[{"id":"a1b2c3d4","elType":"section","elements":[{"id":"b2c3d4e5","elType":"column","elements":[{"id":"c3d4e5f6","elType":"widget","widgetType":"form","settings":{"form_name":"Fixture Enquiry Form","form_fields":[{"custom_id":"name","field_type":"text","field_label":"Name","required":"true"},{"custom_id":"email","field_type":"email","field_label":"Email","required":"true"},{"custom_id":"message","field_type":"textarea","field_label":"Message"}],"button_text":"Send Enquiry"}}]}]}]'
FIXTURE_PAGE_ID="$(wp post create \
  --post_type=page \
  --post_title="Fixture Contact" \
  --post_name=fixture-contact \
  --post_status=publish \
  --porcelain \
  --path="${WP_PATH}")"
wp post meta update "${FIXTURE_PAGE_ID}" _elementor_data "${ELEMENTOR_DATA}" --path="${WP_PATH}"

echo ""
echo "Provisioned. Run the integration suite with:"
echo "  export BEARDBOT_SENSORS_TEST_WP_PATH=${WP_PATH}"
echo "  export BEARDBOT_SENSORS_TEST_WP_URL=${WP_URL}"
if ${ON_WINDOWS}; then
  # The suite spawns `wp` itself, so the shim's memory-limit gap applies to it
  # too — the export must be in the shell that runs phpunit, not just here.
  echo "  export WP_CLI_PHP_ARGS='${WP_CLI_PHP_ARGS}'"
fi
echo "  vendor/bin/phpunit --testsuite integration"
