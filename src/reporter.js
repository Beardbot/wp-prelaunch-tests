const fs = require('fs');
const path = require('path');

async function generateReport(allResults) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(__dirname, '..', 'data', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `report-${timestamp}.html`);

  const totalPassed = allResults.filter(r => r.passed).length;
  const totalFailed = allResults.filter(r => !r.passed).length;

  const siteCards = allResults.map(site => {
    const visualFails = site.visual.filter(v => v.status === 'fail').length;
    const linkFails = site.links.filter(l => (l.status === 0 || l.status >= 400) && l.type === 'page').length;
    const consoleFails = site.console.filter(c => c.errors.length > 0).length;
    const journeyFails = site.journeys.filter(j => !j.passed).length;

    const statusColor = site.passed ? '#1D9E75' : '#E24B4A';
    const statusLabel = site.passed ? 'PASSED' : 'FAILED';

    const visualRows = site.visual.map(v => {
      const color = v.status === 'pass' ? '#1D9E75' : v.status === 'fail' ? '#E24B4A' : '#BA7517';
      return `<tr>
        <td><a href="${site.url + v.page}" target="_blank" style="color:inherit">${v.page}</a></td>
        <td style="color:${color};font-weight:500">${v.status.toUpperCase()}</td>
        <td>${v.diffPercent !== null ? v.diffPercent + '%' : '—'}</td>
      </tr>`;
    }).join('');

    const linkRows = site.links
      .filter(l => l.status === 0 || l.status >= 400)
      .map(l => `<tr>
        <td style="word-break:break-all"><a href="${l.url}" target="_blank" style="color:inherit">${l.url}</a></td>
        <td style="color:#E24B4A;font-weight:500">${l.status || 'ERR'}</td>
        <td style="color:#888;font-size:12px">${l.type === 'link' ? `<a href="${site.url + l.page}" target="_blank" style="color:inherit">${l.page}</a>` : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="3" style="color:#1D9E75">No broken links</td></tr>';

    const consoleRows = site.console.map(c => {
      if (c.errors.length === 0) return '';
      return `<tr><td><a href="${site.url + c.page}" target="_blank" style="color:inherit">${c.page}</a></td><td>${c.errors.map(e => `<div style="color:#E24B4A;font-size:12px">${e.type}: ${e.text}</div>`).join('')}</td></tr>`;
    }).filter(Boolean).join('') || '<tr><td colspan="2" style="color:#1D9E75">No console errors</td></tr>';

    const journeyRows = site.journeys.map(j => {
      const steps = j.steps.map(s => {
        const c = s.status === 'pass' ? '#1D9E75' : '#E24B4A';
        const screenshotHtml = s.screenshot && fs.existsSync(s.screenshot)
          ? `<div style="margin-top:6px"><img src="${s.screenshot}" style="max-width:100%;border:1px solid #ddd;border-radius:4px" alt="Failure screenshot"></div>`
          : '';
        return `<div style="font-size:12px;color:${c};margin:2px 0">
          ${s.status === 'pass' ? '✓' : '✗'} ${s.name}${s.error ? ': <em>' + s.error + '</em>' : ''}
          ${screenshotHtml}
        </div>`;
      }).join('');
      return `<div style="margin-bottom:12px">
        <strong>${j.name}</strong> — <span style="color:${j.passed ? '#1D9E75' : '#E24B4A'}">${j.passed ? 'Passed' : 'Failed'}</span>
        <div style="margin-top:6px">${steps}</div>
      </div>`;
    }).join('') || '<div style="color:#888">No journeys configured</div>';

    return `
      <div style="border:1px solid #e0e0e0;border-radius:8px;margin-bottom:24px;overflow:hidden">
        <div style="background:${site.passed ? '#E1F5EE' : '#FCEBEB'};padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:18px;font-weight:600">${site.site}</div>
            <div style="font-size:13px;color:#666;margin-top:2px"><a href="${site.url}" target="_blank" style="color:inherit">${site.url}</a></div>
          </div>
          <div style="color:${statusColor};font-weight:700;font-size:16px">${statusLabel}</div>
        </div>
        <div style="padding:20px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
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
<title>WP Pre-launch Report — ${new Date().toLocaleDateString()}</title>
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
  <div class="meta">Run at ${new Date().toLocaleString()}</div>
</div>
<div class="summary">
  <div class="stat"><div class="num">${allResults.length}</div><div class="lbl">Sites tested</div></div>
  <div class="stat"><div class="num" style="color:#1D9E75">${totalPassed}</div><div class="lbl">Passed</div></div>
  <div class="stat"><div class="num" style="color:#E24B4A">${totalFailed}</div><div class="lbl">Failed</div></div>
</div>
<div class="sites">${siteCards}</div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  return reportPath;
}

module.exports = { generateReport };
