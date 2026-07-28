<?php

declare(strict_types=1);

namespace Tests\Integration;

/**
 * End-to-end test of GET /inventory against the provisioned site and its
 * seeded fixtures (see provision.sh): WooCommerce and Contact Form 7 active,
 * a $1.00 "Test Product", and a page carrying Elementor form-widget meta with
 * no Elementor installed — proving the scan is genuinely meta parsing.
 *
 * Skipped unless BEARDBOT_SENSORS_TEST_WP_PATH points at a provisioned
 * WordPress (see tests/Integration/provision.sh).
 */
final class RestInventoryTest extends RestTestCase
{
    private const ROUTE = '/index.php?rest_route=/beardbot-sensors/v1/inventory';

    private const CAP_USER = 'admin';

    private static string $capPassword = '';

    /** @var array<string, mixed> Fetched once; the route is read-only. */
    private static array $inventory = [];

    public static function setUpBeforeClass(): void
    {
        self::requireProvisionedSite();
        self::bootLocalEnvironment();
        self::$capPassword = self::createApplicationPassword(self::CAP_USER, 'bbs-inventory-test');
        self::startServer();
    }

    public static function tearDownAfterClass(): void
    {
        self::stopServer();

        if (isset(self::$wpPath)) {
            self::restoreEnvironment();
        }
    }

    /** @return array<string, mixed> */
    private function inventory(): array
    {
        if (self::$inventory === []) {
            $response = $this->get(self::ROUTE, self::CAP_USER, self::$capPassword);
            $this->assertSame(200, $response['status'], 'An authorised inventory request should be served.');
            self::$inventory = $response['body'];
        }

        return self::$inventory;
    }

    /** The gate guards this route exactly as it guards /version. */
    public function test_unauthenticated_inventory_is_refused(): void
    {
        $response = $this->get(self::ROUTE);

        $this->assertSame(401, $response['status']);
        $this->assertSame('beardbot_sensors_not_authenticated', $response['body']['code'] ?? null);
        $this->assertArrayNotHasKey('pages', $response['body']);
    }

    public function test_response_carries_the_contract_version(): void
    {
        $inventory = $this->inventory();

        $this->assertSame(1, $inventory['api_version'] ?? null);
        $this->assertArrayHasKey('plugin_version', $inventory);
    }

    public function test_site_block_reports_the_local_environment(): void
    {
        $site = $this->inventory()['site'] ?? [];

        $this->assertSame('local', $site['environment'] ?? null);
        $this->assertNotSame('', (string) ($site['url'] ?? ''));
        $this->assertNotSame('', (string) ($site['name'] ?? ''));
    }

    public function test_pages_include_the_fixture_page_with_a_navigable_path(): void
    {
        $pages   = $this->inventory()['pages'] ?? [];
        $bySlug  = array_column($pages, null, 'slug');
        $fixture = $bySlug['fixture-contact'] ?? null;

        $this->assertNotNull($fixture, 'The seeded fixture-contact page must be inventoried.');
        $this->assertSame('Fixture Contact', $fixture['title']);
        $this->assertIsInt($fixture['id']);
        $this->assertStringStartsWith('/', (string) $fixture['path'], 'Paths must be site-relative and navigable.');
    }

    public function test_form_plugin_signals_match_the_provisioned_site(): void
    {
        $plugins = $this->inventory()['forms']['plugins'] ?? [];

        $this->assertTrue($plugins['contact_form_7']['active'] ?? null, 'CF7 is provisioned and must report active.');
        $this->assertNotNull($plugins['contact_form_7']['version']);
        $this->assertFalse($plugins['elementor_pro']['active'] ?? null, 'Elementor Pro is not installed locally.');
        $this->assertNull($plugins['elementor_pro']['version']);
        $this->assertFalse($plugins['gravity_forms']['active'] ?? null);
        $this->assertFalse($plugins['wpforms']['active'] ?? null);
    }

    /**
     * The seeded page carries `_elementor_data` with a form widget while
     * Elementor itself is absent — the instance appearing here proves the scan
     * parses meta rather than asking Elementor.
     */
    public function test_elementor_form_instance_is_found_without_elementor_installed(): void
    {
        $instances = $this->inventory()['forms']['instances'] ?? [];
        $fixture   = null;
        foreach ($instances as $instance) {
            if (($instance['form_name'] ?? '') === 'Fixture Enquiry Form') {
                $fixture = $instance;
                break;
            }
        }

        $this->assertNotNull($fixture, 'The seeded Elementor form must be inventoried.');
        $this->assertSame('elementor_pro', $fixture['provider']);
        $this->assertFalse($fixture['has_recaptcha']);
        $this->assertSame('Send Enquiry', $fixture['submit_text']);
        $this->assertStringStartsWith('/', (string) $fixture['page_path']);

        $this->assertSame(
            [
                ['type' => 'text', 'label' => 'Name', 'required' => true, 'custom_id' => 'name'],
                ['type' => 'email', 'label' => 'Email', 'required' => true, 'custom_id' => 'email'],
                ['type' => 'textarea', 'label' => 'Message', 'required' => false, 'custom_id' => 'message'],
            ],
            $fixture['fields'],
            'The field schema must match the seeded widget exactly — these labels are what the runner will trust.'
        );
    }

    public function test_woocommerce_block_reports_the_seeded_test_product(): void
    {
        $woo = $this->inventory()['woocommerce'] ?? [];

        $this->assertTrue($woo['active'] ?? null);
        $this->assertNotSame('', (string) ($woo['version'] ?? ''));
        $this->assertIsArray($woo['paths']);

        $slugs = array_column($woo['test_product_candidates'] ?? [], 'slug');
        $this->assertContains('test-product', $slugs, 'The seeded $1.00 Test Product must qualify as a candidate.');
        $this->assertLessThanOrEqual(5, count($woo['test_product_candidates']));
    }

    public function test_active_plugins_are_listed_by_file_name_and_version(): void
    {
        $plugins = $this->inventory()['plugins'] ?? [];
        $files   = array_column($plugins, 'file');

        $this->assertContains('beardbot-sensors/beardbot-sensors.php', $files);
        $this->assertContains('woocommerce/woocommerce.php', $files);
        $this->assertContains('contact-form-7/wp-contact-form-7.php', $files);

        foreach ($plugins as $plugin) {
            $this->assertNotSame('', (string) $plugin['name'], "Plugin {$plugin['file']} must carry a name.");
        }
    }

    public function test_theme_block_names_the_active_theme(): void
    {
        $theme = $this->inventory()['theme'] ?? [];

        $this->assertNotSame('', (string) ($theme['name'] ?? ''));
        $this->assertNotSame('', (string) ($theme['stylesheet'] ?? ''));
    }
}
