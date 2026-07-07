const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function getScreenshotDir(siteKey, mode) {
  const dir = path.join(__dirname, '..', 'data', 'sites', siteKey, mode === 'baseline' ? 'baselines' : 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(url) {
  return url.replace(/^\//, '').replace(/\//g, '-') || 'home';
}

async function captureScreenshots(context, site, mode) {
  const dir = getScreenshotDir(site.key, mode);
  const captured = [];

  for (const pagePath of site.pages) {
    const url = site.url + pagePath;
    const slug = slugify(pagePath);
    const filePath = path.join(dir, `${slug}.png`);

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 15000 });

      // Scroll to trigger lazy images and Elementor entrance animations
      await page.evaluate(async () => {
        const viewportHeight = window.innerHeight;
        const scrollHeight = document.body.scrollHeight;
        for (let pos = viewportHeight; pos < scrollHeight; pos += viewportHeight) {
          window.scrollTo(0, pos);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, scrollHeight);
      });
      await page.waitForTimeout(800);

      // Freeze all animations and transitions, and hide the WordPress admin bar
      // (present on logged-in maintenance-mode runs) so it never pollutes a
      // screenshot or visual baseline. The margin-top reset undoes the offset
      // the admin bar pushes onto <html>.
      await page.addStyleTag({
        content: [
          '*, *::before, *::after { animation: none !important; transition: none !important; }',
          '#wpadminbar { display: none !important; }',
          'html { margin-top: 0 !important; }'
        ].join('\n')
      });

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      await page.screenshot({ path: filePath, fullPage: true });
      captured.push({ pagePath, slug, filePath });
    } catch (err) {
      console.error(`    Could not capture ${url}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  return captured;
}

async function compareScreenshots(site, newShots, threshold = 0.02) {
  const baselineDir = getScreenshotDir(site.key, 'baseline');
  const diffDir = path.join(__dirname, '..', 'data', 'sites', site.key, 'diffs');
  fs.mkdirSync(diffDir, { recursive: true });

  const results = [];

  for (const shot of newShots) {
    const baselinePath = path.join(baselineDir, `${shot.slug}.png`);
    const diffPath = path.join(diffDir, `${shot.slug}-diff.png`);

    if (!fs.existsSync(baselinePath)) {
      results.push({
        page: shot.pagePath,
        slug: shot.slug,
        status: 'no-baseline',
        message: 'No baseline screenshot found — run baseline first',
        diffPercent: null,
        diffPath: null,
        newPath: shot.filePath
      });
      continue;
    }

    try {
      const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
      const current = PNG.sync.read(fs.readFileSync(shot.filePath));

      const width = Math.max(baseline.width, current.width);
      const height = Math.max(baseline.height, current.height);

      const baselineData = resizePNG(baseline, width, height);
      const currentData = resizePNG(current, width, height);
      const diff = new PNG({ width, height });

      const numDiffPixels = pixelmatch(baselineData, currentData, diff.data, width, height, { threshold: 0.1 });
      const diffPercent = numDiffPixels / (width * height);
      fs.writeFileSync(diffPath, PNG.sync.write(diff));

      results.push({
        page: shot.pagePath,
        slug: shot.slug,
        status: diffPercent > threshold ? 'fail' : 'pass',
        diffPercent: Math.round(diffPercent * 10000) / 100,
        diffPixels: numDiffPixels,
        diffPath,
        baselinePath,
        newPath: shot.filePath
      });
    } catch (err) {
      results.push({
        page: shot.pagePath,
        slug: shot.slug,
        status: 'error',
        message: err.message,
        diffPercent: null,
        diffPath: null,
        newPath: shot.filePath
      });
    }
  }

  return results;
}

function resizePNG(png, targetWidth, targetHeight) {
  if (png.width === targetWidth && png.height === targetHeight) return png.data;
  const data = Buffer.alloc(targetWidth * targetHeight * 4, 255);
  for (let y = 0; y < Math.min(png.height, targetHeight); y++) {
    for (let x = 0; x < Math.min(png.width, targetWidth); x++) {
      const srcIdx = (y * png.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      data[dstIdx] = png.data[srcIdx];
      data[dstIdx + 1] = png.data[srcIdx + 1];
      data[dstIdx + 2] = png.data[srcIdx + 2];
      data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return data;
}

module.exports = { captureScreenshots, compareScreenshots };
