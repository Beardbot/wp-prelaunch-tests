const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const configPath = process.env.SITES_CONFIG || path.join(__dirname, '..', 'config', 'sites.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function sendNotification(allResults, reportPath) {
  if (!config.settings.notifications.email.enabled) return;

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

module.exports = { sendNotification };
