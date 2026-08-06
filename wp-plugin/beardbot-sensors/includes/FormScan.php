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
 *
 * Two storage generations are understood (issue #27):
 * - Classic Pro Form widget: `widgetType: "form"` with a `form_fields`
 *   settings array.
 * - Editor V4 atomic form: an `elType: "e-form"` element whose fields are
 *   descendant widgets (`e-form-input`, `e-form-textarea`, …) with
 *   `$$type`-wrapped settings props. A label is its own widget, paired to a
 *   field by its `input-id` prop matching the field's `_cssid` prop — the
 *   same association the rendered label's `for` attribute expresses. Shapes
 *   verified against Elementor 4.2.1 source and the live V4 fixture page.
 */
final class FormScan
{
    /** Elementor's document tree, as stored by Elementor itself. */
    public const META_KEY = '_elementor_data';

    /** Editor V4 atomic form element type (stored as elType, not widgetType). */
    public const V4_FORM_ELEMENT_TYPE = 'e-form';

    /**
     * V4 field widgets a journey could interact with, mapped to the same
     * type vocabulary the classic `field_type` uses, so the runner never
     * sees which editor built the form. `e-form-input` is absent because its
     * type comes from its own `type` prop (text/email/tel/… — text default).
     */
    private const V4_FIELD_WIDGET_TYPES = [
        'e-form-textarea'    => 'textarea',
        'e-form-checkbox'    => 'checkbox',
        'e-form-radio-button' => 'radio',
        'e-form-select'      => 'select',
        'e-form-date-picker' => 'date',
        'e-form-time-picker' => 'time',
        'e-form-file-upload' => 'upload',
    ];

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
            if (($element['elType'] ?? '') === self::V4_FORM_ELEMENT_TYPE) {
                $forms[] = self::v4_form_from($element);
                // The subtree belongs to this form (nested forms are invalid
                // in the editor) — nothing else to find inside it.
                continue;
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

    // ─── Editor V4 atomic forms ──────────────────────────────────────────────

    /**
     * Build the same schema shape from an `e-form` element. Field, label,
     * and submit-button widgets may sit at any descendant depth (the editor
     * allows wrapper flexboxes around them), so the whole subtree is
     * collected first, in document order.
     *
     * @param array<string, mixed> $element
     * @return array{form_name: string, fields: array<int, array{type: string, label: string, required: bool, custom_id: string}>, has_recaptcha: bool, submit_text: string}
     */
    private static function v4_form_from(array $element): array
    {
        $settings = is_array($element['settings'] ?? null) ? $element['settings'] : [];

        $widgets = [];
        self::collect_v4_widgets(is_array($element['elements'] ?? null) ? $element['elements'] : [], $widgets);

        // Labels first: each maps its `input-id` to its text, so fields can
        // resolve their label the same way the rendered `for` attribute does.
        $labels = [];
        foreach ($widgets as $widget) {
            if (($widget['widgetType'] ?? '') === 'e-form-label') {
                $widget_settings = is_array($widget['settings'] ?? null) ? $widget['settings'] : [];
                $for             = self::string_prop($widget_settings, 'input-id');
                if ($for !== '' && !isset($labels[$for])) {
                    $labels[$for] = self::string_prop($widget_settings, 'text');
                }
            }
        }

        $fields        = [];
        $submit_text   = '';
        $has_recaptcha = false;
        foreach ($widgets as $widget) {
            $widget_type     = (string) ($widget['widgetType'] ?? '');
            $widget_settings = is_array($widget['settings'] ?? null) ? $widget['settings'] : [];

            if ($widget_type === 'e-form-submit-button') {
                if ($submit_text === '') {
                    $submit_text = self::string_prop($widget_settings, 'text');
                }
                continue;
            }
            // No captcha widget exists in the V4 catalogue today; if one
            // appears, surface it as the signal rather than a fillable field.
            if (strpos($widget_type, 'captcha') !== false) {
                $has_recaptcha = true;
                continue;
            }

            $type = null;
            if ($widget_type === 'e-form-input') {
                $type = self::string_prop($widget_settings, 'type');
                if ($type === '') {
                    $type = 'text';
                }
            } elseif (isset(self::V4_FIELD_WIDGET_TYPES[$widget_type])) {
                $type = self::V4_FIELD_WIDGET_TYPES[$widget_type];
            }
            if ($type === null) {
                continue;
            }

            $custom_id = self::string_prop($widget_settings, '_cssid');
            $label     = $labels[$custom_id] ?? '';
            if ($label === '') {
                $label = self::string_prop($widget_settings, 'placeholder');
            }

            $fields[] = [
                'type'      => $type,
                'label'     => $label,
                'required'  => self::bool_prop($widget_settings, 'required'),
                'custom_id' => $custom_id,
            ];
        }

        return [
            'form_name'     => self::string_prop($settings, 'form-name'),
            'fields'        => $fields,
            'has_recaptcha' => $has_recaptcha,
            'submit_text'   => $submit_text,
        ];
    }

    /**
     * Flatten every widget in the subtree, document order preserved.
     *
     * @param array<int, mixed> $elements
     * @param array<int, array<string, mixed>> $widgets
     */
    private static function collect_v4_widgets(array $elements, array &$widgets): void
    {
        foreach ($elements as $element) {
            if (!is_array($element)) {
                continue;
            }
            if (($element['elType'] ?? '') === 'widget') {
                $widgets[] = $element;
            }
            if (isset($element['elements']) && is_array($element['elements'])) {
                self::collect_v4_widgets($element['elements'], $widgets);
            }
        }
    }

    /**
     * Unwrap an atomic `$$type`-wrapped prop to its stored value. Wrapping
     * can nest (an html-v3 text prop wraps a string prop in its `content`),
     * and exported trees may carry plain values — both must resolve.
     *
     * @param mixed $value
     * @return mixed
     */
    private static function prop_value($value)
    {
        while (is_array($value) && array_key_exists('$$type', $value)) {
            $value = $value['value'] ?? null;
        }

        return $value;
    }

    /** @param array<string, mixed> $settings */
    private static function string_prop(array $settings, string $key): string
    {
        $value = self::prop_value($settings[$key] ?? null);

        // html-v3 text props store {content: <string prop>, children: […]}.
        if (is_array($value) && isset($value['content'])) {
            $value = self::prop_value($value['content']);
        }

        return is_string($value) ? $value : '';
    }

    /** @param array<string, mixed> $settings */
    private static function bool_prop(array $settings, string $key): bool
    {
        $value = self::prop_value($settings[$key] ?? null);

        return $value === true || $value === 'true';
    }

    // ─── WordPress-side scan ─────────────────────────────────────────────────

    /**
     * Scan published content for Elementor form widgets and return one entry
     * per form instance, annotated with where it lives.
     *
     * The candidate query is a bounded LIKE over the meta value — cheap
     * because the markers can only appear in documents that actually contain
     * a form; extract_forms() then does the real parsing. Elementor stores
     * the tree compact, so both markers match colon-no-space form only.
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
                'relation' => 'OR',
                [
                    'key'     => self::META_KEY,
                    'value'   => '"widgetType":"form"',
                    'compare' => 'LIKE',
                ],
                [
                    'key'     => self::META_KEY,
                    'value'   => '"elType":"' . self::V4_FORM_ELEMENT_TYPE . '"',
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
