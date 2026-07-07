require('dotenv').config();
const path = require('path');
require('./src/env-check').warnOnTruncatedEnv(path.resolve(process.cwd(), '.env'));
const minimist = require('minimist');
const chalk = require('chalk');
const { runBaseline, runTests, runProductionSmoke } = require('./src/orchestrator');

const args = minimist(process.argv.slice(2), { boolean: ['production', 'dry-run'] });
const mode = args.mode || args.m;
const siteKeys = args.site
  ? [].concat(args.site)
  : args.s
    ? [].concat(args.s)
    : args._;

const banner = `
╔══════════════════════════════════════════╗
║        WP Pre-launch Tests              ║
╚══════════════════════════════════════════╝
`;

async function main() {
  console.log(chalk.cyan(banner));

  if (!mode || !['baseline', 'test', 'add-site', 'generate-journey'].includes(mode)) {
    console.log(chalk.yellow('Usage:'));
    console.log('  baseline                          — capture baseline for all sites');
    console.log('  baseline <key> [key2 ...]         — capture baseline for one or more sites');
    console.log('  test                              — run pre-launch tests for all sites');
    console.log('  test <key> [key2 ...]             — run pre-launch tests for one or more sites');
    console.log('  test [key ...] --production       — smoke-only checks against productionUrl');
    console.log('  add-site <url> [url2 ...]         — import one or more sites into sites.json');
    console.log('  add-site <url> --dry-run          — preview generated site config without writing');
    console.log('  generate-journey <key>            — generate journeyOptions config from live DOM');
    console.log('  generate-journey <key> --dry-run  — preview without writing');
    console.log('');
    console.log(chalk.dim("  Didn't run npm link? Use: npm run baseline  /  npm run test -- <key>  /  npm run add-site -- <url>"));
    process.exit(0);
  }

  if (mode === 'baseline') {
    console.log(chalk.blue('Mode: capturing baseline screenshots\n'));
    await runBaseline(siteKeys);
  } else if (mode === 'test') {
    if (args.production) {
      console.log(chalk.blue('Mode: production smoke checks (pages load, console clean — no journeys)\n'));
      await runProductionSmoke(siteKeys);
    } else {
      console.log(chalk.blue('Mode: running pre-launch tests\n'));
      await runTests(siteKeys);
    }
  } else if (mode === 'add-site') {
    if (!siteKeys.length) {
      console.log(chalk.yellow('Usage:'));
      console.log('  add-site <url> [url2 ...] [--dry-run]');
      process.exit(0);
    }
    const { importSite } = require('./src/site-importer');
    console.log(chalk.blue('Mode: importing site configuration\n'));
    for (const url of siteKeys) {
      await importSite(url, { dryRun: !!args['dry-run'] });
    }
  } else if (mode === 'generate-journey') {
    if (!siteKeys.length) {
      console.log(chalk.yellow('Usage:'));
      console.log('  generate-journey <key> [--dry-run]');
      process.exit(0);
    }
    const { generateJourney } = require('./src/journey-generator');
    console.log(chalk.blue('Mode: generating journey config from live DOM\n'));
    for (const key of siteKeys) {
      await generateJourney(key, { dryRun: !!args['dry-run'] });
    }
  }
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
