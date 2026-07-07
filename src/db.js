const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'runs.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_key TEXT NOT NULL,
    site_name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    passed INTEGER NOT NULL,
    flaky INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL
  )
`);

// Additive migration for databases created before the flaky column existed, so
// flake frequency is countable (SELECT COUNT(*) FROM runs WHERE flaky = 1)
// without parsing every summary JSON.
const runColumns = db.prepare(`PRAGMA table_info(runs)`).all().map(c => c.name);
if (!runColumns.includes('flaky')) {
  db.exec(`ALTER TABLE runs ADD COLUMN flaky INTEGER NOT NULL DEFAULT 0`);
}

function saveRun(results) {
  const stmt = db.prepare(`
    INSERT INTO runs (site_key, site_name, timestamp, passed, flaky, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    results.key,
    results.site,
    results.timestamp,
    results.passed ? 1 : 0,
    results.flaky ? 1 : 0,
    JSON.stringify(results)
  );
}

function getRunHistory(siteKey, limit = 20) {
  const stmt = db.prepare(`
    SELECT * FROM runs WHERE site_key = ? ORDER BY timestamp DESC LIMIT ?
  `);
  return stmt.all(siteKey, limit).map(row => ({ ...row, summary: JSON.parse(row.summary) }));
}

function getLastBaseline(siteKey) {
  const stmt = db.prepare(`
    SELECT * FROM runs WHERE site_key = ? AND passed = 1 ORDER BY timestamp DESC LIMIT 1
  `);
  const row = stmt.get(siteKey);
  return row ? { ...row, summary: JSON.parse(row.summary) } : null;
}

module.exports = { saveRun, getRunHistory, getLastBaseline };
