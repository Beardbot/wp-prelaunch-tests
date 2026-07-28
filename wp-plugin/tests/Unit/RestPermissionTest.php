<?php

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;
use BeardbotSensors\Rest\Controller;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: tests/Unit/RestPermissionTest.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: mechanical renames (namespace, capability, REST namespace, error
 * codes) — assertions intentionally identical.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * The pure, WordPress-free core of the REST permission gate: which of the five
 * checks refuses a request, in what order, and with what HTTP status. The live
 * wiring — core's application-password authentication, the capability lookup,
 * real HTTP transport — is covered by the integration suite.
 *
 * Order is asserted deliberately, not incidentally. A throttled caller must be
 * refused before any credential is examined, and an unencrypted connection must
 * be refused before we consider who is calling, so that neither path can be
 * used to learn whether a credential was valid.
 */
final class RestPermissionTest extends TestCase
{
    /**
     * The happy path: encrypted, not throttled, allowed by site policy,
     * authenticated, and holding manage_beardbot_sensors.
     */
    public function test_request_with_capability_is_allowed(): void
    {
        $this->assertNull(Controller::decide(
            locked_out: false,
            transport_ok: true,
            preflight_ok: true,
            authenticated: true,
            has_capability: true
        ));
    }

    /**
     * An authenticated user without the capability is refused. This is the case
     * that matters for the permission model: the site can hand a service user
     * exactly manage_beardbot_sensors, and any other valid login — including a
     * subscriber, or an editor — gets nothing.
     */
    public function test_authenticated_user_without_capability_is_forbidden(): void
    {
        $this->assertSame(
            Controller::ERR_FORBIDDEN,
            Controller::decide(false, true, true, true, false)
        );
        $this->assertSame(403, Controller::status_for(Controller::ERR_FORBIDDEN));
    }

    /** No user at all is unauthenticated, not forbidden — 401, not 403. */
    public function test_request_with_no_user_is_unauthenticated(): void
    {
        $this->assertSame(
            Controller::ERR_NO_AUTH,
            Controller::decide(false, true, true, false, false)
        );
        $this->assertSame(401, Controller::status_for(Controller::ERR_NO_AUTH));
    }

    /**
     * An unencrypted connection is refused before authentication is considered,
     * so the refusal is identical whether or not the caller holds a valid
     * credential — the endpoint never reveals which.
     */
    public function test_insecure_transport_is_refused_before_authentication(): void
    {
        $withGoodCredential = Controller::decide(false, false, true, true, true);
        $withNoCredential   = Controller::decide(false, false, true, false, false);

        $this->assertSame(Controller::ERR_INSECURE, $withGoodCredential);
        $this->assertSame(Controller::ERR_INSECURE, $withNoCredential);
        $this->assertSame(403, Controller::status_for(Controller::ERR_INSECURE));
    }

    /**
     * Throttling outranks everything, including a valid credential. Otherwise a
     * locked-out attacker who guessed correctly would still be served.
     */
    public function test_throttled_caller_is_refused_even_with_a_valid_credential(): void
    {
        $this->assertSame(
            Controller::ERR_THROTTLED,
            Controller::decide(true, true, true, true, true)
        );
        $this->assertSame(429, Controller::status_for(Controller::ERR_THROTTLED));
    }

    /** A site's own preflight refusal outranks the caller's credentials. */
    public function test_preflight_refusal_outranks_authentication(): void
    {
        $this->assertSame(
            Controller::ERR_PREFLIGHT,
            Controller::decide(false, true, false, true, true)
        );
        $this->assertSame(403, Controller::status_for(Controller::ERR_PREFLIGHT));
    }

    /**
     * Transport policy mirrors WordPress core's own rule for application
     * passwords: encryption is required everywhere except a `local`
     * environment, which is a developer machine rather than a client site.
     * Staging and production both need real encryption.
     */
    public function test_transport_requires_encryption_outside_a_local_environment(): void
    {
        $this->assertTrue(Controller::transport_allowed(true, 'production'));
        $this->assertTrue(Controller::transport_allowed(true, 'staging'));

        $this->assertFalse(Controller::transport_allowed(false, 'production'));
        $this->assertFalse(Controller::transport_allowed(false, 'staging'));
        $this->assertFalse(Controller::transport_allowed(false, 'development'));

        // The one exception, matching wp_is_application_passwords_supported().
        $this->assertTrue(Controller::transport_allowed(false, 'local'));
    }

    /**
     * The two global core hooks this plugin attaches to are scoped by route, so
     * a mistake here would change authentication behaviour for the whole client
     * site. Only this plugin's namespace may match.
     */
    public function test_only_this_plugins_routes_are_claimed(): void
    {
        $this->assertTrue(Controller::route_is_ours('/beardbot-sensors/v1/version'));
        $this->assertTrue(Controller::route_is_ours('beardbot-sensors/v1/version'));
        $this->assertTrue(Controller::route_is_ours('/beardbot-sensors/v1'));

        $this->assertFalse(Controller::route_is_ours('/wp/v2/users/me'));
        $this->assertFalse(Controller::route_is_ours('/'));
        $this->assertFalse(Controller::route_is_ours(''));

        // A namespace that merely starts with the same letters is not ours.
        $this->assertFalse(Controller::route_is_ours('/beardbot-sensors-other/v1/version'));
        $this->assertFalse(Controller::route_is_ours('/beardbot-sensors/v2/version'));

        // The beardbot-setup plugin's namespace is a sibling, not ours — both
        // plugins run on the same sites, and each must scope its auth hooks to
        // its own routes only.
        $this->assertFalse(Controller::route_is_ours('/beardbot/v1/version'));
    }

    /** Every refusal code carries an operator-facing message. */
    public function test_every_refusal_code_has_a_message(): void
    {
        $codes = [
            Controller::ERR_THROTTLED,
            Controller::ERR_INSECURE,
            Controller::ERR_PREFLIGHT,
            Controller::ERR_NO_AUTH,
            Controller::ERR_FORBIDDEN,
        ];

        foreach ($codes as $code) {
            $this->assertNotSame('', Controller::message_for($code), "Refusal code {$code} has no message.");
        }
    }
}
