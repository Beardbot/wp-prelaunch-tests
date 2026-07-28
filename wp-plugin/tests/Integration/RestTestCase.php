<?php

declare(strict_types=1);

namespace Tests\Integration;

use PHPUnit\Framework\TestCase;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: tests/Integration/RestTestCase.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: env-var renames (BEARDBOT_SENSORS_TEST_WP_PATH,
 * BEARDBOT_SENSORS_TEST_WP_BIN), temp-file prefix renames, and the POST
 * helper's engine-specific 300-second timeout is reduced — this plugin has no
 * mutating routes, so nothing long-running answers a POST. The php -S boot,
 * opcache-off rationale, file-based server logging, and `?rest_route=`
 * convention are behaviour-identical to the source.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * Shared harness for integration tests that exercise the REST sensor surface
 * over real HTTP: a PHP built-in server in front of the provisioned WordPress,
 * an HTTP client that captures status/body/headers, and wp-cli helpers for
 * arranging site state. Concrete classes own their setUpBeforeClass /
 * tearDownAfterClass and compose these pieces.
 *
 * The built-in server speaks plain HTTP, which the plugin refuses outside a
 * `local` environment — so {@see bootLocalEnvironment()} marks the site local
 * (the same and only exception WordPress core makes for application passwords)
 * and disables WP-Cron, whose loopback request would queue behind the current
 * one on a single-worker server.
 */
abstract class RestTestCase extends TestCase
{
    protected static string $wpPath;
    protected static string $baseUrl;
    /** @var resource|null */
    protected static $server = null;
    protected static string $serverLogFile = '';

    // ─── Environment lifecycle ───────────────────────────────────────────────

    /** Resolve the provisioned site or skip the class. */
    protected static function requireProvisionedSite(): void
    {
        $path = getenv('BEARDBOT_SENSORS_TEST_WP_PATH');
        if ($path === false || $path === '') {
            self::markTestSkipped(
                'Integration test skipped: set BEARDBOT_SENSORS_TEST_WP_PATH to a provisioned '
                . 'WordPress with the beardbot-sensors plugin active (see tests/Integration/provision.sh).'
            );
        }
        self::$wpPath = $path;
    }

    /** Make the site REST-reachable over the plain-HTTP test server. */
    protected static function bootLocalEnvironment(): void
    {
        self::setEnvironmentType('local');
        self::setConstant('DISABLE_WP_CRON', 'true', '--raw');
    }

    /** Undo bootLocalEnvironment(); call from tearDownAfterClass. */
    protected static function restoreEnvironment(): void
    {
        self::wpOrFail('config delete WP_ENVIRONMENT_TYPE', allowFailure: true);
        self::wpOrFail('config delete DISABLE_WP_CRON', allowFailure: true);
    }

    protected static function setEnvironmentType(string $type): void
    {
        self::setConstant('WP_ENVIRONMENT_TYPE', $type);
    }

    /**
     * Set or replace a constant in the target site's wp-config.php. Deleting
     * first keeps the call idempotent across repeated runs against the same
     * provisioned site.
     */
    protected static function setConstant(string $name, string $value, string $flags = ''): void
    {
        self::wpOrFail('config delete ' . $name, allowFailure: true);
        self::wpOrFail(trim('config set ' . $name . ' ' . escapeshellarg($value) . ' ' . $flags));
    }

    /** Create a fresh application password and return the generated secret. */
    protected static function createApplicationPassword(string $user, string $label): string
    {
        $password = trim(self::wpOrFail(
            'user application-password create ' . escapeshellarg($user) . ' ' . escapeshellarg($label) . ' --porcelain'
        ));

        if ($password === '') {
            self::fail("Could not create an application password for {$user}.");
        }

        return $password;
    }

    // ─── HTTP client ─────────────────────────────────────────────────────────

    /**
     * Issue a GET against the test server, optionally with HTTP Basic
     * credentials, and return the status, decoded body, and lower-cased headers.
     *
     * @return array{status: int, body: array<string, mixed>, headers: array<string, string>}
     */
    protected function get(string $path, ?string $user = null, ?string $password = null): array
    {
        return $this->request('GET', $path, $user, $password);
    }

    /**
     * Issue a POST with a JSON body, or an empty-bodied POST when $json is
     * null. Every sensor route is GET, so a POST here is for exercising the
     * site itself (a form submission) or asserting a refusal.
     *
     * @return array{status: int, body: array<string, mixed>, headers: array<string, string>}
     */
    protected function post(string $path, ?string $user = null, ?string $password = null, ?array $json = null): array
    {
        return $this->request('POST', $path, $user, $password, $json);
    }

    /**
     * The shared HTTP client under get() and post().
     *
     * @return array{status: int, body: array<string, mixed>, headers: array<string, string>}
     */
    protected function request(
        string $method,
        string $path,
        ?string $user = null,
        ?string $password = null,
        ?array $json = null,
        int $timeout = 20
    ): array {
        $headers = [];
        if ($user !== null) {
            $headers[] = 'Authorization: Basic ' . base64_encode($user . ':' . (string) $password);
        }
        $context = [
            'http' => [
                'method'        => $method,
                'ignore_errors' => true, // read 4xx/5xx bodies instead of failing
                'timeout'       => $timeout,
            ],
        ];
        if ($json !== null) {
            $encoded = json_encode($json);
            $this->assertIsString($encoded, 'Could not encode the request body as JSON.');
            $headers[] = 'Content-Type: application/json';
            $context['http']['content'] = $encoded;
        }
        if ($headers !== []) {
            $context['http']['header'] = implode("\r\n", $headers);
        }

        $body = @file_get_contents(self::$baseUrl . $path, false, stream_context_create($context));
        if ($body === false) {
            $this->fail(sprintf(
                "No response from the test server for %s.\nLast stream error: %s\nServer log:\n%s",
                $path,
                error_get_last()['message'] ?? '(none)',
                self::serverLog()
            ));
        }

        $headers = [];
        $status  = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                $status  = (int) $m[1];
                $headers = []; // reset on a redirect chain; keep the final set
                continue;
            }
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            }
        }

        $decoded = json_decode((string) $body, true);

        return [
            'status'  => $status,
            'body'    => is_array($decoded) ? $decoded : [],
            'headers' => $headers,
        ];
    }

    // ─── Built-in server lifecycle ───────────────────────────────────────────

    /** Start a PHP built-in server serving the provisioned WordPress. */
    protected static function startServer(): void
    {
        $port = self::freePort();
        self::$baseUrl = 'http://127.0.0.1:' . $port;

        // The server writes an access-log line to stderr for every request. Sent
        // to a pipe that nothing drains, that buffer fills after a few dozen
        // requests and the server then blocks forever on the write — appearing,
        // from the test's side, as a server that silently stops answering. A
        // file has no such limit.
        self::$serverLogFile = (string) tempnam(sys_get_temp_dir(), 'bbs-rest-server-');

        // An array command runs the binary directly instead of through a shell.
        // That matters for shutdown: a shell-wrapped server leaves proc_terminate()
        // killing only the wrapper, after which proc_close() blocks forever on
        // the orphaned server that is still holding the pipes.
        //
        // Opcache is disabled deliberately. Tests edit wp-config.php mid-run to
        // change the environment type, and opcache revalidates a file only every
        // opcache.revalidate_freq seconds (2 by default) — so a request issued
        // right after the edit can still be served by the previously compiled
        // config, making environment-dependent assertions flaky.
        $cmd = [
            PHP_BINARY,
            '-d', 'opcache.enable=0',
            '-d', 'opcache.enable_cli=0',
            '-S', '127.0.0.1:' . $port,
            '-t', self::$wpPath,
        ];

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['file', self::$serverLogFile, 'a'],
            2 => ['file', self::$serverLogFile, 'a'],
        ];
        $process = proc_open($cmd, $descriptors, $pipes);
        if (!\is_resource($process)) {
            self::fail('Could not start the PHP built-in server for the REST tests.');
        }
        self::$server = $process;
        fclose($pipes[0]);

        // Wait for the socket to answer before any test runs.
        for ($attempt = 0; $attempt < 100; $attempt++) {
            $probe = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
            if (\is_resource($probe)) {
                fclose($probe);
                return;
            }
            usleep(100_000);
        }

        self::stopServer();
        self::fail("The PHP built-in server did not start on port {$port}.");
    }

    protected static function stopServer(): void
    {
        if (\is_resource(self::$server)) {
            proc_terminate(self::$server);
            proc_close(self::$server);
            self::$server = null;
        }

        if (self::$serverLogFile !== '' && file_exists(self::$serverLogFile)) {
            @unlink(self::$serverLogFile);
        }
        self::$serverLogFile = '';
    }

    /** The tail of the server's log, for diagnosing a server that stopped answering. */
    protected static function serverLog(): string
    {
        $running = \is_resource(self::$server) && (proc_get_status(self::$server)['running'] ?? false);
        $log     = self::$serverLogFile !== '' && file_exists(self::$serverLogFile)
            ? (string) file_get_contents(self::$serverLogFile)
            : '';

        return ($running ? '(server still running)' : '(SERVER HAS EXITED)')
            . "\n" . implode("\n", array_slice(explode("\n", trim($log)), -25));
    }

    /** Ask the OS for a port nothing is listening on. */
    protected static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if ($socket === false) {
            self::fail("Could not reserve a port for the test server: {$errstr}");
        }
        $name = (string) stream_socket_get_name($socket, false);
        fclose($socket);

        return (int) substr($name, strrpos($name, ':') + 1);
    }

    // ─── wp-cli ──────────────────────────────────────────────────────────────

    /**
     * Run a wp-cli subcommand against the target site, returning stdout.
     * Fails the test on a non-zero exit unless the caller opts out — some
     * setup and teardown steps are legitimately idempotent no-ops.
     */
    protected static function wpOrFail(string $subCommand, bool $allowFailure = false): string
    {
        $bin = getenv('BEARDBOT_SENSORS_TEST_WP_BIN') ?: 'wp';
        $cmd = $bin . ' --path=' . escapeshellarg(self::$wpPath) . ' ' . $subCommand;

        // stderr goes to a file rather than a second pipe: reading two pipes in
        // sequence deadlocks if the one not being read fills its buffer first.
        $errFile = (string) tempnam(sys_get_temp_dir(), 'bbs-wpcli-err-');

        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $errFile, 'a']];
        $process = proc_open($cmd, $descriptors, $pipes);
        if (!\is_resource($process)) {
            self::fail("Could not launch wp-cli: {$cmd}");
        }

        fclose($pipes[0]);
        $stdout = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        $exit = proc_close($process);

        $stderr = (string) @file_get_contents($errFile);
        @unlink($errFile);

        if ($exit !== 0 && !$allowFailure) {
            self::fail("wp-cli failed: {$cmd}\n{$stderr}");
        }

        return $stdout;
    }
}
