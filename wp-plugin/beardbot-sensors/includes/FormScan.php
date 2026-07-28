<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * Finds Elementor Pro form widgets by parsing `_elementor_data` post meta.
 *
 * Elementor stores each document's element tree as JSON in that meta key, so
 * the scan is pure meta parsing — Elementor (free or Pro) does not need to be
 * installed or loaded for the scan to find form widgets, which is also what
 * makes it unit-testable against fixture JSON. The tree is walked through any
 * `elements` array regardless of element type, so sections, columns, and the
 * newer containers all traverse the same way.
 */
final class FormScan
{
    /** Elementor's document tree, as stored by Elementor itself. */
    public const META_KEY = '_elementor_data';

    /**
     * Upper bound on documents scanned. A pre-launch staging site is far
     * smaller than this; the bound exists so a pathological site cannot make
     * the inventory route do unbounded work.
     */
    public const SCAN_BOUND = 200;

    /**
     * Elementor Pro's captcha field types. They surface as `has_recaptcha`
     * rather than as fillable fields, because the runner needs "this form will
     * block automation" as a single signal, not a field to try to fill.
     */
    private const RECAPTCHA_FIELD_TYPES = ['recaptcha', 'recaptcha_v3'];

    // ─── Pure parsing (no WordPress) ─────────────────────────────────────────

    /**
     * Extract every form widget from one document's `_elementor_data` JSON.
     *
     * Malformed JSON yields no forms rather than an error: the meta is
     * third-party data, and one broken document must not take down the whole
     * inventory response.
     *
     * @return array<int, array{form_name: string, fields: array<int, array{type: string, label: string, required: bool, custom_id: string}>, has_recaptcha: bool, submit_text: string}>
     */
    public static function extract_forms(string $elementor_data): array
    {
        $tree = json_decode($elementor_data, true);
        if (!is_array($tree)) {
            return [];
        }

        $forms = [];
        self::walk($tree, $forms);

        return $forms;
    }

    /** @param array<int, mixed> $elements */
    private static function walk(array $elements, array &$forms): void
    {
        foreach ($elements as $element) {
            if (!is_array($element)) {
                continue;
            }
            if (($element['widgetType'] ?? '') === 'form') {
                $settings = $element['settings'] ?? [];
                $forms[]  = self::form_from(is_array($settings) ? $settings : []);
            }
            if (isset($element['elements']) && is_array($element['elements'])) {
                self::walk($element['elements'], $forms);
            }
        }
    }

    /** @param array<string, mixed> $settings */
    private static function form_from(array $settings): array
    {
        $fields        = [];
        $has_recaptcha = false;

        $raw_fields = $settings['form_fields'] ?? [];
        foreach (is_array($raw_fields) ? $raw_fields : [] as $field) {
            if (!is_array($field)) {
                continue;
            }

            // Elementor defaults an unset field_type to text.
            $type = (string) ($field['field_type'] ?? 'text');
            if ($type === '') {
                $type = 'text';
            }

            if (in_array($type, self::RECAPTCHA_FIELD_TYPES, true)) {
                $has_recaptcha = true;
                continue;
            }

            $fields[] = [
                'type'      => $type,
                'label'     => (string) ($field['field_label'] ?? ''),
                // Elementor stores required as the string "true"; accept a
                // real boolean too in case an export normalised it.
                'required'  => ($field['required'] ?? '') === 'true' || ($field['required'] ?? false) === true,
                'custom_id' => (string) ($field['custom_id'] ?? ''),
            ];
        }

        return [
            'form_name'     => (string) ($settings['form_name'] ?? ''),
            'fields'        => $fields,
            'has_recaptcha' => $has_recaptcha,
            'submit_text'   => (string) ($settings['button_text'] ?? ''),
        ];
    }

    // ─── WordPress-side scan ─────────────────────────────────────────────────

    /**
     * Scan published content for Elementor form widgets and return one entry
     * per form instance, annotated with where it lives.
     *
     * The candidate query is a bounded LIKE over the meta value — cheap
     * because `"widgetType":"form"` can only appear in documents that actually
     * contain a form widget; extract_forms() then does the real parsing.
     *
     * @return array<int, array<string, mixed>>
     */
    public static function scan(): array
    {
        $query = new \WP_Query([
            'post_type'              => ['page', 'post', 'elementor_library'],
            'post_status'            => 'publish',
            'posts_per_page'         => self::SCAN_BOUND,
            'fields'                 => 'ids',
            'no_found_rows'          => true,
            'update_post_term_cache' => false,
            'meta_query'             => [
                [
                    'key'     => self::META_KEY,
                    'value'   => '"widgetType":"form"',
                    'compare' => 'LIKE',
                ],
            ],
        ]);

        $instances = [];
        foreach ($query->posts as $post_id) {
            $meta = get_post_meta((int) $post_id, self::META_KEY, true);
            if (!is_string($meta) || $meta === '') {
                continue;
            }
            foreach (self::extract_forms($meta) as $form) {
                $instances[] = [
                    'provider'  => 'elementor_pro',
                    'page_id'   => (int) $post_id,
                    'page_path' => wp_make_link_relative((string) get_permalink((int) $post_id)),
                ] + $form;
            }
        }

        return $instances;
    }
}
