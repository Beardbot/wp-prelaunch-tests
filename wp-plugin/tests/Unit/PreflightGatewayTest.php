<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\Preflight;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Gateway classification. The dangerous misread is 'live' classified as
 * anything else — that is a real card being charged by a test run — so a
 * recognised gateway with test mode missing or off must classify 'live',
 * and an unrecognised gateway must classify 'unknown', never quietly safe.
 */
final class PreflightGatewayTest extends TestCase
{
    /** @return array<string, array{string, array<string, mixed>, string}> */
    public static function gateways(): array
    {
        return [
            'bank transfer is offline'                  => ['bacs', [], 'offline'],
            'cheque is offline'                         => ['cheque', [], 'offline'],
            'cash on delivery is offline'               => ['cod', [], 'offline'],
            'stripe in test mode'                       => ['stripe', ['testmode' => 'yes'], 'test'],
            'stripe with test mode off is live'         => ['stripe', ['testmode' => 'no'], 'live'],
            'stripe with no test mode setting is live'  => ['stripe', [], 'live'],
            'stripe sub-gateway follows the same rule'  => ['stripe_cc', ['testmode' => 'yes'], 'test'],
            'woopayments in test mode'                  => ['woocommerce_payments', ['test_mode' => '1'], 'test'],
            'woopayments boolean test mode'             => ['woocommerce_payments', ['test_mode' => true], 'test'],
            'woopayments live'                          => ['woocommerce_payments', ['test_mode' => ''], 'live'],
            'paypal sandbox'                            => ['paypal', ['testmode' => 'yes'], 'test'],
            'paypal live'                               => ['paypal', ['testmode' => 'no'], 'live'],
            'unrecognised gateway is unknown'           => ['square_credit_card', ['sandbox' => 'yes'], 'unknown'],
            'unrecognised even when it looks safe'      => ['some_gateway', ['testmode' => 'yes'], 'unknown'],
        ];
    }

    /** @param array<string, mixed> $settings */
    #[DataProvider('gateways')]
    public function test_classification(string $id, array $settings, string $expected): void
    {
        $this->assertSame($expected, Preflight::classify_gateway($id, $settings));
    }
}
