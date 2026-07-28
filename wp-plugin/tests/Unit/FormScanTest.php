<?php

declare(strict_types=1);

namespace Tests\Unit;

use BeardbotSensors\FormScan;
use PHPUnit\Framework\TestCase;

/**
 * The pure half of FormScan: parsing `_elementor_data` JSON into form
 * schemas. No WordPress — the fixtures are real Elementor tree shapes,
 * including the newer container layout, exercised exactly the way the meta
 * value reaches the parser on a live site.
 */
final class FormScanTest extends TestCase
{
    private static function fixture(string $name): string
    {
        $json = file_get_contents(__DIR__ . '/../fixtures/' . $name);
        self::assertIsString($json, "Could not read fixture {$name}.");

        return $json;
    }

    public function test_finds_forms_nested_in_sections_and_containers(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-nested-forms.json'));

        $this->assertCount(2, $forms, 'Both the section-nested and container-nested form must be found.');
        $this->assertSame('Main Enquiry', $forms[0]['form_name']);
        $this->assertSame('Newsletter', $forms[1]['form_name']);
        $this->assertSame('Send Enquiry', $forms[0]['submit_text']);
    }

    public function test_extracts_the_field_schema(): void
    {
        $forms  = FormScan::extract_forms(self::fixture('elementor-nested-forms.json'));
        $fields = $forms[0]['fields'];

        $this->assertSame(
            [
                ['type' => 'text', 'label' => 'Your Name', 'required' => true, 'custom_id' => 'name'],
                ['type' => 'email', 'label' => 'Email Address', 'required' => true, 'custom_id' => 'email'],
                ['type' => 'textarea', 'label' => 'Message', 'required' => false, 'custom_id' => 'message'],
            ],
            $fields
        );
    }

    /** Elementor stores required as the string "true"; a real boolean must parse too. */
    public function test_required_accepts_string_and_boolean_forms(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-nested-forms.json'));

        $this->assertTrue($forms[1]['fields'][0]['required'], 'A boolean true required flag must parse as required.');
    }

    /** An unset field_type is Elementor's default text field. */
    public function test_missing_field_type_defaults_to_text(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-nested-forms.json'));

        $this->assertSame('text', $forms[1]['fields'][0]['type']);
    }

    public function test_recaptcha_sets_the_flag_and_is_not_a_fillable_field(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-recaptcha-form.json'));

        $this->assertCount(1, $forms);
        $this->assertTrue($forms[0]['has_recaptcha']);

        $types = array_column($forms[0]['fields'], 'type');
        $this->assertSame(['text', 'email'], $types, 'The recaptcha field must not appear as fillable.');
    }

    public function test_missing_labels_default_to_empty_strings(): void
    {
        $forms = FormScan::extract_forms(self::fixture('elementor-recaptcha-form.json'));

        $this->assertSame('', $forms[0]['fields'][0]['label']);
        $this->assertSame('Work Email', $forms[0]['fields'][1]['label']);
    }

    public function test_a_document_without_forms_yields_nothing(): void
    {
        $tree = '[{"id":"aa","elType":"section","elements":[{"id":"bb","elType":"widget","widgetType":"heading","settings":{"title":"No forms here"}}]}]';

        $this->assertSame([], FormScan::extract_forms($tree));
    }

    /** Third-party meta: malformed JSON must yield no forms, never an error. */
    public function test_malformed_json_yields_nothing(): void
    {
        $this->assertSame([], FormScan::extract_forms('not json at all'));
        $this->assertSame([], FormScan::extract_forms(''));
        $this->assertSame([], FormScan::extract_forms('{"widgetType":"form"'));
        $this->assertSame([], FormScan::extract_forms('"a bare string"'));
    }

    /** A form widget with no settings at all still yields a (blank) schema. */
    public function test_form_with_no_settings_yields_an_empty_schema(): void
    {
        $forms = FormScan::extract_forms('[{"id":"aa","elType":"widget","widgetType":"form"}]');

        $this->assertSame(
            [['form_name' => '', 'fields' => [], 'has_recaptcha' => false, 'submit_text' => '']],
            $forms
        );
    }
}
