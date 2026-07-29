<?php

declare(strict_types=1);

namespace BeardbotSensors;

/**
 * Observes server-side effects during a test run and records them against
 * the run id the runner sent in the X-WPT-Run-ID header.
 *
 * Nothing is armed unless the header is present AND matches the strict run-id
 * pattern — for every ordinary visitor this plugin adds zero hooks. The
 * header rides only same-origin requests injected by the runner, so a
 * recorded event means "this very request, part of this very run, caused
 * this effect".
 *
 * PRIVACY CONTRACT (enforced by unit test): summaries carry no PII — no mail
 * bodies, no recipient local-parts (domains only), no clear-text subjects
 * (a truncated hash and a length, enough for the runner to corroborate
 * "a mail left the site" without this table becoming a data store worth
 * stealing). The wp_mail filter passes its arguments through untouched.
 */
final class Recorder
{
    /** As sent by the runner; PHP surfaces it as HTTP_X_WPT_RUN_ID. */
    public const HEADER_SERVER_KEY = 'HTTP_X_WPT_RUN_ID';

    /** Runner-minted run ids: url-safe, long enough to be unguessable in bulk. */
    private const RUN_ID_PATTERN = '/^[A-Za-z0-9_-]{8,64}$/';

    /** Hex chars of the sha256 subject digest that are stored. */
    private const SUBJECT_HASH_LENGTH = 16;

    private static ?string $run_id = null;

    // ─── Pure decision logic (no WordPress) ──────────────────────────────────

    public static function valid_run_id(?string $value): bool
    {
        return is_string($value) && preg_match(self::RUN_ID_PATTERN, $value) === 1;
    }

    /**
     * The privacy-preserving mail summary. $to is whatever wp_mail was given:
     * a string, a comma-separated string, or an array of either addresses or
     * "Name <address>" forms.
     *
     * @param mixed $to
     * @return array{to_domains: array<int, string>, subject_hash: string, subject_length: int}
     */
    public static function summarise_mail($to, string $subject): array
    {
        $addresses = [];
        foreach (is_array($to) ? $to : [(string) $to] as $entry) {
            foreach (explode(',', (string) $entry) as $address) {
                $addresses[] = trim($address);
            }
        }

        $domains = [];
        foreach ($addresses as $address) {
            // "Name <local@domain>" → local@domain
            if (preg_match('/<([^>]+)>/', $address, $m) === 1) {
                $address = trim($m[1]);
            }
            $at = strrpos($address, '@');
            if ($at !== false) {
                $domain = strtolower(substr($address, $at + 1));
                if ($domain !== '' && !in_array($domain, $domains, true)) {
                    $domains[] = $domain;
                }
            }
        }

        return [
            'to_domains'     => $domains,
            'subject_hash'   => substr(hash('sha256', $subject), 0, self::SUBJECT_HASH_LENGTH),
            'subject_length' => strlen($subject),
        ];
    }

    // ─── Arming ──────────────────────────────────────────────────────────────

    /** Called on plugins_loaded; a no-op without a valid run-id header. */
    public static function arm(): void
    {
        $header = isset($_SERVER[self::HEADER_SERVER_KEY]) ? (string) $_SERVER[self::HEADER_SERVER_KEY] : null;
        if (!self::valid_run_id($header)) {
            return;
        }
        self::$run_id = $header;

        add_filter('wp_mail', [self::class, 'on_mail'], PHP_INT_MAX);
        add_action('elementor_pro/forms/new_record', [self::class, 'on_elementor_record'], 10, 2);
        add_action('gform_after_submission', [self::class, 'on_gform_submission'], 10, 2);
        add_action('wpforms_process_complete', [self::class, 'on_wpforms_complete'], 10, 4);
        add_action('wpcf7_mail_sent', [self::class, 'on_cf7_mail_sent']);
        add_action('woocommerce_new_order', [self::class, 'on_new_order'], 10, 2);
    }

    private static function record(string $event_type, string $provider, array $summary): void
    {
        if (self::$run_id === null) {
            return;
        }
        Events::record(
            self::$run_id,
            $event_type,
            $provider,
            $summary,
            isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : ''
        );
    }

    // ─── Listeners ───────────────────────────────────────────────────────────

    /**
     * wp_mail filter at PHP_INT_MAX: sees the final arguments, records the
     * summary, and returns them untouched — this plugin must never alter a
     * client site's mail.
     *
     * @param mixed $atts
     * @return mixed
     */
    public static function on_mail($atts)
    {
        if (is_array($atts)) {
            self::record('mail', '', self::summarise_mail($atts['to'] ?? '', (string) ($atts['subject'] ?? '')));
        }

        return $atts;
    }

    /** @param mixed $record @param mixed $handler */
    public static function on_elementor_record($record, $handler): void
    {
        $form_name = '';
        $form_id   = '';
        if (is_object($record) && method_exists($record, 'get_form_settings')) {
            $form_name = (string) $record->get_form_settings('form_name');
            $form_id   = (string) $record->get_form_settings('id');
        }
        self::record('form_submission', 'elementor_pro', ['form_name' => $form_name, 'form_id' => $form_id]);
    }

    /** @param mixed $entry @param mixed $form */
    public static function on_gform_submission($entry, $form): void
    {
        self::record('form_submission', 'gravity_forms', [
            'form_name' => is_array($form) ? (string) ($form['title'] ?? '') : '',
            'form_id'   => is_array($form) ? (string) ($form['id'] ?? '') : '',
        ]);
    }

    /** @param mixed $fields @param mixed $entry @param mixed $form_data @param mixed $entry_id */
    public static function on_wpforms_complete($fields, $entry, $form_data, $entry_id): void
    {
        $settings = is_array($form_data) && is_array($form_data['settings'] ?? null) ? $form_data['settings'] : [];
        self::record('form_submission', 'wpforms', [
            'form_name' => (string) ($settings['form_title'] ?? ''),
            'form_id'   => is_array($form_data) ? (string) ($form_data['id'] ?? '') : '',
        ]);
    }

    /** @param mixed $contact_form */
    public static function on_cf7_mail_sent($contact_form): void
    {
        $form_name = '';
        $form_id   = '';
        if (is_object($contact_form)) {
            $form_name = method_exists($contact_form, 'title') ? (string) $contact_form->title() : '';
            $form_id   = method_exists($contact_form, 'id') ? (string) $contact_form->id() : '';
        }
        self::record('form_submission', 'contact_form_7', ['form_name' => $form_name, 'form_id' => $form_id]);
    }

    /** @param mixed $order_id @param mixed $order */
    public static function on_new_order($order_id, $order = null): void
    {
        if (!is_object($order) && function_exists('\wc_get_order')) {
            $order = \wc_get_order($order_id);
        }
        $summary = ['order_id' => (int) $order_id, 'payment_method' => '', 'total' => '', 'status' => ''];
        if (is_object($order)) {
            $summary['payment_method'] = (string) $order->get_payment_method();
            $summary['total']          = (string) $order->get_total();
            $summary['status']         = (string) $order->get_status();
        }
        self::record('order', 'woocommerce', $summary);
    }
}
