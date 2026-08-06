<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\FormScan;
use PHPUnit\Framework\TestCase;

/**
 * Editor V4 atomic forms (issue #27): an `e-form` element whose fields are
 * descendant widgets with `$$type`-wrapped props. The fixture mirrors the
 * live V4 page on test.beardbot.dev — including the checkbox wrapped in a
 * nested flexbox — with shapes verified against Elementor 4.2.1 source.
 */
final class FormScanV4Test extends TestCase
{
    private static function fixture(string $name): string
    {
        $json = file_get_contents(__DIR__ . '/../fixtures/' . $name);
        self::assertIsString($json, "Could not read fixture {$name}.");

        return $json;
    }

    public function test_extracts_the_v4_form_with_its_name_and_submit_text(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-v4-form.json'));

        $this->assertCount(1, $forms);
        $this->assertSame('V4 Enquiry', $forms[0]['form_name']);
        $this->assertSame('Submit', $forms[0]['submit_text']);
        $this->assertFalse($forms[0]['has_recaptcha']);
    }

    public function test_fields_pair_with_labels_via_input_id_and_map_to_classic_types(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-v4-form.json'));

        $this->assertSame(
            [
                ['type' => 'text', 'label' => 'First name', 'required' => false, 'custom_id' => 'e-form-first-name'],
                ['type' => 'email', 'label' => 'Email', 'required' => true, 'custom_id' => 'e-form-email'],
                ['type' => 'textarea', 'label' => 'Message', 'required' => false, 'custom_id' => 'e-form-message'],
                ['type' => 'checkbox', 'label' => 'Checkbox', 'required' => false, 'custom_id' => 'e-form-checkbox'],
            ],
            $forms[0]['fields'],
            'Fields at any nesting depth must extract in document order; the label, submit button, and message paragraphs must not appear as fields.'
        );
    }

    /** The checkbox label FOLLOWS its input in the fixture — pairing is by input-id, not adjacency. */
    public function test_label_pairing_does_not_depend_on_document_order(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-v4-form.json'));
        $checkbox = $forms[0]['fields'][3];

        $this->assertSame('Checkbox', $checkbox['label']);
    }

    public function test_a_field_without_a_label_falls_back_to_its_placeholder(): void
    {
        $tree = json_encode([[
            'id' => 'f1', 'elType' => 'e-form', 'settings' => [],
            'elements' => [[
                'id' => 'i1', 'elType' => 'widget', 'widgetType' => 'e-form-input',
                'settings' => [
                    'placeholder' => ['$$type' => 'string', 'value' => 'Your phone'],
                    '_cssid' => ['$$type' => 'string', 'value' => 'phone'],
                    'type' => ['$$type' => 'string', 'value' => 'tel'],
                ],
                'elements' => [],
            ]],
        ]]);

        $forms = FormScan::extract_forms((string) $tree);

        $this->assertSame(
            [['type' => 'tel', 'label' => 'Your phone', 'required' => false, 'custom_id' => 'phone']],
            $forms[0]['fields']
        );
    }

    /** Plain (unwrapped) prop values must parse too — exports normalise. */
    public function test_plain_prop_values_are_accepted(): void
    {
        $tree = json_encode([[
            'id' => 'f1', 'elType' => 'e-form',
            'settings' => ['form-name' => 'Plain Form'],
            'elements' => [[
                'id' => 'i1', 'elType' => 'widget', 'widgetType' => 'e-form-input',
                'settings' => ['_cssid' => 'plain-id', 'required' => 'true'],
                'elements' => [],
            ]],
        ]]);

        $forms = FormScan::extract_forms((string) $tree);

        $this->assertSame('Plain Form', $forms[0]['form_name']);
        $this->assertSame(
            [['type' => 'text', 'label' => '', 'required' => true, 'custom_id' => 'plain-id']],
            $forms[0]['fields']
        );
    }

    public function test_classic_and_v4_forms_in_one_document_are_both_found(): void
    {
        $classic = json_decode(self::fixture('elementor-nested-forms.json'), true);
        $v4      = json_decode(self::fixture('elementor-v4-form.json'), true);
        $forms   = FormScan::extract_forms((string) json_encode(array_merge($classic, $v4)));

        $this->assertSame(
            ['Main Enquiry', 'Newsletter', 'V4 Enquiry'],
            array_column($forms, 'form_name')
        );
    }

    public function test_an_empty_v4_form_yields_a_blank_schema(): void
    {
        $forms = FormScan::extract_forms('[{"id":"f1","elType":"e-form"}]');

        $this->assertSame(
            [['form_name' => '', 'fields' => [], 'has_recaptcha' => false, 'submit_text' => '']],
            $forms
        );
    }

    /** A future V4 captcha widget must surface as the signal, not a field. */
    public function test_a_captcha_widget_type_sets_the_flag(): void
    {
        $tree = json_encode([[
            'id' => 'f1', 'elType' => 'e-form', 'settings' => [],
            'elements' => [[
                'id' => 'c1', 'elType' => 'widget', 'widgetType' => 'e-form-recaptcha',
                'settings' => [], 'elements' => [],
            ]],
        ]]);

        $forms = FormScan::extract_forms((string) $tree);

        $this->assertTrue($forms[0]['has_recaptcha']);
        $this->assertSame([], $forms[0]['fields']);
    }
}
