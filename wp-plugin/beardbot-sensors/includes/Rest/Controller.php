<?php

declare(strict_types=1);

namespace BeardbotSensors\Rest;

use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

use const BeardbotSensors\API_VERSION;
use const BeardbotSensors\CAPABILITY;
use const BeardbotSensors\VERSION;

/**
 * COPIED from the beardbot-setup plugin (staging-setup repo).
 * Source: plugin/beardbot-setup/includes/Rest/Controller.php
 * Commit: e5b7beddd236f1ff48dece0cb9114dd7b8028fd8 (M3.4)
 * Changes: mechanical renames (namespace, capability, REST namespace,
 * error-code prefixes, filter/hook names); the engine-specific routes and
 * handlers (verify/drift/audit/apply/reapply, payload parsing, ApplyLock) are
 * REMOVED and route registration replaced with this plugin's sensor routes.
 * The five-gate authorisation machinery — decide(), status_for(),
 * message_for(), transport_allowed(), authorize(), the core auth integration,
 * the index scrub, and the request-inspection helpers — is behaviour-identical
 * to the source.
 * Extraction trigger: a THIRD consumer of these guard classes moves them to a
 * shared composer package. Recorded in docs/plugin.md.
 */

/**
 * The authenticated REST sensor surface.
 *
 * Every route is read-only (GET) and reports on the site; nothing here mutates
 * WordPress state. The gate is still built as if the surface were dangerous,
 * because an authenticated, capability-bearing endpoint on a client site is an
 * attack target regardless of what it serves.
 *
 * A request must clear five gates, in this order (see {@see decide()}):
 *
 *   1. Not currently throttled for repeated authentication failures.
 *   2. Arriving over an encrypted connection.
 *   3. Not refused by the site's own `beardbot_sensors_rest_preflight` filter.
 *   4. Authenticated — in practice, a WordPress application password.
 *   5. Holding `manage_beardbot_sensors`, the single permission gate for the
 *      whole sensor surface.
 *
 * Authentication itself is core's: WordPress application passwords are
 * revocable per site without touching anyone's real password, and need no
 * credential store of ours. Authorisation is the dedicated capability rather
 * than `manage_options`, so a site can grant a service user exactly this and
 * nothing else.
 *
 * Layers beyond this — IP allowlisting, a web application firewall — are
 * deliberately deployment-side rather than plugin code. An allowlist evaluated
 * here runs only after the request has already reached PHP and WordPress, which
 * is strictly worse than a host firewall doing the same job earlier, and
 * REMOTE_ADDR is unreliable behind the reverse proxies most managed WordPress
 * hosts run. The `beardbot_sensors_rest_preflight` filter is the seam for sites
 * that want one anyway.
 */
final class Controller
{
    /** Vendor-prefixed REST namespace, for the same reason as the plugin slug. */
    public const REST_NAMESPACE = 'beardbot-sensors/v1';

    // Refusal codes. Each maps to an HTTP status in status_for().
    public const ERR_THROTTLED = 'beardbot_sensors_too_many_attempts';
    public const ERR_INSECURE  = 'beardbot_sensors_insecure_transport';
    public const ERR_PREFLIGHT = 'beardbot_sensors_request_refused';
    public const ERR_NO_AUTH   = 'beardbot_sensors_not_authenticated';
    public const ERR_FORBIDDEN = 'beardbot_sensors_forbidden';

    /**
     * Whether this request has already been counted as a failure. One HTTP
     * request is one attempt, however many places notice it: core rejects a bad
     * application password from `rest_authentication_errors` before dispatch,
     * but a malformed header instead reaches the permission callback with no
     * user, and both must not count the same attempt twice.
     */
    private static bool $counted = false;

    // ─── Pure decision logic (no WordPress) ──────────────────────────────────

    /**
     * Whether the connection is good enough to carry an application password.
     *
     * An application password sent over plain HTTP is handed to anyone on the
     * path, so the default is to refuse. The one exception mirrors WordPress
     * core's own rule in wp_is_application_passwords_supported(): a `local`
     * environment may use them unencrypted, because that is a developer machine
     * rather than a client site. Matching core exactly is deliberate — a
     * different rule here would mean requests core accepts we reject, or worse,
     * the reverse. `staging` and `production` both require real encryption.
     *
     * Pure so the policy is unit-testable without a site or a certificate.
     */
    public static function transport_allowed(bool $is_ssl, string $environment_type): bool
    {
        return $is_ssl || $environment_type === 'local';
    }

    /**
     * The whole authorisation decision as one pure function: given the five
     * gate outcomes, return the refusal code, or null when the request may
     * proceed. Order matters and is asserted by the unit tests — a throttled
     * caller is refused before any credential is looked at, and an insecure
     * connection is refused before we consider who is calling, so neither path
     * can be used to probe whether a credential was valid.
     */
    public static function decide(
        bool $locked_out,
        bool $transport_ok,
        bool $preflight_ok,
        bool $authenticated,
        bool $has_capability
    ): ?string {
        if ($locked_out) {
            return self::ERR_THROTTLED;
        }
        if (!$transport_ok) {
            return self::ERR_INSECURE;
        }
        if (!$preflight_ok) {
            return self::ERR_PREFLIGHT;
        }
        if (!$authenticated) {
            return self::ERR_NO_AUTH;
        }
        if (!$has_capability) {
            return self::ERR_FORBIDDEN;
        }
        return null;
    }

    /** HTTP status for a refusal code. Pure. */
    public static function status_for(string $code): int
    {
        return match ($code) {
            self::ERR_THROTTLED => 429,
            self::ERR_NO_AUTH   => 401,
            default             => 403,
        };
    }

    /** Operator-facing explanation for a refusal code. Pure. */
    public static function message_for(string $code): string
    {
        return match ($code) {
            self::ERR_THROTTLED => 'Too many failed authentication attempts. Try again later.',
            self::ERR_INSECURE  => 'This endpoint requires an encrypted connection.',
            self::ERR_PREFLIGHT => 'This request was refused by site policy.',
            self::ERR_NO_AUTH   => 'Authentication required. Use a WordPress application password.',
            default             => 'Your account is not permitted to read Beardbot sensors on this site.',
        };
    }

    // ─── Route registration ──────────────────────────────────────────────────

    /**
     * Register the routes. `show_in_index` is false so an unauthenticated
     * caller reading /wp-json/ is not told this surface exists; it changes
     * nothing for a caller who knows the route.
     *
     * Every sensor route is GET — this plugin's read-only guarantee is
     * structural, not a convention. The inventory, preflight, and events
     * routes arrive in later slices; /version is the proving route the gate
     * ships with.
     */
    public static function register_routes(): void
    {
        $read = static fn(callable $callback, array $args = []): array => [
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => $callback,
            'permission_callback' => [self::class, 'authorize'],
            'show_in_index'       => false,
            'args'                => $args,
        ];

        register_rest_route(self::REST_NAMESPACE, '/version', $read([self::class, 'version']));
        register_rest_route(self::REST_NAMESPACE, '/inventory', $read([self::class, 'inventory']));
    }

    /**
     * The proving route: the runner's availability-and-contract probe.
     * Deliberately trivial and read-only.
     */
    public static function version(WP_REST_Request $request): WP_REST_Response
    {
        return new WP_REST_Response([
            'api_version'    => API_VERSION,
            'plugin_version' => VERSION,
        ], 200);
    }

    /**
     * The authoritative site inventory: pages, form instances with real field
     * schemas, WooCommerce paths and test-product candidates, theme, and
     * active plugins. Assembled fresh on every call — see
     * {@see \BeardbotSensors\Inventory}.
     */
    public static function inventory(WP_REST_Request $request): WP_REST_Response
    {
        return new WP_REST_Response([
            'api_version'    => API_VERSION,
            'plugin_version' => VERSION,
        ] + \BeardbotSensors\Inventory::collect(), 200);
    }

    /**
     * Remove this plugin's namespace from the public REST index.
     *
     * `show_in_index` on the routes is not enough: it hides the route entries,
     * but the index's `namespaces` list is built from every registered
     * namespace regardless, so /wp-json/ would still tell an unauthenticated
     * caller that a `beardbot-sensors/v1` surface exists on the site. Recon value
     * only — the permission gate is what actually protects the routes — but
     * the index does not advertise this surface, so both halves are scrubbed
     * here.
     *
     * @param mixed $response
     * @return mixed
     */
    public static function hide_from_index($response)
    {
        if (!$response instanceof WP_REST_Response) {
            return $response;
        }

        $data = $response->get_data();
        if (isset($data['namespaces']) && is_array($data['namespaces'])) {
            $data['namespaces'] = array_values(array_filter(
                $data['namespaces'],
                static fn($ns) => $ns !== self::REST_NAMESPACE
            ));
        }
        if (isset($data['routes']) && is_array($data['routes'])) {
            $data['routes'] = array_filter(
                $data['routes'],
                static fn($route) => !self::route_is_ours((string) $route),
                ARRAY_FILTER_USE_KEY
            );
        }
        $response->set_data($data);

        return $response;
    }

    // ─── The permission gate ─────────────────────────────────────────────────

    /**
     * The permission callback for every route in this namespace. Returns true
     * to proceed, or a WP_Error carrying the refusal status.
     *
     * @return true|WP_Error
     */
    public static function authorize(WP_REST_Request $request)
    {
        $username = self::supplied_username();

        $preflight = apply_filters('beardbot_sensors_rest_preflight', true, $request);

        $code = self::decide(
            Throttle::is_locked_out($username),
            self::transport_allowed(self::request_is_ssl(), wp_get_environment_type()),
            !($preflight === false || $preflight instanceof WP_Error),
            get_current_user_id() > 0,
            current_user_can(CAPABILITY)
        );

        if ($code === null) {
            // A clean request clears the counter, so a few mistyped attempts
            // before the right paste do not cost the operator the window.
            Throttle::clear($username);
            return true;
        }

        // Count only the shapes that represent credential guessing. A valid
        // credential that simply lacks the capability is a misconfiguration,
        // not an attack, and locking it out would help nobody.
        if ($code === self::ERR_NO_AUTH && self::credentials_supplied()) {
            self::count_failure($username);
        }

        self::announce_failure($code, $username);

        // A site that refused via the preflight filter may have supplied its own
        // WP_Error explaining why; pass it through rather than flattening it.
        // Reached only once throttling and transport have already been cleared,
        // so site policy cannot preempt either.
        if ($code === self::ERR_PREFLIGHT && $preflight instanceof WP_Error) {
            return $preflight;
        }

        return new WP_Error(
            $code,
            self::message_for($code),
            ['status' => self::status_for($code)]
        );
    }

    // ─── Core auth integration ───────────────────────────────────────────────

    /**
     * Count failures WordPress rejects before our permission callback ever
     * runs. When an application password does not verify, core answers 401 from
     * `rest_authentication_errors` and dispatch stops, so authorize() never
     * sees the attempt — this action is the only place it is visible.
     */
    public static function note_failed_authentication(): void
    {
        if (!self::is_sensor_request()) {
            return;
        }
        $username = self::supplied_username();

        // Suppressing application passwords for a locked-out caller makes core
        // raise its own failure here, which would otherwise inflate the count
        // on every request for as long as the lockout lasts. The caller is
        // already over the limit; there is nothing left to learn from counting.
        if (Throttle::is_locked_out($username)) {
            return;
        }

        self::count_failure($username);
        self::announce_failure(self::ERR_NO_AUTH, $username);
    }

    /** Count this request as one failed attempt, at most once. */
    private static function count_failure(string $username): void
    {
        if (self::$counted) {
            return;
        }
        self::$counted = true;
        Throttle::record_failure($username);
    }

    /**
     * Answer a throttled caller with 429 rather than the 401 core would give.
     *
     * Suppressing application passwords (below) is what actually stops the work
     * happening, but it makes core report the request as merely unauthenticated,
     * which tells an operator locked out by a typo nothing useful. This replaces
     * that answer for this plugin's routes only, and is also what lets the
     * Retry-After header attach.
     *
     * @param mixed $errors
     * @return mixed
     */
    public static function throttle_authentication_errors($errors)
    {
        if (!self::is_sensor_request()) {
            return $errors;
        }
        if (!Throttle::is_locked_out(self::supplied_username())) {
            return $errors;
        }

        return new WP_Error(
            self::ERR_THROTTLED,
            self::message_for(self::ERR_THROTTLED),
            ['status' => self::status_for(self::ERR_THROTTLED)]
        );
    }

    /**
     * Turn application passwords off for a throttled caller, for this request
     * only. This is what gives the throttle teeth: core checks availability
     * before comparing the supplied password against the stored hash, so a
     * locked-out attacker never causes that comparison. Scoped to this
     * plugin's own routes, so nothing else on the client site is affected.
     *
     * @param mixed $available
     */
    public static function suppress_application_passwords($available)
    {
        if (!self::is_sensor_request()) {
            return $available;
        }
        return Throttle::is_locked_out(self::supplied_username()) ? false : $available;
    }

    /**
     * Tell a throttled caller when to come back. Only ever attached to this
     * plugin's own 429 responses.
     *
     * @param mixed $response
     * @return mixed
     */
    public static function add_retry_after($response, $server, $request)
    {
        if (!$response instanceof WP_REST_Response || $response->get_status() !== 429) {
            return $response;
        }
        if (!$request instanceof WP_REST_Request || !self::route_is_ours((string) $request->get_route())) {
            return $response;
        }

        $data = $response->get_data();
        if (is_array($data) && ($data['code'] ?? '') === self::ERR_THROTTLED) {
            $response->header('Retry-After', (string) Throttle::retry_after(self::supplied_username()));
        }

        return $response;
    }

    // ─── Request inspection ──────────────────────────────────────────────────

    /**
     * Whether the request currently being served targets this plugin's REST
     * namespace. Used to scope the two global core hooks above so they can
     * never change behaviour for the rest of the client's site.
     */
    public static function is_sensor_request(): bool
    {
        if (!defined('REST_REQUEST') || !REST_REQUEST) {
            return false;
        }
        return self::route_is_ours(self::current_route());
    }

    /** Whether a REST route string belongs to this plugin's namespace. Pure. */
    public static function route_is_ours(string $route): bool
    {
        return str_starts_with(ltrim($route, '/'), self::REST_NAMESPACE . '/')
            || ltrim($route, '/') === self::REST_NAMESPACE;
    }

    /**
     * The route being served. WordPress puts it in the `rest_route` query var
     * during parse_request, before REST_REQUEST is defined and well before
     * either core hook above can fire, so it is always populated by the time we
     * ask. The query-string fallback covers a plain ?rest_route= request. The
     * value is only ever prefix-compared, never echoed.
     */
    public static function current_route(): string
    {
        $wp = $GLOBALS['wp'] ?? null;
        if ($wp !== null && !empty($wp->query_vars['rest_route'])) {
            return (string) $wp->query_vars['rest_route'];
        }
        return isset($_GET['rest_route']) ? (string) $_GET['rest_route'] : '';
    }

    /**
     * Whether this request is served over an encrypted connection.
     *
     * `is_ssl()` reads the current request. Behind a TLS-terminating reverse
     * proxy WordPress cannot see the encryption unless wp-config sets
     * `$_SERVER['HTTPS']`, the standard fix; the filter is the escape hatch for
     * sites that cannot.
     */
    public static function request_is_ssl(): bool
    {
        return (bool) apply_filters('beardbot_sensors_rest_is_ssl', is_ssl());
    }

    /** The username the caller supplied over HTTP Basic, if any. */
    private static function supplied_username(): string
    {
        return isset($_SERVER['PHP_AUTH_USER']) ? (string) $_SERVER['PHP_AUTH_USER'] : '';
    }

    /**
     * Whether the caller attempted to authenticate at all. A malformed
     * Authorization header may leave PHP_AUTH_USER unset while still being an
     * attempt, so the raw header counts too — otherwise garbage credentials
     * would be a free way around the throttle.
     */
    private static function credentials_supplied(): bool
    {
        return isset($_SERVER['PHP_AUTH_USER'])
            || isset($_SERVER['HTTP_AUTHORIZATION'])
            || isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
    }

    /**
     * Fire the failure hook a site can use for its own logging or alerting. The
     * context carries who and where, never the password that was tried.
     *
     * The plugin itself writes nothing by default: an unauthenticated caller
     * must not be able to fill a client site's error log, so the built-in
     * error_log() line is limited to sites running with WP_DEBUG on.
     */
    private static function announce_failure(string $code, string $username): void
    {
        $context = [
            'ip'       => Throttle::current_ip(),
            'username' => $username,
            'route'    => self::current_route(),
        ];

        do_action('beardbot_sensors_auth_failed', $code, $context);

        if (defined('WP_DEBUG') && WP_DEBUG) {
            error_log(sprintf(
                '[beardbot-sensors] REST auth refused (%s) for user "%s" from %s on %s',
                $code,
                $username,
                $context['ip'] === '' ? 'unknown' : $context['ip'],
                $context['route']
            ));
        }
    }
}
