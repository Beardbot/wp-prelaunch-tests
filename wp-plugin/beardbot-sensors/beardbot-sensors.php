<?php
/**
 * Plugin Name:       Beardbot Site Sensors
 * Description:       Read-only sensor surface for the wp-prelaunch-tests runner: site inventory, pre-flight audit, and test-run effect verification over an application-password-authenticated REST API. This plugin never mutates the site — it writes only to its own event table and transients.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            Beardbot
 * License:           Proprietary
 * Update URI:        https://github.com/Beardbot/wp-prelaunch-tests
 */

declare(strict_types=1);

namespace BeardbotSensors;

if (!defined('ABSPATH')) {
    exit;
}

const VERSION     = '0.1.0';
const API_VERSION = 1;
const CAPABILITY  = 'manage_beardbot_sensors';

define('BEARDBOT_SENSORS_DIR', plugin_dir_path(__FILE__));

// ─── Autoloader ───────────────────────────────────────────────────────────────
// PSR-4 style: BeardbotSensors\Rest\Controller → includes/Rest/Controller.php

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, __NAMESPACE__ . '\\')) {
        return;
    }
    $relative = substr($class, strlen(__NAMESPACE__) + 1);
    $path     = BEARDBOT_SENSORS_DIR . 'includes/' . str_replace('\\', '/', $relative) . '.php';
    if (file_exists($path)) {
        require $path;
    }
});

// ─── Activation: requirements check + capability grant ───────────────────────

register_activation_hook(__FILE__, static function (): void {
    if (version_compare(PHP_VERSION, '8.1', '<')) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die(
            'Beardbot Site Sensors requires PHP 8.1 or higher. This site runs PHP ' . esc_html(PHP_VERSION) . '.',
            'Plugin activation failed',
            ['back_link' => true]
        );
    }
    if (version_compare(get_bloginfo('version'), '6.0', '<')) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die(
            'Beardbot Site Sensors requires WordPress 6.0 or higher.',
            'Plugin activation failed',
            ['back_link' => true]
        );
    }

    // Single permission gate for the whole sensor surface. Granted to
    // administrators by default; a dedicated service user can be given exactly
    // this capability and nothing else (`wp user add-cap <user> manage_beardbot_sensors`).
    $role = get_role('administrator');
    if ($role && !$role->has_cap(CAPABILITY)) {
        $role->add_cap(CAPABILITY);
    }
});

register_deactivation_hook(__FILE__, static function (): void {
    $role = get_role('administrator');
    if ($role && $role->has_cap(CAPABILITY)) {
        $role->remove_cap(CAPABILITY);
    }
});

// ─── REST sensor surface ─────────────────────────────────────────────────────
// Every route in the beardbot-sensors/v1 namespace is gated by Rest\Controller::authorize()
// — encrypted transport, WordPress application-password authentication, and the
// manage_beardbot_sensors capability. The filters below integrate with core's own
// authentication so repeated failures are throttled before WordPress ever
// compares a password hash; each is scoped to this plugin's routes, so nothing
// else on the client's site changes behaviour.

add_action('rest_api_init', [Rest\Controller::class, 'register_routes']);
add_filter('rest_index', [Rest\Controller::class, 'hide_from_index']);
add_filter('rest_authentication_errors', [Rest\Controller::class, 'throttle_authentication_errors'], 100);
add_filter('wp_is_application_passwords_available', [Rest\Controller::class, 'suppress_application_passwords'], 100);
add_action('application_password_failed_authentication', [Rest\Controller::class, 'note_failed_authentication']);
add_filter('rest_post_dispatch', [Rest\Controller::class, 'add_retry_after'], 10, 3);
