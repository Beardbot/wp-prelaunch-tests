<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\Environment;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The verdict matrix. The runner refuses journeys on `production` and fails
 * closed on `unknown`, so the cases that matter most are the ones where
 * WordPress claims production: any staging counter-signal must win, and a
 * clean production claim must be believed.
 */
final class EnvironmentVerdictTest extends TestCase
{
    /** @return array<string, array{string, bool, string, string}> */
    public static function verdicts(): array
    {
        return [
            'clean production claim is believed'       => ['production', true, 'www.client.com', 'production'],
            'production but search-blocked is staging' => ['production', false, 'www.client.com', 'staging'],
            'production on a staging host is staging'  => ['production', true, 'staging.client.com', 'staging'],
            'production on a dev host is staging'      => ['production', true, 'dev.client.com', 'staging'],
            'production on beardbot.dev is staging'    => ['production', true, 'lqs.beardbot.dev', 'staging'],
            'production on a .test host is staging'    => ['production', true, 'bbs-int.test', 'staging'],
            'production on a .local host is staging'   => ['production', true, 'mysite.local', 'staging'],
            'local environment type is staging'        => ['local', true, 'www.client.com', 'staging'],
            'development environment type is staging'  => ['development', true, 'www.client.com', 'staging'],
            'staging environment type is staging'      => ['staging', true, 'www.client.com', 'staging'],
            'unrecognised type with no signals'        => ['weird-custom-value', true, 'www.client.com', 'unknown'],
            'empty type with no signals'               => ['', true, 'www.client.com', 'unknown'],
        ];
    }

    #[DataProvider('verdicts')]
    public function test_verdict(string $type, bool $public, string $host, string $expected): void
    {
        $result = Environment::verdict($type, $public, $host);

        $this->assertSame($expected, $result['verdict']);
        $this->assertNotSame([], $result['signals'], 'Every verdict must explain itself with at least one signal.');
    }

    /** "test" inside a hostname is not the .test TLD; "staging" mid-host is not the staging. prefix. */
    public function test_host_patterns_do_not_overmatch(): void
    {
        $this->assertFalse(Environment::host_is_staging('www.test.com'));
        $this->assertFalse(Environment::host_is_staging('contest.example.com'));
        $this->assertFalse(Environment::host_is_staging('acme-staging.com'));
        $this->assertFalse(Environment::host_is_staging('mylocal.com'));

        $this->assertTrue(Environment::host_is_staging('staging.acme.com'));
        $this->assertTrue(Environment::host_is_staging('dev.acme.com'));
        $this->assertTrue(Environment::host_is_staging('anything.beardbot.dev'));
        $this->assertTrue(Environment::host_is_staging('BBS-INT.TEST'), 'Host matching must be case-insensitive.');
    }

    public function test_signals_name_every_contributing_counter_signal(): void
    {
        $result = Environment::verdict('production', false, 'staging.client.com');

        $this->assertSame('staging', $result['verdict']);
        $this->assertCount(2, $result['signals'], 'Both the blog_public and host signals must be reported.');
    }
}
