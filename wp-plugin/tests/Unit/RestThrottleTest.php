<?php

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;
use BeardbotSensors\Rest\Throttle;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: tests/Unit/RestThrottleTest.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: mechanical renames (namespace, example service-user name) —
 * assertions intentionally identical.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * The pure, WordPress-free core of REST authentication throttling: which client
 * address a request is counted against, how the counter advances, and when a
 * caller is over the limit. Storage (transients) and the integration with
 * WordPress's own application-password authentication are covered by the
 * integration suite.
 */
final class RestThrottleTest extends TestCase
{
    /**
     * Only REMOTE_ADDR is trusted. Forwarded headers are attacker-controlled,
     * so honouring one would let a single client mint a fresh throttle identity
     * per request and never be locked out at all.
     */
    public function test_forwarded_headers_are_never_trusted(): void
    {
        $server = [
            'REMOTE_ADDR'          => '203.0.113.9',
            'HTTP_X_FORWARDED_FOR' => '198.51.100.1',
            'HTTP_X_REAL_IP'       => '198.51.100.2',
            'HTTP_CLIENT_IP'       => '198.51.100.3',
        ];

        $this->assertSame('203.0.113.9', Throttle::client_ip($server));
    }

    public function test_client_ip_accepts_ipv4_and_ipv6(): void
    {
        $this->assertSame('203.0.113.9', Throttle::client_ip(['REMOTE_ADDR' => '203.0.113.9']));
        $this->assertSame('2001:db8::1', Throttle::client_ip(['REMOTE_ADDR' => '2001:db8::1']));
    }

    /**
     * A missing or nonsensical REMOTE_ADDR resolves to the empty string rather
     * than being stored verbatim: it still forms a usable throttle bucket, and
     * nothing unvalidated reaches the key.
     */
    public function test_client_ip_rejects_missing_or_malformed_addresses(): void
    {
        $this->assertSame('', Throttle::client_ip([]));
        $this->assertSame('', Throttle::client_ip(['REMOTE_ADDR' => '']));
        $this->assertSame('', Throttle::client_ip(['REMOTE_ADDR' => 'not-an-ip']));
        $this->assertSame('', Throttle::client_ip(['REMOTE_ADDR' => '203.0.113.9, 198.51.100.1']));
    }

    /**
     * Counting is keyed on address *and* username, so one attacker behind a
     * shared proxy address cannot lock out every other caller by exhausting a
     * single counter.
     */
    public function test_counter_keys_separate_addresses_and_usernames(): void
    {
        $a = Throttle::transient_key('203.0.113.9', 'beardbot-sensors');
        $b = Throttle::transient_key('203.0.113.9', 'admin');
        $c = Throttle::transient_key('198.51.100.1', 'beardbot-sensors');

        $this->assertNotSame($a, $b, 'Two usernames from one address must count separately.');
        $this->assertNotSame($a, $c, 'Two addresses using one username must count separately.');
        $this->assertSame($a, Throttle::transient_key('203.0.113.9', 'beardbot-sensors'), 'The key must be stable.');
    }

    /**
     * The key is hashed, so neither the address nor the username is readable in
     * the options table, and the name stays well inside WordPress's length cap
     * for transients however long the supplied username is.
     */
    public function test_counter_key_is_hashed_and_short(): void
    {
        $key = Throttle::transient_key('203.0.113.9', str_repeat('long-username-', 40));

        $this->assertStringNotContainsString('203.0.113.9', $key);
        $this->assertStringNotContainsString('long-username', $key);
        $this->assertLessThan(172, strlen($key), 'Transient names are length-capped by WordPress.');
    }

    public function test_first_failure_starts_the_window(): void
    {
        $state = Throttle::advance(null, 1_000);

        $this->assertSame(1, $state['count']);
        $this->assertSame(1_000, $state['first']);
    }

    /**
     * The window is anchored to the first failure and is never pushed forward
     * by later ones. A sliding window would let a continuous attacker keep a
     * legitimate account locked out for as long as they cared to keep trying.
     */
    public function test_later_failures_increment_without_extending_the_window(): void
    {
        $state = Throttle::advance(null, 1_000);
        $state = Throttle::advance($state, 1_050);
        $state = Throttle::advance($state, 1_400);

        $this->assertSame(3, $state['count']);
        $this->assertSame(1_000, $state['first'], 'The window must stay anchored to the first failure.');
    }

    /** Corrupt or partial stored state restarts cleanly rather than throwing. */
    public function test_unusable_stored_state_restarts_the_window(): void
    {
        $state = Throttle::advance(['count' => 4], 2_000);

        $this->assertSame(1, $state['count']);
        $this->assertSame(2_000, $state['first']);
    }

    public function test_seconds_remaining_counts_down_from_the_first_failure(): void
    {
        $state = ['count' => 3, 'first' => 1_000];

        $this->assertSame(900, Throttle::seconds_remaining($state, 1_000, 900));
        $this->assertSame(600, Throttle::seconds_remaining($state, 1_300, 900));
    }

    /**
     * Never zero: set_transient() reads a zero expiry as "store forever", which
     * would turn an expired window into a permanent lockout.
     */
    public function test_seconds_remaining_never_reaches_zero(): void
    {
        $state = ['count' => 3, 'first' => 1_000];

        $this->assertSame(1, Throttle::seconds_remaining($state, 1_900, 900));
        $this->assertSame(1, Throttle::seconds_remaining($state, 9_999, 900));
    }

    /** The limit is inclusive: the fifth failure of five locks the caller out. */
    public function test_limit_is_reached_at_the_configured_maximum(): void
    {
        $this->assertFalse(Throttle::is_over_limit(4, 5));
        $this->assertTrue(Throttle::is_over_limit(5, 5));
        $this->assertTrue(Throttle::is_over_limit(6, 5));
    }
}
