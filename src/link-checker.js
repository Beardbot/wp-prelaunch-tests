async function checkLinks(site, context) {
  const results = [];
  const checked = new Set();

  for (const pagePath of site.pages) {
    const url = site.url + pagePath;
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = response ? response.status() : 0;

      results.push({ page: pagePath, url, status, type: 'page' });

      const links = await page.evaluate((baseUrl) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(href =>
            href.startsWith(baseUrl) &&
            !href.includes('#') &&
            !href.match(/\.(pdf|zip|jpg|jpeg|png|gif|mp4|mp3)$/i)
          );
      }, site.url);

      for (const link of links) {
        if (checked.has(link)) continue;
        checked.add(link);

        try {
          const linkResponse = await page.goto(link, { waitUntil: 'commit', timeout: 15000 });
          results.push({
            page: pagePath,
            url: link,
            status: linkResponse ? linkResponse.status() : 0,
            type: 'link'
          });
        } catch (err) {
          results.push({ page: pagePath, url: link, status: 0, type: 'link', error: err.message });
        }
      }
    } catch (err) {
      results.push({ page: pagePath, url, status: 0, type: 'page', error: err.message });
    } finally {
      await page.close();
    }
  }

  return results;
}

module.exports = { checkLinks };
