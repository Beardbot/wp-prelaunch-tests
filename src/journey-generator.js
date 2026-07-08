'use strict';
const fs   = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');
const { chromium } = require('playwright');

const configPath = process.env.SITES_CONFIG
  || path.join(__dirname, '..', 'config', 'sites.json');

// data-wpt values that belong to known template patterns — not custom journey candidates
const TEMPLATE_WPT_VALUES = new Set([
  'contact-form-submit', 'search-input', 'cookie-dismiss', 'member-dashboard',
  'product-filter', 'post-filter'
]);

// ─── Config helpers ──────────────────────────────────────────────────────────

function readConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`sites.json not found at ${configPath}. Run add-site first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

async function dismissBanner(page, site) {
  if (!site.cookieBannerSelector) return;
  try {
    const banner = page.locator(site.cookieBannerSelector);
    if (await banner.isVisible({ timeout: 3000 })) await banner.click();
  } catch (_) {}
}

async function extractPageData(page) {
  return page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(form => {
      const labels = Array.from(form.querySelectorAll('label'))
        .map(l => ({ text: l.textContent.trim().replace(/\s+/g, ' '), for: l.htmlFor || null }))
        .filter(l => l.text.length > 0 && l.text.length < 60);

      const inputs = Array.from(form.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=button]), textarea'
      )).map(i => ({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name || null,
        id:   i.id   || null,
        dataWpt: i.dataset.wpt || null
      }));

      const submitButtons = Array.from(
        form.querySelectorAll('[type=submit], button[type=submit], button:not([type])')
      ).slice(0, 3).map(b => ({
        text: b.textContent.trim().slice(0, 50),
        dataWpt: b.dataset.wpt || null
      }));

      return { labels, inputs, submitButtons };
    }).filter(f => f.inputs.length > 0);

    const searchInputs = Array.from(
      document.querySelectorAll('input[type=search], input[name=s], input[name=search]')
    ).map(i => ({ type: i.type, name: i.name, dataWpt: i.dataset.wpt || null }));

    const dataWptElements = Array.from(document.querySelectorAll('[data-wpt]')).map(el => ({
      tag:  el.tagName.toLowerCase(),
      wpt:  el.dataset.wpt,
      text: el.textContent.trim().slice(0, 80)
    }));

    return { forms, searchInputs, dataWptElements };
  });
}

// ─── Inspection ──────────────────────────────────────────────────────────────

async function inspectSite(site) {
  const pagesToInspect = new Set(site.pages.map(p => site.url + p));

  for (const extra of ['/contact', '/contact-us', '/my-account']) {
    pagesToInspect.add(site.url + extra);
  }

  if (site.journeys?.some(j => j.includes('woocommerce'))) {
    const shopPath = site.journeyOptions?.['templates/woocommerce']?.shopPath
      || site.journeyOptions?.['woocommerce']?.shopPath
      || '/shop';
    pagesToInspect.add(site.url + shopPath);
  }

  const browser = await chromium.launch();
  const inspections = {};

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    for (const pageUrl of pagesToInspect) {
      const page = await context.newPage();
      try {
        const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (!response || response.status() >= 400) { await page.close(); continue; }
        await dismissBanner(page, site);
        inspections[pageUrl] = await extractPageData(page);
      } catch (_) {
        // skip unreachable pages silently
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return inspections;
}

// ─── Template detection ───────────────────────────────────────────────────────

function detectTemplates(inspections, site) {
  const detected = {};

  for (const [pageUrl, data] of Object.entries(inspections)) {
    let pathname;
    try { pathname = new URL(pageUrl).pathname; } catch { pathname = pageUrl; }

    // Contact form: 2+ text-like fields + a submit button
    if (!detected['contact-form']) {
      for (const form of data.forms) {
        const textFields = form.inputs.filter(i =>
          ['text', 'email', 'tel', 'textarea'].includes(i.type)
        );
        if (textFields.length >= 2 && form.submitButtons.length > 0) {
          detected['contact-form'] = { pageUrl, pathname, form };
          break;
        }
      }
    }

    // Search: standard WP search input or data-wpt="search-input"
    if (!detected.search && (
      data.searchInputs.length > 0 ||
      data.dataWptElements.some(e => e.wpt === 'search-input')
    )) {
      detected.search = { pageUrl, pathname, inputs: data.searchInputs };
    }

    // Login: /my-account with credential fields
    if (!detected.login && /^\/my-account\/?$/.test(pathname)) {
      const hasCredentials = data.forms.some(f =>
        f.inputs.some(i => i.type === 'email' || ['username', 'email'].includes(i.name)) &&
        f.inputs.some(i => i.type === 'password')
      );
      if (hasCredentials) detected.login = { pageUrl, pathname };
    }
  }

  // WooCommerce: already handled by add-site, just note its presence
  if (site.journeys?.some(j => j.includes('woocommerce'))) {
    detected.woocommerce = { existing: true };
  }

  // Custom candidates: data-wpt elements not covered by any template
  const customCandidates = Object.entries(inspections).flatMap(([pageUrl, data]) =>
    data.dataWptElements
      .filter(el => !TEMPLATE_WPT_VALUES.has(el.wpt))
      .map(el => ({ ...el, pageUrl }))
  );
  if (customCandidates.length > 0) detected._customCandidates = customCandidates;

  return detected;
}

// ─── Config builders ──────────────────────────────────────────────────────────

function buildJourneyOptions(detected, inspections, site) {
  const journeyOptions = {};
  const newJourneys   = [];

  // Contact form
  if (detected['contact-form']) {
    const { pathname, form } = detected['contact-form'];
    const contactPath = pathname.replace(/\/$/, '') || '/contact';

    const fields = form.labels
      .filter(l => l.text)
      .map(l => ({ label: l.text, value: '' }));

    const submitBtn = form.submitButtons.find(b => b.dataWpt);
    const submitSelector = submitBtn ? `[data-wpt="${submitBtn.dataWpt}"]` : null;

    const opts = {};
    if (contactPath !== '/contact') opts.path = contactPath;
    if (fields.length > 0)         opts.fields = fields;
    if (submitSelector)            opts.submitSelector = submitSelector;

    journeyOptions['templates/contact-form'] = opts;
    if (!site.journeys?.includes('templates/contact-form')) {
      newJourneys.push('templates/contact-form');
    }
  }

  // Search
  if (detected.search) {
    const searchInput = detected.search.inputs[0];
    const wptEl = Object.values(inspections)
      .flatMap(d => d.dataWptElements)
      .find(e => e.wpt === 'search-input');

    const opts = {};
    if (searchInput?.dataWpt) opts.formSelector = `[data-wpt="${searchInput.dataWpt}"]`;
    else if (wptEl)           opts.formSelector = `[data-wpt="search-input"]`;

    if (Object.keys(opts).length > 0) journeyOptions['templates/search'] = opts;
    if (!site.journeys?.includes('templates/search')) newJourneys.push('templates/search');
  }

  // Login
  if (detected.login) {
    const loginPath = detected.login.pathname.replace(/\/$/, '') || '/my-account';
    const opts = {};
    if (loginPath !== '/my-account') opts.loginPath = loginPath;
    if (Object.keys(opts).length > 0) journeyOptions['templates/login'] = opts;
    if (!site.journeys?.includes('templates/login')) newJourneys.push('templates/login');
  }

  return { journeyOptions, newJourneys };
}

// ─── Custom journey candidates ────────────────────────────────────────────────

// data-wpt elements that don't match any template usually signal a site-specific
// flow (LMS, booking, Gravity Forms, etc.) that deserves a hand-authored, reviewed
// custom journey. We surface them as a pointer rather than auto-generating
// unreviewed Playwright code: use the interactive `create-journey` skill, which
// walks the live flow with a developer and leaves the journey for review.
function noteCustomCandidates(site, customCandidates) {
  console.log(chalk.yellow('\n  ℹ  Unrecognised data-wpt elements found — a custom journey may be useful.'));
  console.log(chalk.dim('     Elements: ' + customCandidates.map(e => `[data-wpt="${e.wpt}"]`).join(', ')));
  console.log(chalk.dim(`     To scaffold one, run the "create-journey" skill with a description of the flow`));
  console.log(chalk.dim(`     and the site key "${site.key}" (see .claude/skills/create-journey and docs/custom-journeys.md).`));
}

// ─── Output ───────────────────────────────────────────────────────────────────

function confirm(question, { defaultYes = true } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') return resolve(defaultYes);
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}

function printPreview(journeyOptions, newJourneys) {
  if (newJourneys.length === 0 && Object.keys(journeyOptions).length === 0) {
    console.log(chalk.yellow('\n  No new journeys detected.'));
    return;
  }
  if (newJourneys.length > 0) {
    console.log('');
    console.log(chalk.bold('  Journeys to add:'));
    for (const j of newJourneys) {
      console.log(chalk.green(`    + ${j}`));
    }
  }
  if (Object.keys(journeyOptions).length > 0) {
    console.log('');
    console.log(chalk.bold('  Generated journeyOptions:'));
    const lines = JSON.stringify(journeyOptions, null, 2).split('\n');
    console.log(chalk.dim(lines.map(l => '    ' + l).join('\n')));
  }
}

async function applyResults(site, { journeyOptions, newJourneys }, { dryRun }) {
  printPreview(journeyOptions, newJourneys);

  if (dryRun) {
    console.log(chalk.yellow('\n  Dry run — nothing written.'));
    return;
  }

  if (newJourneys.length === 0 && Object.keys(journeyOptions).length === 0) {
    return;
  }

  if (newJourneys.length > 0 || Object.keys(journeyOptions).length > 0) {
    const ok = await confirm('\n  Write to sites.json? [Y/n] ');
    if (!ok) {
      console.log(chalk.yellow('  Skipped.'));
    } else {
      const freshConfig = readConfig();
      const siteEntry = freshConfig.sites.find(s => s.key === site.key);
      if (!siteEntry) throw new Error(`Site "${site.key}" not found in config — cannot write.`);

      siteEntry.journeys = [...new Set([...(siteEntry.journeys || []), ...newJourneys])];
      siteEntry.journeyOptions = siteEntry.journeyOptions || {};
      for (const [k, v] of Object.entries(journeyOptions)) {
        if (Object.keys(v).length > 0) {
          siteEntry.journeyOptions[k] = { ...(siteEntry.journeyOptions[k] || {}), ...v };
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(freshConfig, null, 2) + '\n');
      console.log(chalk.green('\n  ✓ sites.json updated'));
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function generateJourney(siteKey, { dryRun = false } = {}) {
  const config = readConfig();
  const site = config.sites.find(s => s.key === siteKey);
  if (!site) {
    throw new Error(`Site "${siteKey}" not found in sites.json. Run add-site first.`);
  }

  console.log(chalk.blue(`\n  Inspecting ${site.name} (${site.url})...`));
  const inspections = await inspectSite(site);

  const pageCount = Object.keys(inspections).length;
  if (pageCount === 0) {
    console.log(chalk.yellow('  No pages could be loaded — is the staging site accessible?'));
    return;
  }
  console.log(chalk.dim(`  Inspected ${pageCount} page(s)`));

  const detected       = detectTemplates(inspections, site);
  const { journeyOptions, newJourneys } = buildJourneyOptions(detected, inspections, site);

  if (detected._customCandidates) {
    noteCustomCandidates(site, detected._customCandidates);
  }

  await applyResults(site, { journeyOptions, newJourneys }, { dryRun });
}

module.exports = { generateJourney };
