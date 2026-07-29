<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\Recorder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The Recorder's two pure pieces: run-id validation (the gate on the
 * unauthenticated write path) and the mail summary (the privacy contract,
 * asserted as a test so weakening it means editing a test that says
 * "privacy" on it).
 */
final class RecorderTest extends TestCase
{
    // ─── Run-id validation ───────────────────────────────────────────────────

    /** @return array<string, array{mixed, bool}> */
    public static function runIds(): array
    {
        return [
            'runner-minted shape is valid' => ['wpt_lqs_20260728T101500_a1b2c3', true],
            'minimum length (8) is valid'  => ['abcd1234', true],
            'maximum length (64) is valid' => [str_repeat('a', 64), true],
            'hyphens and underscores ok'   => ['run-id_OK-123', true],
            'too short is invalid'         => ['abc1234', false],
            'too long is invalid'          => [str_repeat('a', 65), false],
            'spaces are invalid'           => ['run id 12345', false],
            'punctuation is invalid'       => ['run.id!12345', false],
            'sql-ish content is invalid'   => ["12345678' OR 1=1", false],
            'empty is invalid'             => ['', false],
            'null is invalid'              => [null, false],
        ];
    }

    #[DataProvider('runIds')]
    public function test_run_id_validation(?string $value, bool $expected): void
    {
        $this->assertSame($expected, Recorder::valid_run_id($value));
    }

    // ─── Mail summary privacy contract ───────────────────────────────────────

    public function test_summary_reduces_recipients_to_unique_domains(): void
    {
        $summary = Recorder::summarise_mail(
            ['owner@client.com', 'Sales Team <sales@client.com>', 'ops@agency.com.au'],
            'New enquiry'
        );

        $this->assertSame(['client.com', 'agency.com.au'], $summary['to_domains']);
    }

    public function test_summary_handles_comma_separated_recipient_strings(): void
    {
        $summary = Recorder::summarise_mail('a@one.com, b@two.com', 'x');

        $this->assertSame(['one.com', 'two.com'], $summary['to_domains']);
    }

    /**
     * THE PRIVACY CONTRACT. No recipient local-part and no clear-text subject
     * may appear anywhere in the summary. If this test is in your diff, you
     * are weakening the reason this table is safe to keep on a client site.
     */
    public function test_summary_carries_no_local_parts_and_no_subject_text(): void
    {
        $summary = Recorder::summarise_mail(
            'jane.customer@client.com',
            'Order #1234 for Jane Customer — card ending 4242'
        );

        $encoded = (string) json_encode($summary);
        $this->assertStringNotContainsString('jane', strtolower($encoded));
        $this->assertStringNotContainsString('Order #1234', $encoded);
        $this->assertStringNotContainsString('4242', $encoded);

        $this->assertSame(16, strlen($summary['subject_hash']));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', $summary['subject_hash']);
        $this->assertSame(strlen('Order #1234 for Jane Customer — card ending 4242'), $summary['subject_length']);
    }

    public function test_identical_subjects_hash_identically_and_different_ones_differ(): void
    {
        $a = Recorder::summarise_mail('x@y.com', 'Thanks for your enquiry');
        $b = Recorder::summarise_mail('x@y.com', 'Thanks for your enquiry');
        $c = Recorder::summarise_mail('x@y.com', 'Password reset');

        $this->assertSame($a['subject_hash'], $b['subject_hash'], 'The runner corroborates by matching hashes.');
        $this->assertNotSame($a['subject_hash'], $c['subject_hash']);
    }

    public function test_summary_tolerates_garbage_recipients(): void
    {
        $summary = Recorder::summarise_mail('not-an-address', '');

        $this->assertSame([], $summary['to_domains']);
        $this->assertSame(0, $summary['subject_length']);
    }
}
