<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * The machine-checked staging checklist: each check reports pass, fail, or
 * unknown with an operator-readable detail. The plugin only ever REPORTS —
 * which checks block a run is runner-side policy, deliberately, so policy
 * changes never require redeploying PHP to client sites.
 *
 * `unknown` means "could not determine", never "probably fine": a check that
 * cannot see its subject says so, and the runner's policy decides how much
 * that matters.
 */
final class Preflight
{
    /** Payment gateways that move no real money and need no test mode. */
    private const OFFLINE_GATEWAYS = ['bacs', 'cheque', 'cod'];

    // ─── Pure decision logic (no WordPress) ──────────────────────────────────

    /**
     * Classify one WooCommerce payment gateway by id and settings:
     * 'offline' (no real money), 'test' (recognised gateway in its test
     * mode), 'live' (recognised gateway NOT in test mode), or 'unknown'
     * (a gateway this check has no rule for).
     *
     * @param array<string, mixed> $settings
     */
    public static function classify_gateway(string $id, array $settings): string
    {
        if (in_array($id, self::OFFLINE_GATEWAYS, true)) {
            return 'offline';
        }

        $enabled = static fn($value): bool => $value === 'yes' || $value === '1' || $value === 1 || $value === true;

        if ($id === 'stripe' || str_starts_with($id, 'stripe_')) {
            return $enabled($settings['testmode'] ?? null) ? 'test' : 'live';
        }
        if ($id === 'woocommerce_payments') {
            return $enabled($settings['test_mode'] ?? null) ? 'test' : 'live';
        }
        if ($id === 'paypal') {
            return $enabled($settings['testmode'] ?? null) ? 'test' : 'live';
        }

        return 'unknown';
    }

    // ─── Assembly ────────────────────────────────────────────────────────────

    /** @return array<string, mixed> */
    public static function collect(?string $test_customer): array
    {
        $environment = Environment::report();

        return [
            'environment' => $environment,
            'checks'      => [
                self::not_production($environment['verdict']),
                self::payment_gateway_test_mode(),
                self::captcha_disabled(),
                self::test_product_exists(),
                self::test_customer_exists($test_customer),
                self::maintenance_mode(),
                self::permalink_structure(),
                self::sitemap_present(),
                self::sensor_events_ready(),
            ],
        ];
    }

    /** @return array{id: string, status: string, detail: string} */
    private static function check(string $id, string $status, string $detail): array
    {
        return ['id' => $id, 'status' => $status, 'detail' => $detail];
    }

    // ─── Checks ──────────────────────────────────────────────────────────────

    private static function not_production(string $verdict): array
    {
        return self::check(
            'not_production',
            $verdict === 'production' ? 'fail' : ($verdict === 'unknown' ? 'unknown' : 'pass'),
            "environment verdict: {$verdict}"
        );
    }

    private static function payment_gateway_test_mode(): array
    {
        $id = 'payment_gateway_test_mode';
        if (!class_exists('\WooCommerce')) {
            return self::check($id, 'pass', 'not applicable: WooCommerce is not active');
        }

        $gateways = \WC()->payment_gateways()->get_available_payment_gateways();
        if ($gateways === []) {
            return self::check($id, 'pass', 'no payment gateways are enabled');
        }

        $live = $unknown = $safe = [];
        foreach ($gateways as $gateway) {
            $name = (string) ($gateway->get_method_title() ?: $gateway->id);
            match (self::classify_gateway((string) $gateway->id, (array) $gateway->settings)) {
                'live'    => $live[]    = $name,
                'unknown' => $unknown[] = $name,
                default   => $safe[]    = $name,
            };
        }

        if ($live !== []) {
            return self::check($id, 'fail', 'live-mode payment gateway enabled: ' . implode(', ', $live));
        }
        if ($unknown !== []) {
            return self::check($id, 'unknown', 'unrecognised gateway(s) enabled — verify test mode manually: ' . implode(', ', $unknown));
        }

        return self::check($id, 'pass', 'enabled gateways are offline or in test mode: ' . implode(', ', $safe));
    }

    private static function captcha_disabled(): array
    {
        $id      = 'captcha_disabled';
        $flagged = [];

        foreach (FormScan::scan() as $instance) {
            if (!empty($instance['has_recaptcha'])) {
                $name      = $instance['form_name'] !== '' ? $instance['form_name'] : 'unnamed form';
                $flagged[] = "{$name} ({$instance['page_path']})";
            }
        }

        if (class_exists('\GFAPI')) {
            foreach (\GFAPI::get_forms() as $form) {
                foreach ($form['fields'] ?? [] as $field) {
                    if ((string) ($field->type ?? '') === 'captcha') {
                        $flagged[] = (string) ($form['title'] ?? 'Gravity Forms form') . ' (gravity_forms)';
                        break;
                    }
                }
            }
        }

        // Site-wide Elementor Pro reCAPTCHA keys are advisory context: keys
        // being configured does not by itself put a captcha on any form.
        $keys = [];
        if ((string) get_option('elementor_pro_recaptcha_site_key', '') !== '') {
            $keys[] = 'recaptcha';
        }
        if ((string) get_option('elementor_pro_recaptcha_v3_site_key', '') !== '') {
            $keys[] = 'recaptcha_v3';
        }
        $key_note = $keys === [] ? '' : ' (site-wide Elementor Pro keys configured: ' . implode(', ', $keys) . ')';

        if ($flagged !== []) {
            return self::check($id, 'fail', 'captcha-protected form(s) will block automation: ' . implode('; ', $flagged) . $key_note);
        }

        return self::check($id, 'pass', 'no captcha-protected forms found' . $key_note);
    }

    private static function test_product_exists(): array
    {
        $id = 'test_product_exists';
        if (!class_exists('\WooCommerce')) {
            return self::check($id, 'pass', 'not applicable: WooCommerce is not active');
        }

        $candidates = Inventory::test_product_candidates();
        if ($candidates === []) {
            return self::check($id, 'fail', 'no safe test product: nothing purchasable and in stock at ≤ $5.00 or named "test"');
        }

        return self::check(
            $id,
            'pass',
            count($candidates) . ' candidate(s), e.g. "' . $candidates[0]['name'] . '" at ' . $candidates[0]['price']
        );
    }

    private static function test_customer_exists(?string $email): array
    {
        $id = 'test_customer_exists';
        if ($email === null || $email === '') {
            return self::check($id, 'unknown', 'no test_customer email supplied');
        }

        $user = get_user_by('email', $email);
        if ($user === false) {
            return self::check($id, 'fail', "no user with email {$email}");
        }

        return self::check($id, 'pass', "user \"{$user->user_login}\" has email {$email}");
    }

    private static function maintenance_mode(): array
    {
        $id   = 'maintenance_mode';
        $mode = (string) get_option('elementor_maintenance_mode_mode', '');

        if ($mode === '') {
            return self::check($id, 'pass', 'Elementor maintenance mode is off');
        }

        return self::check(
            $id,
            'fail',
            "Elementor maintenance mode is \"{$mode}\" — the runner must authenticate via wp-login to see the site"
        );
    }

    private static function permalink_structure(): array
    {
        $id        = 'permalink_structure';
        $structure = (string) get_option('permalink_structure', '');

        if ($structure === '') {
            return self::check($id, 'fail', 'plain permalinks (?p=) — launch sites are expected to use pretty permalinks');
        }

        return self::check($id, 'pass', "permalink structure: {$structure}");
    }

    private static function sitemap_present(): array
    {
        $id = 'sitemap_present';

        if (defined('WPSEO_VERSION')) {
            return self::check($id, 'pass', 'sitemap provided by Yoast SEO');
        }
        if (class_exists('\RankMath')) {
            return self::check($id, 'pass', 'sitemap provided by Rank Math');
        }

        // get_sitemap_url() builds a URL whether or not sitemaps are served;
        // sitemaps_enabled() is the actual answer.
        $server = function_exists('wp_sitemaps_get_server') ? wp_sitemaps_get_server() : null;
        if ($server !== null && $server->sitemaps_enabled()) {
            return self::check($id, 'pass', 'WordPress core sitemap at ' . wp_make_link_relative((string) get_sitemap_url('index')));
        }

        if ((string) get_option('blog_public', '1') === '0') {
            return self::check($id, 'fail', 'core sitemaps are disabled because blog_public=0 — sitemap discovery will find nothing');
        }

        return self::check($id, 'fail', 'no sitemap found (core sitemaps unavailable, no known SEO plugin)');
    }

    private static function sensor_events_ready(): array
    {
        global $wpdb;

        $id     = 'sensor_events_ready';
        $table  = $wpdb->prefix . 'beardbot_sensor_events';
        $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;

        if (!$exists) {
            return self::check($id, 'fail', 'events table not installed — effect corroboration unavailable (events sensor arrives in a later plugin version)');
        }

        return self::check($id, 'pass', 'events table ready');
    }
}
