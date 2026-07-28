// Client for the wpt-sensors companion WordPress plugin (wp-plugin/wpt-sensors).
//
// The plugin is ALWAYS optional: every consumer of this client must behave
// exactly as it did before the plugin existed when the client is null or a
// call returns null. That invariant is enforced here by construction — this
// module never throws. Absence (site has no plugin) resolves to null with at
// most one dim note; misconfiguration (plugin answered 401/403/429, so it IS
// installed but the credentials or lockout state are wrong) resolves to null
// with one loud warning, because silently falling back would hide a broken
// setup behind seemingly-normal runs.
//
// Auth is a WordPress application password over HTTP Basic, held by a service
// user with the manage_wpt_sensors capability. Credentials come from .env via
// the shared per-site convention (src/env-credentials.js):
//   WPT_SENSOR_USER / WPT_SENSOR_APP_PASSWORD, per-site `_<KEY>` overrides.
//
// Routes use the permalink-agnostic ?rest_route= form, with a cache-busting
// parameter because SG Optimizer caching is enabled on staging at pre-launch.

const http = require('http');
const https = require('https');
const chalk = require('chalk');
const { envForSite } = require('./env-credentials');

// The API contract this client speaks. A response with a different
// api_version is treated as plugin-absent (with one loud warning) rather than
// risking misreading a changed contract.
const SENSOR_API_VERSION = 1;

const REST_BASE = '/?rest_route=/wpt-sensors/v1/';

function isSensorsEnabled(site) {
  return !!(site.sensors && site.sensors.enabled);
}

function requestJson(targetUrl, { username, password, timeout = 15000, redirects = 3 } = {}) {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve(null);
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request(parsed, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'wp-prelaunch-tests sensor client',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
      }
    }, res => {
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && redirects > 0) {
        res.resume();
        const nextUrl = new URL(location, targetUrl).toString();
        resolve(requestJson(nextUrl, { username, password, timeout, redirects: redirects - 1 }));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Non-JSON body — handled by the caller via json === null.
        }
        resolve({ status: res.statusCode, json });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Build a client for one site, or null when sensors are not enabled for it or
// credentials are missing. A null return means "behave as if the plugin does
// not exist" — which, for every caller, is exactly the pre-plugin behaviour.
function createSensorClient(site, { log = console } = {}) {
  if (!isSensorsEnabled(site)) {
    return null;
  }

  const user = envForSite(site.key, 'WPT_SENSOR_USER');
  const pass = envForSite(site.key, 'WPT_SENSOR_APP_PASSWORD');
  if (!user.value || !pass.value) {
    // Loud: the config opted in, so a missing credential is a misconfiguration,
    // not an absent plugin.
    log.warn(chalk.yellow(
      `⚠ sensors are enabled for "${site.key}" but credentials are not set — ` +
      `set ${user.perSiteName}/${pass.perSiteName} or the global ` +
      `${user.globalName}/${pass.globalName} in .env. Running without sensors.`
    ));
    return null;
  }

  // Availability is resolved once per client (one probe), then reused.
  let availability = null; // null = not yet probed; { available, apiVersion }
  let warnedUnavailable = false;

  function endpointUrl(endpoint, params = {}) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('');
    return `${site.url}${REST_BASE}${endpoint}&_wpt=${Date.now()}${query}`;
  }

  function noteUnavailable(reason, loud) {
    if (warnedUnavailable) return;
    warnedUnavailable = true;
    if (loud) {
      log.warn(chalk.yellow(`⚠ sensors unavailable for "${site.key}": ${reason}. Running without sensors.`));
    } else {
      log.log(chalk.gray(`  sensors: ${reason} for "${site.key}" — running without sensors`));
    }
  }

  // One GET against a sensor endpoint. Resolves to the response JSON, or null
  // for every failure shape. Never throws.
  async function call(endpoint, params) {
    const response = await requestJson(endpointUrl(endpoint, params), {
      username: user.value,
      password: pass.value
    });

    if (response === null) {
      noteUnavailable('site unreachable or request timed out', false);
      return null;
    }
    if ([401, 403, 429].includes(response.status)) {
      // The plugin (or the site) answered and refused: it exists, and the
      // credentials, capability, or lockout state are wrong. Never silent.
      noteUnavailable(
        `the sensor endpoint refused the request (HTTP ${response.status}) — ` +
        `check the service user, application password, and manage_wpt_sensors capability`,
        true
      );
      return null;
    }
    if (response.status === 404 || response.json === null || (response.json && response.json.code === 'rest_no_route')) {
      noteUnavailable('sensor plugin not detected', false);
      return null;
    }
    if (response.status !== 200) {
      noteUnavailable(`unexpected HTTP ${response.status} from the sensor endpoint`, true);
      return null;
    }
    if (response.json.api_version !== SENSOR_API_VERSION) {
      noteUnavailable(
        `sensor API version mismatch (plugin speaks ${response.json.api_version}, runner speaks ${SENSOR_API_VERSION}) — ` +
        'update the plugin or the runner',
        true
      );
      return null;
    }
    return response.json;
  }

  // Probe once and cache. Every data method gates on this, so a site without
  // the plugin costs exactly one round trip per run.
  async function probe() {
    if (availability === null) {
      const version = await call('version');
      availability = version === null
        ? { available: false }
        : { available: true, apiVersion: version.api_version, pluginVersion: version.plugin_version };
    }
    return availability;
  }

  async function gated(endpoint, params) {
    const state = await probe();
    if (!state.available) return null;
    return call(endpoint, params);
  }

  return {
    probe,
    inventory: () => gated('inventory'),
    preflight: testCustomerEmail => gated('preflight', { test_customer: testCustomerEmail }),
    events: runId => gated('events', { run_id: runId })
  };
}

module.exports = { createSensorClient, isSensorsEnabled, SENSOR_API_VERSION };
