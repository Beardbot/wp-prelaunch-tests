<?php

declare(strict_types=1);

namespace Tests\Integration;

/**
 * End-to-end test of the effect recorder and GET /events: a real Contact
 * Form 7 submission over HTTP carrying the X-WPT-Run-ID header must come
 * back as form_submission + mail events; a malformed header must record
 * nothing; the per-request cap, retention prune, and query limit must hold.
 *
 * Mail: the test server has no MTA, and wpcf7_mail_sent only fires when
 * wp_mail reports success — so a throwaway mu-plugin short-circuits
 * `pre_wp_mail` to true. Crucially the `wp_mail` FILTER (where the Recorder
 * listens) fires before that short-circuit, so the recorded mail event is
 * the real observation, not an artefact of the stub.
 *
 * Skipped unless BEARDBOT_SENSORS_TEST_WP_PATH points at a provisioned
 * WordPress (see tests/Integration/provision.sh).
 */
final class RestEventsTest extends RestTestCase
{
    private const EVENTS_ROUTE = '/index.php?rest_route=/beardbot-sensors/v1/events';

    private const CAP_USER = 'admin';

    private static string $capPassword = '';
    private static string $cf7FormId   = '';

    public static function setUpBeforeClass(): void
    {
        self::requireProvisionedSite();
        self::bootLocalEnvironment();
        self::$capPassword = self::createApplicationPassword(self::CAP_USER, 'bbs-events-test');

        self::$cf7FormId = trim(explode("\n", trim(self::wpOrFail(
            'post list --post_type=wpcf7_contact_form --field=ID'
        )))[0] ?? '');
        if (self::$cf7FormId === '') {
            self::fail('No Contact Form 7 form on the provisioned site (provision.sh seeds one).');
        }

        self::installMailStub();
        self::startServer();
    }

    public static function tearDownAfterClass(): void
    {
        self::stopServer();

        if (isset(self::$wpPath)) {
            self::removeMailStub();
            self::restoreEnvironment();
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private static function mailStubPath(): string
    {
        return self::$wpPath . '/wp-content/mu-plugins/bbs-test-mail-stub.php';
    }

    private static function installMailStub(): void
    {
        $dir = dirname(self::mailStubPath());
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        // pre_wp_mail: report success without an MTA. wpcf7_spam: a bare
        // HTTP client trips CF7's spam heuristics that its real front-end
        // JavaScript satisfies; the Recorder path under test starts after
        // CF7 accepts the submission, so the heuristics are stubbed out.
        file_put_contents(
            self::mailStubPath(),
            "<?php\nadd_filter('pre_wp_mail', '__return_true');\nadd_filter('wpcf7_spam', '__return_false', 100);\n"
        );
    }

    private static function removeMailStub(): void
    {
        if (file_exists(self::mailStubPath())) {
            unlink(self::mailStubPath());
        }
    }

    /**
     * Submit the seeded CF7 form through its public REST feedback endpoint,
     * exactly as the site's own front-end JavaScript would, optionally
     * carrying a run-id header.
     *
     * @return array{status: int, body: array<string, mixed>}
     */
    private function submitContactForm(?string $runId): array
    {
        $id     = self::$cf7FormId;
        $values = [
            '_wpcf7'          => $id,
            '_wpcf7_unit_tag' => "wpcf7-f{$id}-p1-o1",
            'your-name'       => 'Runner Probe',
            'your-email'      => 'probe@runner-test.invalid',
            'your-subject'    => 'Effect corroboration probe',
            'your-message'    => 'Synthetic submission from the integration suite.',
        ];

        // CF7's feedback endpoint answers 415 to anything but the
        // multipart/form-data its own front-end JavaScript sends.
        $boundary = 'bbsFormBoundary' . bin2hex(random_bytes(8));
        $fields   = '';
        foreach ($values as $name => $value) {
            $fields .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$name}\"\r\n\r\n{$value}\r\n";
        }
        $fields .= "--{$boundary}--\r\n";

        $headers = ['Content-Type: multipart/form-data; boundary=' . $boundary];
        if ($runId !== null) {
            $headers[] = 'X-WPT-Run-ID: ' . $runId;
        }

        $body = @file_get_contents(
            self::$baseUrl . "/index.php?rest_route=/contact-form-7/v1/contact-forms/{$id}/feedback",
            false,
            stream_context_create(['http' => [
                'method'        => 'POST',
                'header'        => implode("\r\n", $headers),
                'content'       => $fields,
                'ignore_errors' => true,
                'timeout'       => 30,
            ]])
        );
        $this->assertIsString($body, "No response from the CF7 feedback endpoint.\n" . self::serverLog());

        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                $status = (int) $m[1];
            }
        }
        $decoded = json_decode($body, true);

        return ['status' => $status, 'body' => is_array($decoded) ? $decoded : []];
    }

    /** @return array<int, array<string, mixed>> */
    private function eventsFor(string $runId, string $extra = ''): array
    {
        $response = $this->get(
            self::EVENTS_ROUTE . '&run_id=' . rawurlencode($runId) . $extra,
            self::CAP_USER,
            self::$capPassword
        );
        $this->assertSame(200, $response['status'], 'An authorised events request should be served.');

        return $response['body']['events'] ?? [];
    }

    /** Total rows in the events table (wp_ prefix — provision.sh's default). */
    private function eventsTableCount(): int
    {
        $out = self::wpOrFail('db query "SELECT COUNT(*) FROM wp_beardbot_sensor_events" --skip-column-names');

        return (int) trim($out);
    }

    // ─── Route guarding and argument validation ──────────────────────────────

    public function test_unauthenticated_events_request_is_refused(): void
    {
        $response = $this->get(self::EVENTS_ROUTE . '&run_id=valid_run_12345678');

        $this->assertSame(401, $response['status']);
        $this->assertArrayNotHasKey('events', $response['body']);
    }

    public function test_run_id_is_required_and_validated(): void
    {
        $missing = $this->get(self::EVENTS_ROUTE, self::CAP_USER, self::$capPassword);
        $this->assertSame(400, $missing['status'], 'run_id is required.');

        $invalid = $this->get(self::EVENTS_ROUTE . '&run_id=short', self::CAP_USER, self::$capPassword);
        $this->assertSame(400, $invalid['status'], 'A run_id failing the pattern must be refused, not queried.');
    }

    public function test_limit_is_bounded(): void
    {
        $zero = $this->get(self::EVENTS_ROUTE . '&run_id=valid_run_12345678&limit=0', self::CAP_USER, self::$capPassword);
        $this->assertSame(400, $zero['status']);

        $huge = $this->get(self::EVENTS_ROUTE . '&run_id=valid_run_12345678&limit=501', self::CAP_USER, self::$capPassword);
        $this->assertSame(400, $huge['status']);
    }

    // ─── The end-to-end corroboration path ───────────────────────────────────

    public function test_cf7_submission_with_run_id_yields_form_and_mail_events(): void
    {
        $runId = 'wpt_events_e2e_' . substr(md5((string) getmypid()), 0, 8);

        $submission = $this->submitContactForm($runId);
        $this->assertSame(200, $submission['status']);
        $this->assertSame(
            'mail_sent',
            $submission['body']['status'] ?? null,
            'The CF7 submission itself must succeed: ' . json_encode($submission['body'])
        );

        $events = $this->eventsFor($runId);
        $types  = array_column($events, 'event_type');
        sort($types);
        $this->assertSame(['form_submission', 'mail'], $types, 'One form entry and one mail handoff, nothing else.');

        foreach ($events as $event) {
            if ($event['event_type'] === 'form_submission') {
                $this->assertSame('contact_form_7', $event['provider']);
                $this->assertNotSame('', (string) ($event['summary']['form_name'] ?? ''));
            }
            if ($event['event_type'] === 'mail') {
                $summary = $event['summary'];
                $this->assertNotSame([], $summary['to_domains'] ?? [], 'The mail handoff must name recipient domains.');
                $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', (string) ($summary['subject_hash'] ?? ''));

                // Privacy contract on the wire: no local-part, no subject text.
                $encoded = (string) json_encode($event);
                $this->assertStringNotContainsString('admin@', $encoded);
                $this->assertStringNotContainsString('Effect corroboration probe', $encoded);
            }
            $this->assertNotSame('', (string) $event['request_path'], 'Events must record which request caused them.');
        }
    }

    public function test_a_malformed_run_id_header_records_nothing(): void
    {
        $before = $this->eventsTableCount();

        foreach (['bad id with spaces', 'short', str_repeat('x', 65), "12345678'--"] as $badId) {
            $submission = $this->submitContactForm($badId);
            $this->assertSame('mail_sent', $submission['body']['status'] ?? null, 'The submission itself still succeeds.');
        }

        $this->assertSame(
            $before,
            $this->eventsTableCount(),
            'A request with a malformed run-id header must not write a single row.'
        );
    }

    public function test_the_per_request_cap_and_query_limit_hold(): void
    {
        $runId  = 'wpt_events_cap_' . substr(md5((string) getmypid()), 0, 8);
        $script = (string) tempnam(sys_get_temp_dir(), 'bbs-cap-seed-');
        file_put_contents($script, <<<PHP
            <?php
            for (\$i = 0; \$i < 25; \$i++) {
                \BeardbotSensors\Events::record('{$runId}', 'mail', '', ['i' => \$i], '/eval-file');
            }
            echo 'done';
            PHP);

        try {
            self::wpOrFail('eval-file ' . escapeshellarg($script));
        } finally {
            @unlink($script);
        }

        $this->assertCount(
            20,
            $this->eventsFor($runId, '&limit=500'),
            '25 record() calls in one request must store exactly the 20-event cap.'
        );
        $this->assertCount(5, $this->eventsFor($runId, '&limit=5'), 'The query limit must bound the response.');
    }

    public function test_rows_past_retention_are_pruned_on_write(): void
    {
        $oldRun   = 'wpt_events_old_' . substr(md5((string) getmypid()), 0, 8);
        $freshRun = 'wpt_events_new_' . substr(md5((string) getmypid()), 0, 8);
        $script   = (string) tempnam(sys_get_temp_dir(), 'bbs-prune-seed-');
        file_put_contents($script, <<<PHP
            <?php
            global \$wpdb;
            \BeardbotSensors\Events::record('{$oldRun}', 'mail', '', [], '/eval-file');
            \$wpdb->query(\$wpdb->prepare(
                "UPDATE {\$wpdb->prefix}beardbot_sensor_events SET created_at = %s WHERE run_id = %s",
                gmdate('Y-m-d H:i:s', time() - 8 * DAY_IN_SECONDS),
                '{$oldRun}'
            ));
            delete_transient('bbs_last_prune');
            \BeardbotSensors\Events::record('{$freshRun}', 'mail', '', [], '/eval-file');
            echo 'done';
            PHP);

        try {
            self::wpOrFail('eval-file ' . escapeshellarg($script));
        } finally {
            @unlink($script);
        }

        $this->assertSame([], $this->eventsFor($oldRun), 'An 8-day-old row must be pruned by the next write.');
        $this->assertCount(1, $this->eventsFor($freshRun), 'The write that triggered the prune must itself survive.');
    }
}
