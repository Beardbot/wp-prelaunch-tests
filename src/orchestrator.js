const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { chromium } = require('playwright');

const configPath = process.env.SITES_CONFIG || path.join(__dirname, '..', 'config', 'sites.json');
if (!fs.existsSync(configPath)) {
  console.error(chalk.red('Error: sites.json not found.'));
  console.error('Copy config/sites.example.json to config/sites.json and add your sites.');
  console.error('Or set SITES_CONFIG in .env to point to a sites.json at a custom path.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { captureScreenshots, compareScreenshots } = require('./visual-diff');
const { checkLinks } = require('./link-checker');
const { checkConsoleErrors } = require('./console-errors');
const { runJourney } = require('./journey-runner');
const { saveRun } = require('./db');
const { generateReport } = require('./reporter');
const { sendNotification, sendSlackNotification } = require('./notifier');
const { authenticateWpLogin, isWpLoginEnabled } = require('./wp-login');
const { createSensorClient } = require('./sensor-client');
const { envForSite } = require('./env-credentials');
const { makeRunId, evaluatePreflight, journeyBlockReason, assembleEffects, EFFECT_EXPECTATIONS } = require('./sensor-run');

const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com/tr',
  'hotjar.com',
  'clarity.ms',
  'doubleclick.net',
  'adservice.google.com'
];

async function createContext(browser, site, runId = null) {
  const context = await browser.newContext({
    viewport: {
      width: config.settings.screenshotWidth || 1280,
      height: config.settings.screenshotHeight || 900
    }
  });

  // The site's own origin, for the run-id header scope below.
  let siteOrigin = null;
  try {
    siteOrigin = new URL(site.url).origin;
  } catch (_) {}

  // Block analytics and tracking to avoid polluting client dashboards and
  // speed up runs. When a run id exists, same-origin requests also carry the
  // X-WPT-Run-ID header so the sensor plugin's Recorder can attribute
  // server-side effects (this rides the form's AJAX POST too). Strict origin
  // comparison, not a prefix match: third parties must never see the id.
  await context.route('**/*', route => {
    const url = route.request().url();
    if (BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
      route.abort();
      return;
    }
    if (runId && siteOrigin) {
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch (_) {}
      if (origin === siteOrigin) {
        route.continue({ headers: { ...route.request().headers(), 'X-WPT-Run-ID': runId } });
        return;
      }
    }
    route.continue();
  });

  // Maintenance-mode staging sites hide everything behind a logged-in session.
  // Authenticate once here; the cookies persist for every check in this run.
  if (isWpLoginEnabled(site)) {
    console.log(chalk.blue('  Authenticating via wp-login.php...'));
    await authenticateWpLogin(context, site);
    console.log(chalk.green('  ✓ Logged in — session active for this run'));
  }

  return context;
}

async function dismissCookieBanner(page, site) {
  if (!site.cookieBannerSelector) return;
  try {
    const banner = page.locator(site.cookieBannerSelector);
    if (await banner.isVisible({ timeout: 3000 })) {
      await banner.click();
    }
  } catch (_) {}
}

function getSites(siteKeys) {
  if (siteKeys && siteKeys.length > 0) {
    return siteKeys.map(key => {
      const site = config.sites.find(s => s.key === key);
      if (!site) {
        console.error(chalk.red(`Site "${key}" not found in config/sites.json`));
        process.exit(1);
      }
      return site;
    });
  }
  // Refuse to "succeed" on zero sites. An all-sites run against an empty config
  // would otherwise generate a clean report and exit 0 — a green run that tested
  // nothing, which is exactly the false confidence this tool exists to prevent.
  if (!config.sites || config.sites.length === 0) {
    console.error(chalk.red(`No sites configured in ${configPath}.`));
    console.error('A run that tests zero sites must not report success. Add at least one entry to the "sites" array, or pass explicit site keys.');
    process.exit(1);
  }
  return config.sites;
}

async function runBaseline(siteKeys) {
  const sites = getSites(siteKeys);

  for (const site of sites) {
    console.log(chalk.bold(`\n→ Capturing baseline for: ${site.name}`));
    const browser = await chromium.launch();

    try {
      const context = await createContext(browser, site);
      const screenshots = await captureScreenshots(context, site, 'baseline', config.settings);
      console.log(chalk.green(`  ✓ Captured ${screenshots.length} baseline screenshots`));
    } catch (err) {
      console.error(chalk.red(`  ✗ Baseline failed: ${err.message}`));
    } finally {
      await browser.close();
    }
  }

  console.log(chalk.green('\n✓ Baseline capture complete'));
}

async function runTests(siteKeys) {
  const sites = getSites(siteKeys);
  const allResults = [];

  for (const site of sites) {
    console.log(chalk.bold(`\n→ Testing: ${site.name}`));
    const siteResults = {
      site: site.name,
      key: site.key,
      url: site.url,
      timestamp: new Date().toISOString(),
      visual: [],
      links: [],
      console: [],
      journeys: [],
      passed: true,
      flaky: false
    };

    // One sensor client and one run id per site per invocation. Both are null
    // when the site has no working sensor setup, and every sensor-dependent
    // step below degrades to the pre-plugin behaviour on null.
    const sensorClient = createSensorClient(site);
    const runId = sensorClient ? makeRunId(site.key) : null;

    const browser = await chromium.launch();

    try {
      const context = await createContext(browser, site, runId);

      // Preflight: the plugin's machine-checked staging checklist. Which
      // checks block is runner-side policy (sensor-run.js). Journeys consult
      // the policy below; the read-only checks (visual, links, console) always
      // run — they cannot pollute anything.
      let preflightPolicy = null;
      if (sensorClient) {
        const testCustomer = envForSite(site.key, 'TEST_CUSTOMER_EMAIL').value;
        const preflight = await sensorClient.preflight(testCustomer || undefined);
        if (preflight) {
          preflightPolicy = evaluatePreflight(preflight, site);
          siteResults.preflight = {
            environment: preflight.environment,
            checks: preflight.checks,
            policy: preflightPolicy
          };
          const passCount = (preflight.checks || []).filter(c => c.status === 'pass').length;
          console.log(chalk.blue(`  Preflight: environment verdict "${preflightPolicy.verdict}", ${passCount}/${(preflight.checks || []).length} checks pass`));
          if (preflightPolicy.blockAll) {
            console.log(chalk.red(`  ✗ Preflight: ${preflightPolicy.blockAll}`));
          } else if (preflightPolicy.paymentBlock) {
            console.log(chalk.red(`  ✗ Preflight: payment gateway in live mode — checkout journeys will be blocked`));
          }
          if (preflightPolicy.advisories.length > 0) {
            console.log(chalk.yellow(`  ⚠ Preflight advisories: ${preflightPolicy.advisories.map(a => a.id).join(', ')}`));
          }
        }
      }

      // Visual diff
      console.log(chalk.blue('  Running visual diff...'));
      const newShots = await captureScreenshots(context, site, 'test', config.settings);
      const visualResults = await compareScreenshots(site, newShots, config.settings.diffThreshold);
      siteResults.visual = visualResults;
      const visualFails = visualResults.filter(r => r.status === 'fail').length;
      console.log(visualFails > 0
        ? chalk.red(`  ✗ Visual diff: ${visualFails} page(s) flagged`)
        : chalk.green(`  ✓ Visual diff: all pages passed`)
      );

      // Link checker
      console.log(chalk.blue('  Checking links...'));
      const linkResults = await checkLinks(site, context);
      siteResults.links = linkResults;
      const linkFails = linkResults.filter(r => r.status === 0 || r.status >= 400).length;
      console.log(linkFails > 0
        ? chalk.red(`  ✗ Links: ${linkFails} broken link(s) found`)
        : chalk.green(`  ✓ Links: all OK`)
      );

      // Console errors
      console.log(chalk.blue('  Checking for console errors...'));
      const consoleResults = await checkConsoleErrors(context, site, config.settings.timeout);
      siteResults.console = consoleResults;
      const errorPages = consoleResults.filter(r => r.errors.length > 0).length;
      console.log(errorPages > 0
        ? chalk.red(`  ✗ Console errors found on ${errorPages} page(s)`)
        : chalk.green(`  ✓ Console: no errors`)
      );

      // Journeys. A sitewide preflight block skips them all (the block reason
      // lives in siteResults.preflight and fails the site below); a scoped
      // payment block skips only checkout-capable journeys, recorded as
      // blocked entries so the report shows exactly what did not run and why.
      if (preflightPolicy && preflightPolicy.blockAll) {
        console.log(chalk.red('  ✗ Journeys skipped — blocked by preflight'));
      } else if (site.journeys && site.journeys.length > 0) {
        for (const journeyName of site.journeys) {
          const blockReason = journeyBlockReason(preflightPolicy, journeyName);
          if (blockReason) {
            console.log(chalk.red(`  ✗ Journey "${journeyName}" skipped — ${blockReason}`));
            siteResults.journeys.push({
              name: journeyName, passed: false, flaky: false,
              blocked: true, failedStep: blockReason, steps: []
            });
            continue;
          }
          console.log(chalk.blue(`  Running journey: ${journeyName}...`));
          const journeyResult = await runJourney(journeyName, site, context);
          siteResults.journeys.push(journeyResult);
          if (journeyResult.passed && journeyResult.flaky) {
            console.log(chalk.yellow(`  ⚠ Journey "${journeyName}" passed on retry (flaky)`));
          } else if (journeyResult.passed) {
            console.log(chalk.green(`  ✓ Journey "${journeyName}" passed`));
          } else {
            console.log(chalk.red(`  ✗ Journey "${journeyName}" failed: ${journeyResult.failedStep}`));
          }
        }
      }

      // A flaky pass still counts as passed for the site's overall status, but is
      // tracked separately so the flake is visible and countable, never hidden.
      siteResults.flaky = siteResults.journeys.some(j => j.flaky);
      siteResults.passed = (
        visualFails === 0 &&
        linkFails === 0 &&
        errorPages === 0 &&
        siteResults.journeys.every(j => j.passed) &&
        !(preflightPolicy && preflightPolicy.blockAll)
      );

      // Effect corroboration: after the journeys, ask the plugin what this
      // run's id actually caused server-side. Advisory by default — a miss
      // turns amber and notifies but does not flip passed — because a WAF
      // stripping the header would otherwise fail every run; sites opt into
      // failing via sensors.strictEffects once the header path is proven.
      const expectsEffects = siteResults.journeys.some(j => !j.blocked && EFFECT_EXPECTATIONS[j.name]);
      if (sensorClient && runId && expectsEffects) {
        const eventsResponse = await sensorClient.events(runId);
        siteResults.effects = assembleEffects(
          siteResults.journeys,
          eventsResponse ? (eventsResponse.events || []) : null
        );

        const corroborated = siteResults.effects.filter(e => e.corroborated === true);
        const misses = siteResults.effects.filter(e => e.corroborated === false);
        for (const effect of corroborated) {
          const observed = effect.observed.map(o => `${o.count} ${o.event_type}${o.provider ? ` (${o.provider})` : ''}`).join(', ');
          console.log(chalk.green(`  ✓ Server corroborated "${effect.journey}": ${observed}`));
        }
        for (const effect of misses) {
          console.log(chalk.yellow(`  ⚠ Server corroboration missing for "${effect.journey}": expected ${effect.missing.join(', ')} — not recorded by the plugin`));
        }
        if (misses.length > 0 && site.sensors && site.sensors.strictEffects) {
          console.log(chalk.red('  ✗ strictEffects is on — corroboration miss fails the site'));
          siteResults.passed = false;
        }
      }

    } catch (err) {
      console.error(chalk.red(`  ✗ Test run error: ${err.message}`));
      siteResults.passed = false;
      siteResults.error = err.message;
    } finally {
      await browser.close();
    }

    allResults.push(siteResults);
    saveRun(siteResults);
  }

  return finishRun(allResults);
}

async function finishRun(allResults) {
  const reportPath = await generateReport(allResults);
  console.log(chalk.green(`\n✓ Report generated: ${reportPath}`));

  const failures = allResults.filter(r => !r.passed);
  const flakyCount = allResults.reduce((n, r) => n + r.journeys.filter(j => j.flaky).length, 0);
  const effectsMissCount = allResults.reduce(
    (n, r) => n + (r.effects || []).filter(e => e.corroborated === false).length, 0
  );

  // Notify on failures, flaky passes, OR corroboration misses — an advisory
  // miss that never surfaced in a notification would be indistinguishable
  // from a corroborated pass to anyone not reading the report.
  if (failures.length > 0 || flakyCount > 0 || effectsMissCount > 0) {
    // Each channel gates itself on its enabled flag; a notification failure
    // must not turn a completed test run into a crashed one
    try {
      await sendNotification(allResults, reportPath);
    } catch (err) {
      console.warn(chalk.yellow(`  Email notification failed: ${err.message}`));
    }
    try {
      await sendSlackNotification(allResults, reportPath);
    } catch (err) {
      console.warn(chalk.yellow(`  Slack notification failed: ${err.message}`));
    }
  }

  const totalPassed = allResults.length - failures.length;
  const flakyNote = flakyCount > 0 ? chalk.yellow(`  ${flakyCount} flaky`) : '';
  const missNote = effectsMissCount > 0 ? chalk.yellow(`  ${effectsMissCount} uncorroborated`) : '';
  console.log(chalk.bold(`\nResults: ${chalk.green(totalPassed + ' passed')}  ${failures.length > 0 ? chalk.red(failures.length + ' failed') : ''}${flakyNote}${missNote}`));

  return allResults;
}

async function runProductionSmoke(siteKeys) {
  const sites = getSites(siteKeys);
  const allResults = [];

  for (const site of sites) {
    if (!site.productionUrl) {
      console.log(chalk.yellow(`\n→ Skipping ${site.name} — no productionUrl in config`));
      continue;
    }

    // Production is smoke-only: pages load and console is clean.
    // Functional journeys, form submissions, and visual diffs never run here.
    // auth is cleared too — production is live, not maintenance-mode, and we
    // never log into a production admin during a smoke run. No sensor client
    // and no run id either: production requests must not carry the header.
    const prodSite = { ...site, url: site.productionUrl, journeys: [], auth: null };
    console.log(chalk.bold(`\n→ Production smoke: ${site.name} (${site.productionUrl})`));

    const siteResults = {
      site: `${site.name} (production)`,
      key: site.key,
      url: site.productionUrl,
      timestamp: new Date().toISOString(),
      visual: [],
      links: [],
      console: [],
      journeys: [],
      passed: true,
      flaky: false
    };

    const browser = await chromium.launch();

    try {
      const context = await createContext(browser, prodSite);

      console.log(chalk.blue('  Running smoke journey...'));
      const smokeResult = await runJourney('templates/smoke', prodSite, context);
      siteResults.journeys.push(smokeResult);
      if (smokeResult.passed && smokeResult.flaky) {
        console.log(chalk.yellow('  ⚠ Smoke journey passed on retry (flaky)'));
      } else if (smokeResult.passed) {
        console.log(chalk.green('  ✓ Smoke journey passed'));
      } else {
        console.log(chalk.red(`  ✗ Smoke journey failed: ${smokeResult.failedStep}`));
      }
      siteResults.flaky = siteResults.journeys.some(j => j.flaky);

      console.log(chalk.blue('  Checking for console errors...'));
      const consoleResults = await checkConsoleErrors(context, prodSite, config.settings.timeout);
      siteResults.console = consoleResults;
      const errorPages = consoleResults.filter(r => r.errors.length > 0).length;
      console.log(errorPages > 0
        ? chalk.red(`  ✗ Console errors found on ${errorPages} page(s)`)
        : chalk.green(`  ✓ Console: no errors`)
      );

      siteResults.passed = smokeResult.passed && errorPages === 0;

    } catch (err) {
      console.error(chalk.red(`  ✗ Production smoke error: ${err.message}`));
      siteResults.passed = false;
      siteResults.error = err.message;
    } finally {
      await browser.close();
    }

    allResults.push(siteResults);
    saveRun(siteResults);
  }

  if (allResults.length === 0) {
    console.log(chalk.yellow('\nNo sites with a productionUrl configured — nothing to run.'));
    return [];
  }

  return finishRun(allResults);
}

module.exports = { runBaseline, runTests, runProductionSmoke, dismissCookieBanner };
