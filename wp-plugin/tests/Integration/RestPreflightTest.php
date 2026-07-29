<?php

declare(strict_types=1);

namespace Tests\Integration;

/**
 * End-to-end test of GET /preflight: the environment verdict and every check
 * against the provisioned site, then state-flips via wp-cli proving the
 * checks read live state — the whole point of a preflight over a checklist.
 *
 * The production-verdict flip needs three things at once: the environment
 * type set to production, a host with no staging pattern (the provisioned
 * bbs-int.test matches *.test, so the home URL is temporarily pointed at a
 * live-looking hostname), and the site still reachable — which plain HTTP to
 * the test server is not, in a production environment, for either core's
 * application passwords or this plugin's transport gate. A throwaway
 * mu-plugin setting $_SERVER['HTTPS'] = 'on' (the standard reverse-proxy fix
 * the Controller documents) makes the connection count as encrypted for both.
 *
 * Skipped unless BEARDBOT_SENSORS_TEST_WP_PATH points at a provisioned
 * WordPress (see tests/Integration/provision.sh).
 */
final class RestPreflightTest extends RestTestCase
{
    private const ROUTE = '/index.php?rest_route=/beardbot-sensors/v1/preflight';

    private const CAP_USER = 'admin';

    private static string $capPassword = '';

    public static function setUpBeforeClass(): void
    {
        self::requireProvisionedSite();
        self::bootLocalEnvironment();
        self::$capPassword = self::createApplicationPassword(self::CAP_USER, 'bbs-preflight-test');
        self::startServer();
    }

    public static function tearDownAfterClass(): void
    {
        self::stopServer();

        if (isset(self::$wpPath)) {
            self::removeForcedHttps();
            self::restoreEnvironment();
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** @return array{status: int, body: array<string, mixed>, headers: array<string, string>} */
    private function preflight(string $query = ''): array
    {
        $response = $this->get(self::ROUTE . $query, self::CAP_USER, self::$capPassword);
        $this->assertSame(200, $response['status'], 'An authorised preflight request should be served.');

        return $response;
    }

    /**
     * @param array<string, mixed> $body
     * @return array{id: string, status: string, detail: string}
     */
    private function checkById(array $body, string $id): array
    {
        foreach ($body['checks'] ?? [] as $check) {
            if (($check['id'] ?? '') === $id) {
                return $check;
            }
        }
        $this->fail("Preflight response carries no '{$id}' check.");
    }

    private static function muPluginPath(): string
    {
        return self::$wpPath . '/wp-content/mu-plugins/bbs-test-forced-https.php';
    }

    /** Make plain HTTP count as encrypted, as a TLS-terminating proxy would. */
    private static function forceHttps(): void
    {
        $dir = dirname(self::muPluginPath());
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        file_put_contents(self::muPluginPath(), "<?php\n\$_SERVER['HTTPS'] = 'on';\n");
    }

    private static function removeForcedHttps(): void
    {
        if (file_exists(self::muPluginPath())) {
            unlink(self::muPluginPath());
        }
    }

    // ─── The response shape ──────────────────────────────────────────────────

    public function test_unauthenticated_preflight_is_refused(): void
    {
        $response = $this->get(self::ROUTE);

        $this->assertSame(401, $response['status']);
        $this->assertArrayNotHasKey('checks', $response['body']);
    }

    public function test_response_carries_versions_environment_and_all_checks(): void
    {
        $body = $this->preflight()['body'];

        $this->assertSame(1, $body['api_version'] ?? null);
        $this->assertArrayHasKey('plugin_version', $body);

        $this->assertSame('local', $body['environment']['wp_environment_type'] ?? null);
        $this->assertSame('staging', $body['environment']['verdict'] ?? null);
        $this->assertNotSame([], $body['environment']['signals'] ?? []);

        $ids = array_column($body['checks'] ?? [], 'id');
        $this->assertSame(
            [
                'not_production',
                'payment_gateway_test_mode',
                'captcha_disabled',
                'test_product_exists',
                'test_customer_exists',
                'maintenance_mode',
                'permalink_structure',
                'sitemap_present',
                'sensor_events_ready',
            ],
            $ids,
            'Every preflight check must be present, in a stable order.'
        );

        foreach ($body['checks'] as $check) {
            $this->assertContains($check['status'], ['pass', 'fail', 'unknown'], "Check {$check['id']} has an invalid status.");
            $this->assertNotSame('', (string) $check['detail'], "Check {$check['id']} must explain itself.");
        }
    }

    public function test_responses_forbid_caching(): void
    {
        $headers = $this->preflight()['headers'];

        $this->assertArrayHasKey('cache-control', $headers);
        $this->assertStringContainsString('no-store', $headers['cache-control']);
    }

    // ─── Baseline statuses on the provisioned site ───────────────────────────

    public function test_baseline_statuses_match_the_provisioned_site(): void
    {
        $body = $this->preflight()['body'];

        $this->assertSame('pass', $this->checkById($body, 'not_production')['status']);
        $this->assertSame('pass', $this->checkById($body, 'payment_gateway_test_mode')['status'], 'No gateways are enabled on a fresh WooCommerce.');
        $this->assertSame('pass', $this->checkById($body, 'captcha_disabled')['status']);
        $this->assertSame('pass', $this->checkById($body, 'test_product_exists')['status'], 'The seeded $1.00 Test Product must qualify.');
        $this->assertSame('unknown', $this->checkById($body, 'test_customer_exists')['status'], 'No email supplied means unknown, not pass.');
        $this->assertSame('pass', $this->checkById($body, 'maintenance_mode')['status']);
        $this->assertSame('fail', $this->checkById($body, 'permalink_structure')['status'], 'The provisioned site uses plain permalinks.');
        $this->assertSame('pass', $this->checkById($body, 'sitemap_present')['status'], 'Core sitemaps are on for a public fresh site.');
        $this->assertSame('fail', $this->checkById($body, 'sensor_events_ready')['status'], 'The events table arrives in a later slice.');
    }

    // ─── State flips ─────────────────────────────────────────────────────────

    public function test_test_customer_check_flips_on_the_supplied_email(): void
    {
        $seeded = $this->preflight('&test_customer=testcustomer%40youragency.com')['body'];
        $this->assertSame('pass', $this->checkById($seeded, 'test_customer_exists')['status']);

        $missing = $this->preflight('&test_customer=nobody%40example.com')['body'];
        $check   = $this->checkById($missing, 'test_customer_exists');
        $this->assertSame('fail', $check['status']);
        $this->assertStringContainsString('nobody@example.com', $check['detail']);
    }

    public function test_permalink_check_flips_when_pretty_permalinks_are_set(): void
    {
        self::wpOrFail('option update permalink_structure /%postname%/');

        try {
            $check = $this->checkById($this->preflight()['body'], 'permalink_structure');
            $this->assertSame('pass', $check['status']);
            $this->assertStringContainsString('%postname%', $check['detail']);
        } finally {
            self::wpOrFail('option update permalink_structure ""', allowFailure: true);
        }
    }

    public function test_maintenance_mode_check_flips_when_elementor_maintenance_is_on(): void
    {
        self::wpOrFail('option update elementor_maintenance_mode_mode maintenance');

        try {
            $check = $this->checkById($this->preflight()['body'], 'maintenance_mode');
            $this->assertSame('fail', $check['status']);
            $this->assertStringContainsString('wp-login', $check['detail'], 'The detail must tell the runner how to get in.');
        } finally {
            self::wpOrFail('option delete elementor_maintenance_mode_mode', allowFailure: true);
        }
    }

    public function test_sitemap_check_flips_when_search_engines_are_discouraged(): void
    {
        self::wpOrFail('option update blog_public 0');

        try {
            $body = $this->preflight()['body'];
            $this->assertSame('fail', $this->checkById($body, 'sitemap_present')['status']);

            // blog_public=0 is also a staging signal, so the verdict holds.
            $this->assertSame('staging', $body['environment']['verdict']);
        } finally {
            self::wpOrFail('option update blog_public 1', allowFailure: true);
        }
    }

    public function test_captcha_check_flips_when_a_form_gains_a_captcha(): void
    {
        // Seed a page whose _elementor_data carries a recaptcha-protected form
        // (the same fixture the unit suite parses), via eval-file so the JSON
        // never has to survive shell quoting. Re-encoded compact because that
        // is how Elementor stores it — and what the scan's SQL prefilter
        // matches; the pretty-printed fixture would slip past it.
        $fixture = str_replace('\\', '/', realpath(__DIR__ . '/../fixtures/elementor-recaptcha-form.json'));
        $script  = (string) tempnam(sys_get_temp_dir(), 'bbs-captcha-seed-');
        file_put_contents($script, <<<PHP
            <?php
            \$id = wp_insert_post([
                'post_type'   => 'page',
                'post_title'  => 'Captcha Fixture',
                'post_name'   => 'captcha-fixture',
                'post_status' => 'publish',
            ]);
            \$tree = json_decode(file_get_contents('{$fixture}'));
            update_post_meta(\$id, '_elementor_data', json_encode(\$tree, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            echo \$id;
            PHP);

        $pageId = trim(self::wpOrFail('eval-file ' . escapeshellarg($script)));
        @unlink($script);
        $this->assertNotSame('', $pageId, 'The captcha fixture page must be created.');

        try {
            $check = $this->checkById($this->preflight()['body'], 'captcha_disabled');
            $this->assertSame('fail', $check['status']);
            $this->assertStringContainsString('Guarded Quote Request', $check['detail'], 'The failing form must be named.');
        } finally {
            self::wpOrFail('post delete ' . $pageId . ' --force', allowFailure: true);
        }

        $this->assertSame(
            'pass',
            $this->checkById($this->preflight()['body'], 'captcha_disabled')['status'],
            'Removing the captcha-protected form must restore the pass.'
        );
    }

    /**
     * The flip that matters most: a site that says production with no staging
     * counter-signal must yield verdict production and a failing
     * not_production check — this is what stops a runner pointed at a live
     * site by mistake.
     */
    public function test_production_verdict_fails_the_not_production_check(): void
    {
        self::forceHttps();
        self::setEnvironmentType('production');
        self::wpOrFail('option update home https://client-live.example.com');

        try {
            $body = $this->preflight()['body'];

            $this->assertSame('production', $body['environment']['verdict']);
            $check = $this->checkById($body, 'not_production');
            $this->assertSame('fail', $check['status']);
        } finally {
            self::wpOrFail('option update home ' . escapeshellarg(getenv('BEARDBOT_SENSORS_TEST_WP_URL') ?: 'https://bbs-int.test'), allowFailure: true);
            self::setEnvironmentType('local');
            self::removeForcedHttps();
        }
    }
}
