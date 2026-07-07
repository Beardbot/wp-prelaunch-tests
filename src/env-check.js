const fs = require('fs');
const chalk = require('chalk');

// dotenv silently truncates an UNQUOTED value at the first '#', treating the
// rest as an inline comment. Secrets (passwords, tokens) routinely contain '#',
// and the failure is invisible downstream because process.env only ever holds
// the already-truncated value. This check re-reads the raw .env and warns when a
// value looks truncated — without ever printing the value itself.

function isQuoted(value) {
  const quotes = ['"', "'", '`'];
  return value.length >= 2 && quotes.some(q => value.startsWith(q) && value.endsWith(q));
}

// Returns the names of env keys whose raw value is unquoted and contains a '#'
// (so dotenv will have cut it short). Pure and side-effect free for testing.
function findTruncatedEnvKeys(rawContent) {
  const suspects = [];

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value || isQuoted(value)) continue;
    if (value.includes('#')) suspects.push(key);
  }

  return suspects;
}

// Warn (never throw) about likely-truncated values in the .env at envPath.
// A missing or unreadable file is a silent no-op. Returns the flagged keys.
function warnOnTruncatedEnv(envPath) {
  let rawContent;
  try {
    rawContent = fs.readFileSync(envPath, 'utf8');
  } catch {
    return [];
  }

  const suspects = findTruncatedEnvKeys(rawContent);
  for (const key of suspects) {
    console.warn(chalk.yellow(`⚠ ${key} in .env looks truncated at '#' — dotenv treats the rest as an inline comment.`));
    console.warn(chalk.yellow(`  If the '#' is part of the value, wrap it in quotes: ${key}="...".`));
  }

  return suspects;
}

module.exports = { warnOnTruncatedEnv, findTruncatedEnvKeys };
