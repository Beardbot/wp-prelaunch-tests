const fs = require('fs');
const path = require('path');

// Every dynamic string interpolated into the report goes through this. Step
// errors, page titles, URLs, and preflight details all originate outside this
// codebase (sites, browsers, the sensor plugin) and must never be able to
// inject markup into the report.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CHECK_COLORS = { pass: '#1D9E75', fail: '#E24B4A', unknown: '#BA7517' };

// The "Preflight" block for one site card: environment verdict, any blocks
// the policy imposed, and the full check table. Only rendered when the run
// had a working sensor (site.preflight set by the orchestrator).
function preflightBlock(site) {
  if (!site.preflight) return '';

  const environment = site.preflight.environment || {};
  const policy = site.preflight.policy || {};
  const checks = site.preflight.checks || [];

  const verdictColor = environment.verdict === 'staging' ? '#1D9E75'
    : environment.verdict === 'production' ? '#E24B4A' : '#BA7517';

  const blockLines = [
    policy.blockAll ? `<div style="color:#E24B4A;font-size:13px;margin-top:4px">Journeys blocked: ${esc(policy.blockAll)}</div>` : '',
    !policy.blockAll && policy.paymentBlock ? `<div style="color:#E24B4A;font-size:13px;margin-top:4px">Checkout journeys blocked: ${esc(policy.paymentBlock)}</div>` : ''
  ].join('');

  const checkRows = checks.map(c => `<tr>
        <td>${esc(c.id)}</td>
        <td style="color:${CHECK_COLORS[c.status] || '#888'};font-weight:500">${esc(String(c.status).toUpperCase())}</td>
        <td style="color:#666">${esc(c.detail)}</td>
      </tr>`).join('');

  return `
          <div style="grid-column:1 / -1">
            <h4 style="margin:0 0 8px;font-size:14px">Preflight (server-side checks)</h4>
            <div style="font-size:13px">Environment verdict: <strong style="color:${verdictColor}">${esc(environment.verdict || 'unknown')}</strong>${environment.wp_environment_type ? ` <span style="color:#888">(wp_environment_type: ${esc(environment.wp_environment_type)})</span>` : ''}</div>
            ${blockLines}
            <table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:8px">
              <tr style="background:#f5f5f5"><th style="text-align:left;padding:4px 8px">Check</th><th style="text-align:left;padding:4px 8px">Status</th><th style="text-align:left;padding:4px 8px">Detail</th></tr>
              ${checkRows}
            </table>
          </div>`;
}

// The server-corroboration line for one journey: green when every expected
// effect was recorded, amber when the browser saw success but the server did
// not, grey when there was nothing to judge.
function effectsLine(site, journeyName) {
  const effect = (site.effects || []).find(e => e.journey === journeyName);
  if (!effect) return '';

  if (effect.corroborated === true) {
    const observed = effect.observed
      .map(o => `${o.count} ${esc(o.event_type)}${o.provider ? ` (${esc(o.provider)})` : ''}`)
      .join(', ');
    return `<div style="font-size:12px;color:#1D9E75;margin-top:2px">Server corroborated: ${observed}</div>`;
  }
  if (effect.corroborated === false) {
    return `<div style="font-size:12px;color:#BA7517;margin-top:2px">Server corroboration missing: expected ${esc(effect.missing.join(', '))} — not recorded by the plugin</div>`;
  }
  return `<div style="font-size:12px;color:#888;margin-top:2px">Server corroboration unavailable: ${esc(effect.note || '')}</div>`;
}

async function generateReport(allResults) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(__dirname, '..', 'data', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `report-${timestamp}.html`);

  const totalPassed = allResults.filter(r => r.passed).length;
  const totalFailed = allResults.filter(r => !r.passed).length;
  const totalFlaky = allResults.reduce((n, r) => n + r.journeys.filter(j => j.flaky).length, 0);

  const siteCards = allResults.map(site => {
    const visualFails = site.visual.filter(v => v.status === 'fail').length;
    const siteFlaky = site.journeys.filter(j => j.flaky).length;

    const statusColor = site.passed ? '#1D9E75' : '#E24B4A';
    const statusLabel = site.passed ? 'PASSED' : 'FAILED';

    const visualRows = site.visual.map(v => {
      const color = v.status === 'pass' ? '#1D9E75' : v.status === 'fail' ? '#E24B4A' : '#BA7517';
      return `<tr>
        <td><a href="${esc(site.url + v.page)}" target="_blank" style="color:inherit">${esc(v.page)}</a></td>
        <td style="color:${color};font-weight:500">${esc(v.status.toUpperCase())}</td>
        <td>${v.diffPercent !== null ? esc(v.diffPercent) + '%' : '—'}</td>
      </tr>`;
    }).join('');

    const linkRows = site.links
      .filter(l => l.status === 0 || l.status >= 400)
      .map(l => `<tr>
        <td style="word-break:break-all"><a href="${esc(l.url)}" target="_blank" style="color:inherit">${esc(l.url)}</a></td>
        <td style="color:#E24B4A;font-weight:500">${esc(l.status || 'ERR')}</td>
        <td style="color:#888;font-size:12px">${l.type === 'link' ? `<a href="${esc(site.url + l.page)}" target="_blank" style="color:inherit">${esc(l.page)}</a>` : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="3" style="color:#1D9E75">No broken links</td></tr>';

    const consoleRows = site.console.map(c => {
      if (c.errors.length === 0) return '';
      return `<tr><td><a href="${esc(site.url + c.page)}" target="_blank" style="color:inherit">${esc(c.page)}</a></td><td>${c.errors.map(e => `<div style="color:#E24B4A;font-size:12px">${esc(e.type)}: ${esc(e.text)}</div>`).join('')}</td></tr>`;
    }).filter(Boolean).join('') || '<tr><td colspan="2" style="color:#1D9E75">No console errors</td></tr>';

    const journeyRows = site.journeys.map(j => {
      const steps = (j.steps || []).map(s => {
        const c = s.status === 'pass' ? '#1D9E75' : '#E24B4A';
        const screenshotHtml = s.screenshot && fs.existsSync(s.screenshot)
          ? `<div style="margin-top:6px"><img src="${esc(s.screenshot)}" style="max-width:100%;border:1px solid #ddd;border-radius:4px" alt="Failure screenshot"></div>`
          : '';
        return `<div style="font-size:12px;color:${c};margin:2px 0">
          ${s.status === 'pass' ? '✓' : '✗'} ${esc(s.name)}${s.error ? ': <em>' + esc(s.error) + '</em>' : ''}
          ${screenshotHtml}
        </div>`;
      }).join('');
      const journeyColor = j.blocked ? '#E24B4A' : j.flaky ? '#BA7517' : j.passed ? '#1D9E75' : '#E24B4A';
      const journeyLabel = j.blocked ? 'Blocked by preflight' : j.flaky ? 'Passed on retry (flaky)' : j.passed ? 'Passed' : 'Failed';
      const blockedNote = j.blocked
        ? `<div style="font-size:12px;color:#E24B4A;margin-top:2px">${esc(j.failedStep)}</div>`
        : '';
      const flakyNote = j.flaky && j.firstAttemptFailure
        ? `<div style="font-size:12px;color:#BA7517;margin-top:2px">First attempt failed: <em>${esc(j.firstAttemptFailure)}</em> — passed on the automatic retry</div>`
        : '';
      return `<div style="margin-bottom:12px">
        <strong>${esc(j.name)}</strong> — <span style="color:${journeyColor}">${journeyLabel}</span>
        ${blockedNote}
        ${flakyNote}
        ${effectsLine(site, j.name)}
        <div style="margin-top:6px">${steps}</div>
      </div>`;
    }).join('')
      || (site.preflight && site.preflight.policy && site.preflight.policy.blockAll
        ? `<div style="color:#E24B4A">Journeys skipped — blocked by preflight: ${esc(site.preflight.policy.blockAll)}</div>`
        : '<div style="color:#888">No journeys configured</div>');

    return `
      <div style="border:1px solid #e0e0e0;border-radius:8px;margin-bottom:24px;overflow:hidden">
        <div style="background:${site.passed ? '#E1F5EE' : '#FCEBEB'};padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:18px;font-weight:600">${esc(site.site)}</div>
            <div style="font-size:13px;color:#666;margin-top:2px"><a href="${esc(site.url)}" target="_blank" style="color:inherit">${esc(site.url)}</a></div>
          </div>
          <div style="text-align:right">
            <div style="color:${statusColor};font-weight:700;font-size:16px">${statusLabel}</div>
            ${siteFlaky > 0 ? `<div style="color:#BA7517;font-size:12px;font-weight:600;margin-top:2px">${siteFlaky} flaky (passed on retry)</div>` : ''}
          </div>
        </div>
        <div style="padding:20px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
            ${preflightBlock(site)}
            <div>
              <h4 style="margin:0 0 8px;font-size:14px">Visual diff</h4>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="background:#f5f5f5"><th style="text-align:left;padding:4px 8px">Page</th><th style="text-align:left;padding:4px 8px">Status</th><th style="text-align:left;padding:4px 8px">Diff</th></tr>
                ${visualRows}
              </table>
            </div>
            <div>
              <h4 style="margin:0 0 8px;font-size:14px">Broken links</h4>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="background:#f5f5f5"><th style="text-align:left;padding:4px 8px">URL</th><th style="text-align:left;padding:4px 8px">Status</th><th style="text-align:left;padding:4px 8px">Found on</th></tr>
                ${linkRows}
              </table>
            </div>
            <div>
              <h4 style="margin:0 0 8px;font-size:14px">Console errors</h4>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="background:#f5f5f5"><th style="text-align:left;padding:4px 8px">Page</th><th style="text-align:left;padding:4px 8px">Errors</th></tr>
                ${consoleRows}
              </table>
            </div>
            <div>
              <h4 style="margin:0 0 8px;font-size:14px">Journeys</h4>
              ${journeyRows}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WP Pre-launch Report — ${esc(new Date().toLocaleDateString())}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f8f8f8; color: #1a1a1a; }
  .header { background: #1a1a2e; color: white; padding: 24px 40px; }
  .header h1 { margin: 0; font-size: 22px; font-weight: 600; }
  .header .meta { font-size: 13px; color: #aaa; margin-top: 4px; }
  .summary { display: flex; gap: 16px; padding: 24px 40px 0; }
  .stat { background: white; border-radius: 8px; padding: 16px 24px; border: 1px solid #e0e0e0; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .lbl { font-size: 12px; color: #888; margin-top: 2px; }
  .sites { padding: 24px 40px 40px; }
  table td, table th { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; }
</style>
</head>
<body>
<div class="header">
  <h1>WP Pre-launch Test Report</h1>
  <div class="meta">Run at ${esc(new Date().toLocaleString())}</div>
</div>
<div class="summary">
  <div class="stat"><div class="num">${allResults.length}</div><div class="lbl">Sites tested</div></div>
  <div class="stat"><div class="num" style="color:#1D9E75">${totalPassed}</div><div class="lbl">Passed</div></div>
  <div class="stat"><div class="num" style="color:#E24B4A">${totalFailed}</div><div class="lbl">Failed</div></div>
  <div class="stat"><div class="num" style="color:#BA7517">${totalFlaky}</div><div class="lbl">Flaky (passed on retry)</div></div>
</div>
<div class="sites">${siteCards}</div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  return reportPath;
}

module.exports = { generateReport, esc };
