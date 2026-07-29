<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * Decides whether this site is safe to test against: `staging`, `production`,
 * or `unknown`. The runner refuses to run journeys against `production`, and
 * fails closed on `unknown` — so this verdict errs toward `staging` only on
 * positive evidence, and toward `production` whenever WordPress claims it
 * with nothing contradicting.
 *
 * The decision itself is pure so the whole matrix is unit-testable; the
 * WordPress-facing report() gathers the three inputs and returns the verdict
 * with the signals that produced it, for the runner's report.
 */
final class Environment
{
    /** wp_get_environment_type() values that are themselves staging evidence. */
    private const STAGING_ENV_TYPES = ['local', 'development', 'staging'];

    /** Host suffixes that only ever serve non-production sites. */
    private const STAGING_HOST_SUFFIXES = ['.beardbot.dev', '.test', '.local'];

    /** Leading host labels conventionally reserved for non-production. */
    private const STAGING_HOST_PREFIXES = ['staging.', 'dev.'];

    // ─── Pure decision logic (no WordPress) ──────────────────────────────────

    /**
     * The verdict as one pure function of the three signals WordPress can
     * give us. `production` only when WordPress says production AND no
     * staging counter-signal exists; `staging` on any positive staging
     * signal; `unknown` otherwise (an unrecognised environment type with
     * nothing else to go on).
     *
     * @return array{verdict: string, signals: array<int, string>}
     */
    public static function verdict(string $environment_type, bool $blog_public, string $host): array
    {
        $signals = [];
        if (in_array($environment_type, self::STAGING_ENV_TYPES, true)) {
            $signals[] = "wp_environment_type={$environment_type}";
        }
        if (!$blog_public) {
            $signals[] = 'blog_public=0 (search engines discouraged)';
        }
        if (self::host_is_staging($host)) {
            $signals[] = "host {$host} matches a staging pattern";
        }

        if ($signals !== []) {
            return ['verdict' => 'staging', 'signals' => $signals];
        }
        if ($environment_type === 'production') {
            return [
                'verdict' => 'production',
                'signals' => ['wp_environment_type=production with no staging counter-signal'],
            ];
        }

        return [
            'verdict' => 'unknown',
            'signals' => ["wp_environment_type={$environment_type} is not a recognised environment type"],
        ];
    }

    /** Whether a hostname looks like a staging host. Pure. */
    public static function host_is_staging(string $host): bool
    {
        $host = strtolower($host);
        foreach (self::STAGING_HOST_PREFIXES as $prefix) {
            if (str_starts_with($host, $prefix)) {
                return true;
            }
        }
        foreach (self::STAGING_HOST_SUFFIXES as $suffix) {
            if (str_ends_with($host, $suffix)) {
                return true;
            }
        }

        return false;
    }

    // ─── WordPress-side report ───────────────────────────────────────────────

    /** @return array{wp_environment_type: string, verdict: string, signals: array<int, string>} */
    public static function report(): array
    {
        $type    = wp_get_environment_type();
        $host    = (string) wp_parse_url(home_url(), PHP_URL_HOST);
        $public  = (string) get_option('blog_public', '1') !== '0';
        $verdict = self::verdict($type, $public, $host);

        return [
            'wp_environment_type' => $type,
            'verdict'             => $verdict['verdict'],
            'signals'             => $verdict['signals'],
        ];
    }
}
