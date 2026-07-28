const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSensorClient, SENSOR_API_VERSION } = require('../src/sensor-client');

// A silent logger so test output stays clean; tests that care about warnings
// capture them here.
function collectingLog() {
  const warnings = [];
  const notes = [];
  return {
    warn: message => warnings.push(String(message)),
    log: message => notes.push(String(message)),
    warnings,
    notes
  };
}

// Spin up a mock sensor endpoint. `handler` receives (req, res) for every
// request; the returned site points at it with sensors enabled.
function mockServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        site: {
          key: 'mock-site',
          url: `http://127.0.0.1:${port}`,
          sensors: { enabled: true }
        },
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function versionBody(apiVersion = SENSOR_API_VERSION) {
  return JSON.stringify({ api_version: apiVersion, plugin_version: '0.1.0' });
}

beforeEach(() => {
  process.env.BEARDBOT_SENSOR_USER = 'beardbot-sensors';
  process.env.BEARDBOT_SENSOR_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx';
});

afterEach(() => {
  delete process.env.BEARDBOT_SENSOR_USER;
  delete process.env.BEARDBOT_SENSOR_APP_PASSWORD;
  delete process.env.BEARDBOT_SENSOR_USER_MOCK_SITE;
  delete process.env.BEARDBOT_SENSOR_APP_PASSWORD_MOCK_SITE;
});

test('returns null for a site without sensors enabled', () => {
  assert.equal(createSensorClient({ key: 'x', url: 'https://x.test' }, { log: collectingLog() }), null);
  assert.equal(
    createSensorClient({ key: 'x', url: 'https://x.test', sensors: { enabled: false } }, { log: collectingLog() }),
    null
  );
});

test('returns null and warns loudly when sensors are enabled but credentials are missing', () => {
  delete process.env.BEARDBOT_SENSOR_USER;
  delete process.env.BEARDBOT_SENSOR_APP_PASSWORD;
  const log = collectingLog();

  const client = createSensorClient({ key: 'mock-site', url: 'https://x.test', sensors: { enabled: true } }, { log });

  assert.equal(client, null);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /BEARDBOT_SENSOR_USER_MOCK_SITE/);
  assert.match(log.warnings[0], /BEARDBOT_SENSOR_APP_PASSWORD_MOCK_SITE/);
});

test('probe succeeds against a healthy endpoint, sends Basic auth and the rest_route form', async () => {
  const seen = [];
  const { site, close } = await mockServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(versionBody());
  });

  try {
    const client = createSensorClient(site, { log: collectingLog() });
    const state = await client.probe();

    assert.equal(state.available, true);
    assert.equal(state.apiVersion, SENSOR_API_VERSION);
    assert.equal(state.pluginVersion, '0.1.0');

    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /rest_route=%2Fbeardbot-sensors%2Fv1%2Fversion|rest_route=\/beardbot-sensors\/v1\/version/);
    assert.match(seen[0].url, /_wpt=\d+/, 'every call carries the cache-busting parameter');
    const expected = 'Basic ' + Buffer.from('beardbot-sensors:xxxx xxxx xxxx xxxx xxxx xxxx').toString('base64');
    assert.equal(seen[0].auth, expected);
  } finally {
    await close();
  }
});

test('a 404 (no plugin) resolves to unavailable with a dim note, not a warning', async () => {
  const { site, close } = await mockServer((req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'rest_no_route' }));
  });

  try {
    const log = collectingLog();
    const client = createSensorClient(site, { log });

    assert.equal((await client.probe()).available, false);
    assert.equal(await client.inventory(), null);
    assert.equal(log.warnings.length, 0, 'absence must not warn loudly');
    assert.equal(log.notes.length, 1, 'absence is noted once, dimly');
  } finally {
    await close();
  }
});

test('a 401 (plugin present, bad credentials) warns loudly exactly once', async () => {
  const { site, close } = await mockServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ code: 'beardbot_sensors_not_authenticated' }));
  });

  try {
    const log = collectingLog();
    const client = createSensorClient(site, { log });

    assert.equal((await client.probe()).available, false);
    assert.equal(await client.preflight('x@y.test'), null);
    assert.equal(log.warnings.length, 1, 'misconfiguration warns exactly once');
    assert.match(log.warnings[0], /HTTP 401/);
  } finally {
    await close();
  }
});

test('an api_version mismatch resolves to unavailable with a loud warning', async () => {
  const { site, close } = await mockServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(versionBody(SENSOR_API_VERSION + 1));
  });

  try {
    const log = collectingLog();
    const client = createSensorClient(site, { log });

    assert.equal((await client.probe()).available, false);
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0], /version mismatch/);
  } finally {
    await close();
  }
});

test('an unreachable host resolves to unavailable without throwing', async () => {
  // Port 9 (discard) on localhost — nothing is listening.
  const site = { key: 'mock-site', url: 'http://127.0.0.1:9', sensors: { enabled: true } };
  const log = collectingLog();
  const client = createSensorClient(site, { log });

  assert.equal((await client.probe()).available, false);
  assert.equal(await client.events('wpt_run_12345678'), null);
});

test('data calls after a successful probe reach their endpoints with parameters', async () => {
  const seen = [];
  const { site, close } = await mockServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('events')) {
      res.end(JSON.stringify({ api_version: SENSOR_API_VERSION, run_id: 'wpt_run_12345678', count: 0, events: [] }));
    } else {
      res.end(versionBody());
    }
  });

  try {
    const client = createSensorClient(site, { log: collectingLog() });
    const events = await client.events('wpt_run_12345678');

    assert.equal(events.count, 0);
    assert.equal(seen.length, 2, 'one probe, then the data call');
    assert.match(seen[1], /run_id=wpt_run_12345678/);
  } finally {
    await close();
  }
});

test('probe result is cached — repeated data calls cost one probe total', async () => {
  let hits = 0;
  const { site, close } = await mockServer((req, res) => {
    hits += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(versionBody());
  });

  try {
    const client = createSensorClient(site, { log: collectingLog() });
    await client.probe();
    await client.probe();
    await client.inventory();
    await client.inventory();

    assert.equal(hits, 3, 'two probes collapse into one request; each data call is one more');
  } finally {
    await close();
  }
});
