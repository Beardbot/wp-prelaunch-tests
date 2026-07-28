<?php

declare(strict_types=1);

/**
 * Uninstall cleanup: the plugin takes its own storage with it at handover.
 * The main plugin file is not loaded during uninstall, so the class is
 * required directly rather than autoloaded.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

require_once __DIR__ . '/includes/Rest/Throttle.php';

\WptSensors\Rest\Throttle::purge_all();
