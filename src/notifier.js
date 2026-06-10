const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const configPath = process.env.SITES_CONFIG || path.join(__dirname, '..', 'config', 'sites.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function sendNotification(allResults, reportPath) {
  if (!config.settings.notifications.email.enabled) return;
  if (!process.env.SMTP_HOST) {
    console.warn('Email notifications enabled but SMTP_HOST is not set — skipping email.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const failures = allResults.filter(r => !r.passed);
  const passed = allResults.filter(r => r.passed);

  const subject = failures.length > 0
    ? `⚠️ WP Pre-launch: ${failures.length} site(s) failed`
    : `✓ WP Pre-launch: All sites passed`;

  const failureList = failures.map(f => `
    <li><strong>${f.site}</strong> (${f.url})
      <ul>
        ${f.visual.filter(v => v.status === 'fail').map(v => `<li>Visual diff: ${v.page} (${v.diffPercent}% change)</li>`).join('')}
        ${f.links.filter(l => l.status === 0 || l.status >= 400).map(l => `<li>Broken link: ${l.url} (${l.status})</li>`).join('')}
        ${f.console.filter(c => c.errors.length > 0).map(c => `<li>Console errors on ${c.page}</li>`).join('')}
        ${f.journeys.filter(j => !j.passed).map(j => `<li>Journey failed: ${j.name} — ${j.failedStep}</li>`).join('')}
      </ul>
    </li>`).join('');

  const html = `
    <h2>WP Pre-launch Test Results</h2>
    <p>Run at ${new Date().toLocaleString()}</p>
    <p><strong>${passed.length}</strong> passed &nbsp; <strong style="color:#E24B4A">${failures.length}</strong> failed</p>
    ${failures.length > 0 ? `<h3>Failures</h3><ul>${failureList}</ul>` : '<p style="color:#1D9E75">All sites passed ✓</p>'}
    <p style="font-size:12px;color:#888">Full report saved to: ${reportPath}</p>
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
  if (failures.length === 0) return; // Slack is failure-only — email covers pass summaries

  const failureLines = failures.map(f => {
    const problems = [
      ...f.visual.filter(v => v.status === 'fail').map(v => `visual diff on ${v.page} (${v.diffPercent}%)`),
      ...f.links.filter(l => l.status === 0 || l.status >= 400).map(l => `broken link ${l.url} (${l.status})`),
      ...f.console.filter(c => c.errors.length > 0).map(c => `console errors on ${c.page}`),
      ...f.journeys.filter(j => !j.passed).map(j => `journey ${j.name} — ${j.failedStep}`)
    ];
    if (f.error) problems.push(`run error: ${f.error}`);
    return `• *${f.site}* (${f.url})\n${problems.map(p => `    ◦ ${p}`).join('\n')}`;
  }).join('\n');

  const text = `:warning: *WP Pre-launch: ${failures.length} site(s) failed*\n${failureLines}\n_Full report: ${reportPath}_`;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }
}

module.exports = { sendNotification, sendSlackNotification };
