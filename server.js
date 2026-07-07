require('dotenv').config();
const path = require('path');
require('./src/env-check').warnOnTruncatedEnv(path.resolve(process.cwd(), '.env'));
const express = require('express');
const chalk = require('chalk');
const { runTests } = require('./src/orchestrator');

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.WP_PRELAUNCH_SECRET;

if (!SECRET) {
  console.error(chalk.red('Error: WP_PRELAUNCH_SECRET is not set in your .env file'));
  process.exit(1);
}

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'WP Pre-launch Tests server running' });
});

app.post('/run', async (req, res) => {
  const { secret, site } = req.body;

  if (secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  res.json({ status: 'accepted', message: `Test run started for: ${site || 'all sites'}` });

  console.log(chalk.blue(`\n→ Webhook trigger received for: ${site || 'all sites'}`));

  try {
    // site may be a string key or null — wrap in array for orchestrator
    const siteKeys = site ? [site] : [];
    await runTests(siteKeys);
  } catch (err) {
    console.error(chalk.red('Test run error:'), err);
  }
});

app.listen(PORT, () => {
  console.log(chalk.cyan(`\nWP Pre-launch Tests server running on port ${PORT}`));
  console.log(chalk.gray(`Webhook endpoint: POST http://localhost:${PORT}/run`));
});
