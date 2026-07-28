<?php

declare(strict_types=1);

namespace BeardbotSensors\Rest;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: plugin/beardbot-setup/includes/Rest/Throttle.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: mechanical renames only (namespace, transient prefix, filter/hook
 * names) plus docblock wording adapted to this plugin — behaviour intentionally
 * identical.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * Failed-authentication throttling for the REST sensor surface.
 *
 * A web-reachable authenticated route is exposed to credential guessing: an
 * application password is a 24-character secret an attacker can try repeatedly
 * and cheaply. This class caps that.
 *
 * Two things happen once a caller is over the limit. The permission callback
 * refuses with 429 (see {@see Controller::authorize()}), and — more importantly
 * — the controller filters `wp_is_application_passwords_available` to false for
 * the request, so WordPress never reaches the password hash comparison at all.
 * Refusing before the hash check is what makes this a real brake rather than a
 * cosmetic one: the expensive work is what an attacker is trying to make us do.
 *
 * Counting is a fixed window, not a sliding one: the window starts at the first
 * failure and is not extended by later attempts. A sliding window would let a
 * continuous attacker hold a legitimate account locked out indefinitely.
 *
 * Failures are recorded here and nowhere else. They deliberately never reach a
 * durable table: no plugin storage is reachable pre-authentication, so writing
 * attempt rows anywhere durable would hand an unauthenticated caller an
 * unbounded write primitive on a client site. Sites that want a durable trail
 * hook `beardbot_sensors_auth_failed` (fired by {@see Controller}).
 */
final class Throttle
{
    /** Transient key prefix. Short, because transient names are length-capped. */
    private const PREFIX = 'bbs_auth_fail_';

    /** Failures allowed within one window before the caller is locked out. */
    public const DEFAULT_MAX_FAILURES = 5;

    /** Length of the lockout window, in seconds. */
    public const DEFAULT_WINDOW = 900;

    // ─── Pure logic (no WordPress) ───────────────────────────────────────────

    /**
     * Resolve the client address to throttle against, from a $_SERVER-shaped
     * array. Only REMOTE_ADDR is trusted.
     *
     * X-Forwarded-For and friends are deliberately ignored: any client can send
     * them, so honouring one would let an attacker mint a fresh identity per
     * request and walk straight through the throttle. The cost is that behind a
     * reverse proxy every request shares the proxy's address — which is why the
     * counter is keyed on address *and* username, and why deployments with a
     * real proxy should supply the true client address through the
     * `beardbot_sensors_auth_client_ip` filter rather than have us guess.
     *
     * @param array<string, mixed> $server
     */
    public static function client_ip(array $server): string
    {
        $candidate = (string) ($server['REMOTE_ADDR'] ?? '');
        return filter_var($candidate, FILTER_VALIDATE_IP) === false ? '' : $candidate;
    }

    /**
     * The transient name for one throttled identity. Keyed on address *and*
     * supplied username so a shared proxy address does not collapse every
     * caller into a single counter, and hashed so neither value is readable in
     * the options table. Pure.
     */
    public static function transient_key(string $ip, string $username): string
    {
        return self::PREFIX . md5($ip . '|' . $username);
    }

    /**
     * Advance the stored counter for one more failure. Returns the new state.
     * The window is anchored to the first failure (`first`) and is never pushed
     * forward by later attempts, so a sustained attack cannot extend a lockout
     * indefinitely. Pure — the clock is passed in.
     *
     * @param array<string, int>|null $state existing state, or null for the first failure
     * @return array{count: int, first: int}
     */
    public static function advance(?array $state, int $now): array
    {
        if ($state === null || !isset($state['first'], $state['count'])) {
            return ['count' => 1, 'first' => $now];
        }
        return ['count' => (int) $state['count'] + 1, 'first' => (int) $state['first']];
    }

    /**
     * Seconds left in the window for a given state — the transient's remaining
     * lifetime, and the Retry-After the caller is told to wait. Never returns
     * less than 1, because a zero TTL means "no expiry" to set_transient().
     * Pure — the clock is passed in.
     *
     * @param array{count: int, first: int} $state
     */
    public static function seconds_remaining(array $state, int $now, int $window): int
    {
        return max(1, ((int) $state['first'] + $window) - $now);
    }

    /** Whether a failure count has passed the allowed maximum. Pure. */
    public static function is_over_limit(int $failures, int $max): bool
    {
        return $failures >= $max;
    }

    // ─── Configuration (WordPress) ───────────────────────────────────────────

    /** Failures allowed per window. Filter: `beardbot_sensors_auth_max_failures`. */
    public static function max_failures(): int
    {
        return max(1, (int) apply_filters('beardbot_sensors_auth_max_failures', self::DEFAULT_MAX_FAILURES));
    }

    /** Window length in seconds. Filter: `beardbot_sensors_auth_lockout_window`. */
    public static function window(): int
    {
        return max(1, (int) apply_filters('beardbot_sensors_auth_lockout_window', self::DEFAULT_WINDOW));
    }

    /**
     * The address this request is throttled under. Filter:
     * `beardbot_sensors_auth_client_ip` — the seam for deployments behind a
     * reverse proxy, which is the only place a forwarded header can be trusted,
     * because only the operator knows the proxy is really there.
     */
    public static function current_ip(): string
    {
        return (string) apply_filters('beardbot_sensors_auth_client_ip', self::client_ip($_SERVER));
    }

    // ─── State (WordPress) ───────────────────────────────────────────────────

    /** Whether the caller behind this request is currently locked out. */
    public static function is_locked_out(string $username): bool
    {
        $state = self::read(self::current_ip(), $username);
        if ($state === null) {
            return false;
        }
        return self::is_over_limit((int) $state['count'], self::max_failures());
    }

    /** Seconds the caller should wait before retrying (the Retry-After value). */
    public static function retry_after(string $username): int
    {
        $state = self::read(self::current_ip(), $username);
        if ($state === null) {
            return self::window();
        }
        return self::seconds_remaining($state, time(), self::window());
    }

    /**
     * Count one failed authentication attempt against this caller. The password
     * that was tried is never touched, stored, or passed on.
     */
    public static function record_failure(string $username): void
    {
        $now    = time();
        $key    = self::transient_key(self::current_ip(), $username);
        $stored = get_transient($key);

        $state = self::advance(is_array($stored) ? $stored : null, $now);
        set_transient($key, $state, self::seconds_remaining($state, $now, self::window()));
    }

    /**
     * Forget this caller's failures. Called when a request authorises cleanly,
     * so an operator who mistyped a couple of times before pasting the right
     * application password is not left sitting out the rest of the window.
     */
    public static function clear(string $username): void
    {
        delete_transient(self::transient_key(self::current_ip(), $username));
    }

    /**
     * Drop every throttle counter. Called from uninstall.php so the plugin
     * takes its own storage with it at handover.
     *
     * Only the options-table form is removed. Under an external object cache
     * transients never reach the database, and there is no way to enumerate
     * them by prefix — they expire on their own within one window, which is the
     * whole lifetime of this data anyway.
     */
    public static function purge_all(): void
    {
        global $wpdb;

        foreach (['_transient_', '_transient_timeout_'] as $prefix) {
            $wpdb->query(
                $wpdb->prepare(
                    "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
                    $wpdb->esc_like($prefix . self::PREFIX) . '%'
                )
            );
        }
    }

    /**
     * Read the stored state for one identity, or null when nothing is recorded.
     *
     * @return array{count: int, first: int}|null
     */
    private static function read(string $ip, string $username): ?array
    {
        $stored = get_transient(self::transient_key($ip, $username));
        if (!is_array($stored) || !isset($stored['count'], $stored['first'])) {
            return null;
        }
        return ['count' => (int) $stored['count'], 'first' => (int) $stored['first']];
    }
}
