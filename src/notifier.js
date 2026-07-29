const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { esc } = require('./reporter');

const configPath = process.env.SITES_CONFIG || path.join(__dirname, '..', 'config', 'sites.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// A journey that failed once and passed on the automatic retry is a real pass,
// but flagging it keeps a flaky result from looking identical to a clean one.
function collectFlaky(allResults) {
  const flaky = [];
  for (const r of allResults) {
    for (const j of (r.journeys || [])) {
      if (j.flaky) {
        flaky.push({
          site: r.site,
          url: r.url,
          name: j.name,
          firstAttemptFailure: j.firstAttemptFailure || null
        });
      }
    }
  }
  return flaky;
}

// Journeys that passed in the browser while the sensor plugin recorded no
// matching server-side effect. Advisory by default (the site still passes),
// so like flaky results they must surface in notifications or they would be
// indistinguishable from corroborated passes.
function collectEffectsMisses(allResults) {
  const misses = [];
  for (const r of allResults) {
    for (const e of (r.effects || [])) {
      if (e.corroborated === false) {
        misses.push({
          site: r.site,
          url: r.url,
          journey: e.journey,
          missing: e.missing || []
        });
      }
    }
  }
  return misses;
}

async function sendNotification(allResults, reportPath) {
  if (!config.settings.notifications.email.enabled) return;
  if (!process.env.SMTP_HOST) {
    console.warn('Email notifications enabled but SMTP_HOST is not set — skipping email.');
    return;
  }

  const failures = allResults.filter(r => !r.passed);
  const passed = allResults.filter(r => r.passed);
  const flaky = collectFlaky(allResults);
  const misses = collectEffectsMisses(allResults);

  // Nothing worth a mail: a clean, corroborated, non-flaky all-pass run stays silent as before.
  if (failures.length === 0 && flaky.length === 0 && misses.length === 0) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const notables = [
    flaky.length ? `${flaky.length} flaky journey(s)` : '',
    misses.length ? `${misses.length} uncorroborated journey(s)` : ''
  ].filter(Boolean).join(', ');
  const subject = failures.length > 0
    ? `⚠️ WP Pre-launch: ${failures.length} site(s) failed${notables ? `, ${notables}` : ''}`
    : `⚠️ WP Pre-launch: all sites passed — ${notables}`;

  const failureList = failures.map(f => `
    <li><strong>${esc(f.site)}</strong> (${esc(f.url)})
      <ul>
        ${f.preflight?.policy?.blockAll ? `<li>Preflight blocked all journeys: ${esc(f.preflight.policy.blockAll)}</li>` : ''}
        ${f.visual.filter(v => v.status === 'fail').map(v => `<li>Visual diff: ${esc(v.page)} (${esc(v.diffPercent)}% change)</li>`).join('')}
        ${f.links.filter(l => l.status === 0 || l.status >= 400).map(l => `<li>Broken link: ${esc(l.url)} (${esc(l.status)})</li>`).join('')}
        ${f.console.filter(c => c.errors.length > 0).map(c => `<li>Console errors on ${esc(c.page)}</li>`).join('')}
        ${f.journeys.filter(j => !j.passed).map(j => `<li>Journey ${j.blocked ? 'blocked' : 'failed'}: ${esc(j.name)} — ${esc(j.failedStep)}</li>`).join('')}
      </ul>
    </li>`).join('');

  const flakySection = flaky.length > 0 ? `
    <h3 style="color:#BA7517">Flaky — passed on retry</h3>
    <ul>
      ${flaky.map(f => `<li><strong>${esc(f.site)}</strong> — journey <code>${esc(f.name)}</code>${f.firstAttemptFailure ? ` (first attempt: ${esc(f.firstAttemptFailure)})` : ''}</li>`).join('')}
    </ul>
    <p style="font-size:12px;color:#888">These journeys failed once and passed on the automatic retry — a real pass, but the site or staging environment showed instability worth noting.</p>
  ` : '';

  const missesSection = misses.length > 0 ? `
    <h3 style="color:#BA7517">Server corroboration missing</h3>
    <ul>
      ${misses.map(m => `<li><strong>${esc(m.site)}</strong> — journey <code>${esc(m.journey)}</code> expected ${esc(m.missing.join(', '))} — not recorded by the sensor plugin</li>`).join('')}
    </ul>
    <p style="font-size:12px;color:#888">These journeys passed in the browser, but the sensor plugin recorded no matching server-side effect. The success message may be cosmetic (mail or form entry never happened) — or a WAF stripped the run-id header.</p>
  ` : '';

  const html = `
    <h2>WP Pre-launch Test Results</h2>
    <p>Run at ${esc(new Date().toLocaleString())}</p>
    <p><strong>${passed.length}</strong> passed &nbsp; <strong style="color:#E24B4A">${failures.length}</strong> failed${flaky.length ? ` &nbsp; <strong style="color:#BA7517">${flaky.length}</strong> flaky` : ''}${misses.length ? ` &nbsp; <strong style="color:#BA7517">${misses.length}</strong> uncorroborated` : ''}</p>
    ${failures.length > 0 ? `<h3>Failures</h3><ul>${failureList}</ul>` : '<p style="color:#1D9E75">All sites passed ✓</p>'}
    ${flakySection}
    ${missesSection}
    <p style="font-size:12px;color:#888">Full report saved to: ${esc(reportPath)}</p>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.SMTP_TO,
    subject,
    html
  });
}

async function sendSlackNotification(allResults, reportPath) {
  const slackSettings = config.settings.notifications.slack || {};
  if (!slackSettings.enabled) return;

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('Slack notifications enabled but SLACK_WEBHOOK_URL is not set — skipping Slack.');
    return;
  }

  const failures = allResults.filter(r => !r.passed);
  const flaky = collectFlaky(allResults);
  const misses = collectEffectsMisses(allResults);
  // Slack stays quiet on a clean pass (email covers pass summaries), but flaky
  // passes and uncorroborated journeys are noteworthy, so post on any of them.
  if (failures.length === 0 && flaky.length === 0 && misses.length === 0) return;

  const failureLines = failures.map(f => {
    const problems = [
      ...(f.preflight?.policy?.blockAll ? [`preflight blocked all journeys: ${f.preflight.policy.blockAll}`] : []),
      ...f.visual.filter(v => v.status === 'fail').map(v => `visual diff on ${v.page} (${v.diffPercent}%)`),
      ...f.links.filter(l => l.status === 0 || l.status >= 400).map(l => `broken link ${l.url} (${l.status})`),
      ...f.console.filter(c => c.errors.length > 0).map(c => `console errors on ${c.page}`),
      ...f.journeys.filter(j => !j.passed).map(j => `journey ${j.name} — ${j.failedStep}`)
    ];
    if (f.error) problems.push(`run error: ${f.error}`);
    return `• *${f.site}* (${f.url})\n${problems.map(p => `    ◦ ${p}`).join('\n')}`;
  }).join('\n');

  const flakyLines = flaky.map(f =>
    `• *${f.site}* (${f.url})\n    ◦ journey ${f.name} — passed on retry (flaky)${f.firstAttemptFailure ? ` [first attempt: ${f.firstAttemptFailure}]` : ''}`
  ).join('\n');

  const missLines = misses.map(m =>
    `• *${m.site}* (${m.url})\n    ◦ journey ${m.journey} — passed in the browser but expected ${m.missing.join(', ')} not recorded by the sensor plugin`
  ).join('\n');

  const notables = [
    flaky.length ? `${flaky.length} flaky journey(s)` : '',
    misses.length ? `${misses.length} uncorroborated journey(s)` : ''
  ].filter(Boolean).join(', ');
  const header = failures.length > 0
    ? `:warning: *WP Pre-launch: ${failures.length} site(s) failed${notables ? `, ${notables}` : ''}*`
    : `:warning: *WP Pre-launch: all sites passed — ${notables}*`;

  const sections = [header];
  if (failures.length > 0) sections.push(failureLines);
  if (flaky.length > 0) sections.push(`_Flaky (passed on retry):_\n${flakyLines}`);
  if (misses.length > 0) sections.push(`_Uncorroborated (no server-side record):_\n${missLines}`);
  sections.push(`_Full report: ${reportPath}_`);
  const text = sections.join('\n');

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }
}

module.exports = { sendNotification, sendSlackNotification, collectFlaky, collectEffectsMisses };
