<?php

declare(strict_types=1);

namespace Tests\Integration;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: tests/Integration/RestAuthTest.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: mechanical renames (route namespace, error-code prefixes,
 * capability name, fixture usernames); the WP-CLI version cross-check in the
 * success test is replaced with an api_version contract assertion — this
 * plugin has no WP-CLI command. Every assertion about the gate's behaviour is
 * otherwise identical to the source.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * End-to-end test of the REST sensor surface's authentication and
 * authorisation, over real HTTP against a real WordPress.
 *
 * This is the test that matters for the harness slice: the plugin becomes
 * web-reachable here, so the refusals have to be exercised the way an attacker
 * would meet them — a real socket, a real Authorization header, real
 * application-password verification by WordPress core — not by calling the
 * permission callback directly. A PHP built-in server is started against the
 * provisioned site for the duration of the class (see RestTestCase).
 *
 * Skipped unless BEARDBOT_SENSORS_TEST_WP_PATH points at a provisioned
 * WordPress with the sensor plugin active (see tests/Integration/provision.sh).
 *
 * The built-in server speaks plain HTTP, which the plugin refuses by design;
 * the site runs as a `local` environment for the class — core's own exception.
 * The refusal is not skipped as a result:
 * test_plain_http_is_refused_outside_a_local_environment switches the site
 * back to `production` and asserts that the same request is then turned away.
 */
final class RestAuthTest extends RestTestCase
{
    private const ROUTE = '/index.php?rest_route=/beardbot-sensors/v1/version';

    /** A user holding manage_beardbot_sensors (administrator). */
    private const CAP_USER = 'admin';

    /** A valid login deliberately without the capability. */
    private const NOCAP_USER = 'bbs-nocap';

    private static string $capPassword   = '';
    private static string $nocapPassword = '';

    public static function setUpBeforeClass(): void
    {
        self::requireProvisionedSite();
        self::bootLocalEnvironment();

        // A valid login without manage_beardbot_sensors. Subscriber is the
        // weakest real role, so it also proves the gate is not simply
        // "is anyone logged in".
        self::wpOrFail('user create ' . self::NOCAP_USER . ' bbs-nocap@example.com --role=subscriber --user_pass=irrelevant', allowFailure: true);

        self::$capPassword   = self::createApplicationPassword(self::CAP_USER, 'bbs-rest-test');
        self::$nocapPassword = self::createApplicationPassword(self::NOCAP_USER, 'bbs-rest-test');

        self::startServer();
    }

    public static function tearDownAfterClass(): void
    {
        self::stopServer();

        if (isset(self::$wpPath)) {
            self::wpOrFail('user delete ' . self::NOCAP_USER . ' --yes', allowFailure: true);
            self::restoreEnvironment();
        }
    }

    protected function setUp(): void
    {
        // Each test throttles under its own username, but clear the counters
        // anyway so a failure in one test cannot cascade into the next.
        self::wpOrFail('transient delete --all', allowFailure: true);
    }

    /**
     * No credentials at all: refused, and refused as *unauthenticated* rather
     * than forbidden, so the caller is told to authenticate.
     */
    public function test_request_without_credentials_is_refused(): void
    {
        $response = $this->get(self::ROUTE);

        $this->assertSame(401, $response['status']);
        $this->assertSame('beardbot_sensors_not_authenticated', $response['body']['code'] ?? null);
        $this->assertArrayNotHasKey('plugin_version', $response['body']);
    }

    /**
     * A well-formed request carrying a password that is not a valid application
     * password is refused by WordPress core before the route is ever dispatched.
     */
    public function test_malformed_credentials_are_refused(): void
    {
        $response = $this->get(self::ROUTE, self::CAP_USER, 'not-a-real-application-password');

        $this->assertSame(401, $response['status']);
        $this->assertArrayNotHasKey('plugin_version', $response['body']);
    }

    /** An unknown username is refused the same way, and leaks no version data. */
    public function test_unknown_username_is_refused(): void
    {
        $response = $this->get(self::ROUTE, 'no-such-user-here', 'whatever-password-value');

        $this->assertSame(401, $response['status']);
        $this->assertArrayNotHasKey('plugin_version', $response['body']);
    }

    /**
     * The permission model's real test: a genuine, correctly authenticated
     * application password for a user who does not hold manage_beardbot_sensors
     * gets 403. Authentication succeeding is not authorisation.
     */
    public function test_valid_credentials_without_the_capability_are_forbidden(): void
    {
        $response = $this->get(self::ROUTE, self::NOCAP_USER, self::$nocapPassword);

        $this->assertSame(
            403,
            $response['status'],
            'A valid login without manage_beardbot_sensors must be refused with 403, not served.'
        );
        $this->assertSame('beardbot_sensors_forbidden', $response['body']['code'] ?? null);
        $this->assertArrayNotHasKey('plugin_version', $response['body']);
    }

    /** Only the last case succeeds: valid credentials that hold the capability. */
    public function test_valid_credentials_with_the_capability_succeed(): void
    {
        $response = $this->get(self::ROUTE, self::CAP_USER, self::$capPassword);

        $this->assertSame(200, $response['status'], 'An authorised application password should be served.');
        $this->assertArrayHasKey('plugin_version', $response['body']);

        // The runner treats an api_version mismatch as plugin-absent, so the
        // probe route must report the contract version it actually serves.
        $this->assertSame(1, $response['body']['api_version'] ?? null);
    }

    /**
     * The route is not advertised in the public REST index. An unauthenticated
     * caller reading /wp-json/ should not be handed the location of an
     * administrator-capable surface.
     */
    public function test_route_is_not_advertised_in_the_public_index(): void
    {
        $index = $this->get('/index.php?rest_route=/');

        $this->assertSame(200, $index['status']);
        $this->assertArrayHasKey('namespaces', $index['body']);
        $this->assertNotContains(
            'beardbot-sensors/v1',
            $index['body']['namespaces'] ?? [],
            'The sensor namespace should not be listed in the public REST index.'
        );

        $ours = array_filter(
            array_keys($index['body']['routes'] ?? []),
            static fn(string $route) => str_starts_with($route, '/beardbot-sensors/v1')
        );
        $this->assertSame([], array_values($ours), 'No sensor route may appear in the public REST index.');
    }

    /**
     * Repeated failures stop being answered. After the configured maximum the
     * surface returns 429 with a Retry-After, and — the part that actually
     * matters — WordPress no longer verifies the supplied password at all,
     * because application passwords are suppressed for the locked-out caller.
     */
    public function test_repeated_failures_are_throttled(): void
    {
        $probe = 'bbs-throttle-probe';

        $statuses = [];
        for ($i = 0; $i < 7; $i++) {
            $statuses[] = $this->get(self::ROUTE, $probe, 'wrong-password-attempt-' . $i)['status'];
        }

        $this->assertContains(
            429,
            $statuses,
            'Repeated authentication failures should eventually be throttled; got: ' . implode(',', $statuses)
        );

        $final = $this->get(self::ROUTE, $probe, 'wrong-password-attempt-final');
        $this->assertSame(429, $final['status']);
        $this->assertSame('beardbot_sensors_too_many_attempts', $final['body']['code'] ?? null);
        $this->assertArrayHasKey('retry-after', $final['headers'], 'A 429 should tell the caller when to retry.');
        $this->assertGreaterThan(0, (int) $final['headers']['retry-after']);
    }

    /**
     * Throttling is scoped to the caller, not the site: locking one identity
     * out must not deny service to a legitimate operator. This is the property
     * that makes the throttle safe to ship on a client site.
     */
    public function test_throttling_one_caller_does_not_lock_out_another(): void
    {
        for ($i = 0; $i < 7; $i++) {
            $this->get(self::ROUTE, 'bbs-noisy-neighbour', 'wrong-password-' . $i);
        }

        $authorised = $this->get(self::ROUTE, self::CAP_USER, self::$capPassword);

        $this->assertSame(
            200,
            $authorised['status'],
            'A throttled identity must not deny service to a different, authorised caller.'
        );
    }

    /**
     * The HTTPS requirement, exercised for real: switch the site out of `local`
     * and the same plain-HTTP request is refused as insecure transport rather
     * than served or merely 401'd. The refusal happens before authentication is
     * considered, so it does not depend on any credential being sent.
     */
    public function test_plain_http_is_refused_outside_a_local_environment(): void
    {
        self::setEnvironmentType('production');

        try {
            $response = $this->get(self::ROUTE);

            $this->assertSame(
                403,
                $response['status'],
                'Plain HTTP must be refused outside a local environment.'
            );
            $this->assertSame('beardbot_sensors_insecure_transport', $response['body']['code'] ?? null);

            // And a genuine credential fares no better — an application
            // password must never be accepted over an unencrypted connection.
            $withCredential = $this->get(self::ROUTE, self::CAP_USER, self::$capPassword);
            $this->assertNotSame(
                200,
                $withCredential['status'],
                'A valid application password must not be honoured over plain HTTP.'
            );
            $this->assertArrayNotHasKey('plugin_version', $withCredential['body']);
        } finally {
            self::setEnvironmentType('local');
        }
    }
}
