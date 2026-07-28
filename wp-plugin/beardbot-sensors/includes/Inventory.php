<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * Assembles the authoritative site inventory the runner consumes instead of
 * sitemap/DOM guesswork: pages, form instances with their real field schemas,
 * WooCommerce paths and safe test-product candidates, theme, and active
 * plugins.
 *
 * Read-only by construction — every method only queries. Nothing here is
 * cached: the runner calls this once per import/generation, staleness would be
 * worse than the query cost, and the site's own page cache is bypassed by the
 * runner's cache-bust parameter.
 */
final class Inventory
{
    /**
     * Upper bound on pages returned. Exists for the same reason as
     * FormScan::SCAN_BOUND — a pre-launch site is far smaller than this, and
     * the runner caps far lower again when importing.
     */
    public const PAGES_BOUND = 200;

    /** Candidate products are capped here; the runner needs one, not a catalogue. */
    public const PRODUCT_CANDIDATES_CAP = 5;

    /** @return array<string, mixed> */
    public static function collect(): array
    {
        return [
            'site'        => self::site(),
            'pages'       => self::pages(),
            'forms'       => self::forms(),
            'woocommerce' => self::woocommerce(),
            'theme'       => self::theme(),
            'plugins'     => self::plugins(),
        ];
    }

    // ─── Pure decision logic (no WordPress) ──────────────────────────────────

    /**
     * Whether a product is safe for the runner to buy in a test checkout:
     * actually orderable, and either cheap enough that a mistaken live-mode
     * charge is trivial, or explicitly named as a test product.
     */
    public static function is_test_product_candidate(
        bool $purchasable,
        bool $in_stock,
        float $price,
        string $name,
        string $slug
    ): bool {
        if (!$purchasable || !$in_stock) {
            return false;
        }
        return $price <= 5.00
            || stripos($name, 'test') !== false
            || stripos($slug, 'test') !== false;
    }

    // ─── Sections ────────────────────────────────────────────────────────────

    /** @return array<string, string> */
    private static function site(): array
    {
        return [
            'name'        => get_bloginfo('name'),
            'url'         => home_url('/'),
            'environment' => wp_get_environment_type(),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    private static function pages(): array
    {
        $query = new \WP_Query([
            'post_type'              => 'page',
            'post_status'            => 'publish',
            'posts_per_page'         => self::PAGES_BOUND,
            'orderby'                => 'menu_order title',
            'order'                  => 'ASC',
            'no_found_rows'          => true,
            'update_post_term_cache' => false,
        ]);

        $pages = [];
        foreach ($query->posts as $post) {
            $pages[] = [
                'id'       => (int) $post->ID,
                'slug'     => (string) $post->post_name,
                'path'     => wp_make_link_relative((string) get_permalink($post)),
                'title'    => (string) $post->post_title,
                'template' => get_page_template_slug($post) ?: 'default',
            ];
        }

        return $pages;
    }

    /** @return array<string, mixed> */
    private static function forms(): array
    {
        return [
            'plugins'   => [
                'elementor_pro'  => self::plugin_signal(defined('ELEMENTOR_PRO_VERSION'), defined('ELEMENTOR_PRO_VERSION') ? (string) ELEMENTOR_PRO_VERSION : null),
                'gravity_forms'  => self::plugin_signal(class_exists('\GFForms'), class_exists('\GFForms') ? (string) \GFForms::$version : null),
                'wpforms'        => self::plugin_signal(defined('WPFORMS_VERSION'), defined('WPFORMS_VERSION') ? (string) WPFORMS_VERSION : null),
                'contact_form_7' => self::plugin_signal(defined('WPCF7_VERSION'), defined('WPCF7_VERSION') ? (string) WPCF7_VERSION : null),
            ],
            'instances' => array_merge(
                FormScan::scan(),
                self::gravity_forms_instances(),
                self::wpforms_instances()
                // Contact Form 7 is a presence flag only in v1: its shortcode
                // placement is not discoverable from meta the way Elementor's
                // is, and the runner's DOM inspection finds the rendered form.
            ),
        ];
    }

    /** @return array{active: bool, version: string|null} */
    private static function plugin_signal(bool $active, ?string $version): array
    {
        return ['active' => $active, 'version' => $active ? $version : null];
    }

    /**
     * Gravity Forms registers forms site-wide, not per page, so instances
     * carry no page_id/page_path — the runner locates the rendered form.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function gravity_forms_instances(): array
    {
        if (!class_exists('\GFAPI')) {
            return [];
        }

        $instances = [];
        foreach (\GFAPI::get_forms() as $form) {
            if (!is_array($form)) {
                continue;
            }
            $fields        = [];
            $has_recaptcha = false;
            foreach ($form['fields'] ?? [] as $field) {
                $type = (string) ($field->type ?? '');
                if ($type === 'captcha') {
                    $has_recaptcha = true;
                    continue;
                }
                $fields[] = [
                    'type'      => $type,
                    'label'     => (string) ($field->label ?? ''),
                    'required'  => (bool) ($field->isRequired ?? false),
                    'custom_id' => (string) ($field->id ?? ''),
                ];
            }
            $instances[] = [
                'provider'      => 'gravity_forms',
                'page_id'       => null,
                'page_path'     => null,
                'form_name'     => (string) ($form['title'] ?? ''),
                'fields'        => $fields,
                'has_recaptcha' => $has_recaptcha,
                'submit_text'   => (string) ($form['button']['text'] ?? ''),
            ];
        }

        return $instances;
    }

    /**
     * WPForms stores each form's schema as JSON in its post_content; like
     * Gravity Forms, placement is not knowable from the form itself.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function wpforms_instances(): array
    {
        if (!function_exists('\wpforms')) {
            return [];
        }

        $forms = \wpforms()->form->get();
        if (!is_array($forms)) {
            $forms = $forms instanceof \WP_Post ? [$forms] : [];
        }

        $instances = [];
        foreach ($forms as $post) {
            if (!$post instanceof \WP_Post) {
                continue;
            }
            $data = json_decode((string) $post->post_content, true);
            if (!is_array($data)) {
                continue;
            }
            $fields = [];
            foreach (is_array($data['fields'] ?? null) ? $data['fields'] : [] as $field) {
                if (!is_array($field)) {
                    continue;
                }
                $fields[] = [
                    'type'      => (string) ($field['type'] ?? ''),
                    'label'     => (string) ($field['label'] ?? ''),
                    'required'  => !empty($field['required']),
                    'custom_id' => (string) ($field['id'] ?? ''),
                ];
            }
            $settings    = is_array($data['settings'] ?? null) ? $data['settings'] : [];
            $instances[] = [
                'provider'      => 'wpforms',
                'page_id'       => null,
                'page_path'     => null,
                'form_name'     => (string) ($settings['form_title'] ?? $post->post_title),
                'fields'        => $fields,
                'has_recaptcha' => !empty($settings['recaptcha']),
                'submit_text'   => (string) ($settings['submit_text'] ?? ''),
            ];
        }

        return $instances;
    }

    /** @return array<string, mixed> */
    private static function woocommerce(): array
    {
        if (!class_exists('\WooCommerce')) {
            return ['active' => false];
        }

        $paths = [];
        foreach (['shop', 'cart', 'checkout', 'myaccount'] as $key) {
            $page_id = (int) wc_get_page_id($key);
            if ($page_id > 0 && get_post_status($page_id) === 'publish') {
                $paths[$key] = wp_make_link_relative((string) get_permalink($page_id));
            }
        }

        return [
            'active'                  => true,
            'version'                 => (string) WC()->version,
            'paths'                   => $paths,
            'test_product_candidates' => self::test_product_candidates(),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    private static function test_product_candidates(): array
    {
        if (!function_exists('\wc_get_products')) {
            return [];
        }

        // Bounded fetch, filtered in PHP: the candidate rule (price OR name)
        // does not map to a single product query, and a staging catalogue is
        // small. The cap keeps the response tiny either way.
        $products   = \wc_get_products(['status' => 'publish', 'limit' => 100]);
        $candidates = [];
        foreach (is_array($products) ? $products : [] as $product) {
            $price = (float) $product->get_price();
            if (!self::is_test_product_candidate(
                $product->is_purchasable(),
                $product->is_in_stock(),
                $price,
                (string) $product->get_name(),
                (string) $product->get_slug()
            )) {
                continue;
            }
            $candidates[] = [
                'id'    => (int) $product->get_id(),
                'name'  => (string) $product->get_name(),
                'slug'  => (string) $product->get_slug(),
                'path'  => wp_make_link_relative((string) get_permalink($product->get_id())),
                'price' => (string) $product->get_price(),
            ];
            if (count($candidates) >= self::PRODUCT_CANDIDATES_CAP) {
                break;
            }
        }

        return $candidates;
    }

    /** @return array<string, string> */
    private static function theme(): array
    {
        $theme = wp_get_theme();

        return [
            'name'       => (string) $theme->get('Name'),
            'version'    => (string) $theme->get('Version'),
            'stylesheet' => (string) $theme->get_stylesheet(),
        ];
    }

    /**
     * Active plugins only — the inventory answers "what is this site running",
     * not "what is installed".
     *
     * @return array<int, array<string, string>>
     */
    private static function plugins(): array
    {
        if (!function_exists('\get_plugin_data')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $plugins = [];
        foreach ((array) get_option('active_plugins', []) as $file) {
            $path = WP_PLUGIN_DIR . '/' . $file;
            if (!is_string($file) || !file_exists($path)) {
                continue;
            }
            $data      = get_plugin_data($path, false, false);
            $plugins[] = [
                'file'    => $file,
                'name'    => (string) ($data['Name'] ?? ''),
                'version' => (string) ($data['Version'] ?? ''),
            ];
        }

        return $plugins;
    }
}
