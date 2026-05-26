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
const { sendNotification } = require('./notifier');

const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com/tr',
  'hotjar.com',
  'clarity.ms',
  'doubleclick.net',
  'adservice.google.com'
];

async function createContext(browser, site) {
  const context = await browser.newContext({
    viewport: {
      width: config.settings.screenshotWidth || 1280,
      height: config.settings.screenshotHeight || 900
    }
  });

  // Block analytics and tracking to avoid polluting client dashboards and speed up runs
  await context.route('**/*', route => {
    const url = route.request().url();
    if (BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
      route.abort();
    } else {
      route.continue();
    }
  });

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
  return config.sites;
}

async function runBaseline(siteKeys) {
  const sites = getSites(siteKeys);

  for (const site of sites) {
    console.log(chalk.bold(`\n→ Capturing baseline for: ${site.name}`));
    const browser = await chromium.launch();
    const context = await createContext(browser, site);

    try {
      const screenshots = await captureScreenshots(context, site, 'baseline');
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
      passed: true
    };

    const browser = await chromium.launch();
    const context = await createContext(browser, site);

    try {
      // Visual diff
      console.log(chalk.blue('  Running visual diff...'));
      const newShots = await captureScreenshots(context, site, 'test');
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

      // Journeys
      if (site.journeys && site.journeys.length > 0) {
        for (const journeyName of site.journeys) {
          console.log(chalk.blue(`  Running journey: ${journeyName}...`));
          const journeyResult = await runJourney(journeyName, site, context);
          siteResults.journeys.push(journeyResult);
          console.log(journeyResult.passed
            ? chalk.green(`  ✓ Journey "${journeyName}" passed`)
            : chalk.red(`  ✗ Journey "${journeyName}" failed: ${journeyResult.failedStep}`)
          );
        }
      }

      siteResults.passed = (
        visualFails === 0 &&
        linkFails === 0 &&
        errorPages === 0 &&
        siteResults.journeys.every(j => j.passed)
      );

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

  const reportPath = await generateReport(allResults);
  console.log(chalk.green(`\n✓ Report generated: ${reportPath}`));

  const failures = allResults.filter(r => !r.passed);
  if (failures.length > 0 && config.settings.notifications.email.enabled) {
    await sendNotification(allResults, reportPath);
  }

  const totalFailed = allResults.filter(r => !r.passed).length;
  const totalPassed = allResults.filter(r => r.passed).length;
  console.log(chalk.bold(`\nResults: ${chalk.green(totalPassed + ' passed')}  ${totalFailed > 0 ? chalk.red(totalFailed + ' failed') : ''}`));

  return allResults;
}

module.exports = { runBaseline, runTests, dismissCookieBanner };
