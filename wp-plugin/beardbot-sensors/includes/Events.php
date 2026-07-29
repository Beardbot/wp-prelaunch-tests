<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * The events table: the one sanctioned write surface of this otherwise
 * read-only plugin. Everything the Recorder observes lands here, and the
 * /events route reads it back for the runner's effect corroboration.
 *
 * The write path is reachable from unauthenticated requests (a form
 * submission carrying the run-id header is an anonymous site visitor), so it
 * is bounded on every axis: the run id must match a strict pattern, at most
 * {@see PER_REQUEST_CAP} events are recorded per request, rows expire after
 * {@see RETENTION_DAYS} days via a prune piggybacked on writes at most
 * hourly, and the summaries the Recorder stores carry no PII by contract
 * (see Recorder).
 */
final class Events
{
    /** Bumped when the schema changes; compared by maybe_install(). */
    public const DB_VERSION = 1;

    public const DB_VERSION_OPTION = 'beardbot_sensors_db_version';

    /** Rows older than this are pruned. */
    public const RETENTION_DAYS = 7;

    /** Hard cap on events recorded during a single request. */
    public const PER_REQUEST_CAP = 20;

    /** Transient gating the piggybacked prune to at most hourly. */
    private const PRUNE_TRANSIENT = 'bbs_last_prune';

    /** Events recorded during this request, for the per-request cap. */
    private static int $recorded_this_request = 0;

    public static function table(): string
    {
        global $wpdb;

        return $wpdb->prefix . 'beardbot_sensor_events';
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    public static function install(): void
    {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $table   = self::table();
        $charset = $wpdb->get_charset_collate();

        // dbDelta's whitespace rules apply: two spaces after PRIMARY KEY.
        dbDelta("CREATE TABLE {$table} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            run_id VARCHAR(64) NOT NULL,
            event_type VARCHAR(32) NOT NULL,
            provider VARCHAR(32) NOT NULL DEFAULT '',
            summary TEXT NOT NULL,
            request_path VARCHAR(255) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL,
            PRIMARY KEY  (id),
            KEY run_id (run_id)
        ) {$charset};");

        update_option(self::DB_VERSION_OPTION, self::DB_VERSION, false);
    }

    /** Install or upgrade when the stored schema version is behind. */
    public static function maybe_install(): void
    {
        if ((int) get_option(self::DB_VERSION_OPTION, 0) !== self::DB_VERSION) {
            self::install();
        }
    }

    /** Uninstall cleanup: drop the table, the version option, the prune gate. */
    public static function uninstall(): void
    {
        global $wpdb;

        $table = self::table();
        $wpdb->query("DROP TABLE IF EXISTS {$table}");
        delete_option(self::DB_VERSION_OPTION);
        delete_transient(self::PRUNE_TRANSIENT);
    }

    // ─── Writes ──────────────────────────────────────────────────────────────

    /**
     * Record one observed effect. Returns false (and stores nothing) once the
     * per-request cap is reached — a runaway page cannot fill the table.
     *
     * @param array<string, mixed> $summary
     */
    public static function record(string $run_id, string $event_type, string $provider, array $summary, string $request_path): bool
    {
        global $wpdb;

        if (self::$recorded_this_request >= self::PER_REQUEST_CAP) {
            return false;
        }
        self::$recorded_this_request++;

        $wpdb->insert(self::table(), [
            'run_id'       => $run_id,
            'event_type'   => $event_type,
            'provider'     => $provider,
            'summary'      => (string) wp_json_encode($summary),
            'request_path' => substr($request_path, 0, 255),
            'created_at'   => gmdate('Y-m-d H:i:s'),
        ], ['%s', '%s', '%s', '%s', '%s', '%s']);

        self::maybe_prune();

        return true;
    }

    // ─── Reads ───────────────────────────────────────────────────────────────

    /**
     * Events for one run, oldest first.
     *
     * @return array<int, array<string, mixed>>
     */
    public static function query(string $run_id, int $limit): array
    {
        global $wpdb;

        $table = self::table();
        $rows  = $wpdb->get_results($wpdb->prepare(
            "SELECT event_type, provider, summary, request_path, created_at
             FROM {$table} WHERE run_id = %s ORDER BY id ASC LIMIT %d",
            $run_id,
            $limit
        ), ARRAY_A);

        $events = [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            $summary  = json_decode((string) $row['summary'], true);
            $events[] = [
                'event_type'   => (string) $row['event_type'],
                'provider'     => (string) $row['provider'],
                'summary'      => is_array($summary) ? $summary : [],
                'request_path' => (string) $row['request_path'],
                'created_at'   => (string) $row['created_at'],
            ];
        }

        return $events;
    }

    // ─── Retention ───────────────────────────────────────────────────────────

    /** Delete rows past retention. Public so tests can invoke it directly. */
    public static function prune(): void
    {
        global $wpdb;

        $table  = self::table();
        $cutoff = gmdate('Y-m-d H:i:s', time() - self::RETENTION_DAYS * DAY_IN_SECONDS);
        $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE created_at < %s", $cutoff));
    }

    /** Piggyback the prune on writes, at most once an hour. */
    private static function maybe_prune(): void
    {
        if (get_transient(self::PRUNE_TRANSIENT) !== false) {
            return;
        }
        set_transient(self::PRUNE_TRANSIENT, time(), HOUR_IN_SECONDS);
        self::prune();
    }
}
