<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\Inventory;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The pure candidate rule for test products: orderable, and either cheap
 * enough that a mistaken live-mode charge is trivial or explicitly named as a
 * test product. This is the rule that decides what the runner may put in a
 * checkout, so the refusals matter more than the acceptances.
 */
final class InventoryCandidateTest extends TestCase
{
    /** @return array<string, array{bool, bool, float, string, string, bool}> */
    public static function candidates(): array
    {
        return [
            'cheap and orderable qualifies'            => [true, true, 1.00, 'Widget', 'widget', true],
            'exactly at the price ceiling qualifies'   => [true, true, 5.00, 'Widget', 'widget', true],
            'expensive but named test qualifies'       => [true, true, 99.00, 'Test Product', 'test-product', true],
            'expensive with test only in slug'         => [true, true, 99.00, 'Widget', 'test-widget', true],
            'test match is case-insensitive'           => [true, true, 99.00, 'TESTING Sample', 'sample', true],
            'expensive and not a test product refused' => [true, true, 5.01, 'Gold Watch', 'gold-watch', false],
            'not purchasable refused even when cheap'  => [false, true, 1.00, 'Test Product', 'test-product', false],
            'out of stock refused even when cheap'     => [true, false, 1.00, 'Test Product', 'test-product', false],
            'free product qualifies'                   => [true, true, 0.00, 'Freebie', 'freebie', true],
        ];
    }

    #[DataProvider('candidates')]
    public function test_candidate_rule(
        bool $purchasable,
        bool $in_stock,
        float $price,
        string $name,
        string $slug,
        bool $expected
    ): void {
        $this->assertSame(
            $expected,
            Inventory::is_test_product_candidate($purchasable, $in_stock, $price, $name, $slug)
        );
    }
}
