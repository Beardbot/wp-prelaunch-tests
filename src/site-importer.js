const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const chalk = require('chalk');
const { XMLParser } = require('fast-xml-parser');

const configPath = process.env.SITES_CONFIG || path.join(__dirname, '..', 'config', 'sites.json');
const parser = new XMLParser({ ignoreAttributes: false });
const TARGET_SITEMAPS = new Set([
  'page-sitemap.xml',
  'product-sitemap.xml',
  'product_cat-sitemap.xml',
  'post-sitemap.xml'
]);

function normalizeUrl(input) {
  let value = input.trim().replace(/\/+$/, '');
  value = value.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  return value.replace(/\/+$/, '');
}

function siteKeyFromHostname(hostname) {
  return hostname.replace(/^www\./i, '');
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error('sites.json not found. Copy config/sites.example.json to config/sites.json or set SITES_CONFIG.');
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function requestUrl(targetUrl, { method = 'GET', timeout = 15000, redirects = 3 } = {}) {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      resolve(null);
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request(parsed, {
      method,
      timeout,
      headers: {
        'User-Agent': 'WP Regression Tester site importer'
      }
    }, res => {
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && redirects > 0) {
        res.resume();
        const nextUrl = new URL(location, targetUrl).toString();
        resolve(requestUrl(nextUrl, { method, timeout, redirects: redirects - 1 }));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: targetUrl
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function fetchOk(targetUrl) {
  const response = await requestUrl(targetUrl);
  if (!response || response.status < 200 || response.status >= 400 || !response.body) {
    return null;
  }
  return response;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXml(xml) {
  try {
    return parser.parse(xml);
  } catch (err) {
    return null;
  }
}

function extractLocs(parsed, type) {
  const container = parsed && parsed[type];
  if (!container) return [];
  const entries = asArray(type === 'sitemapindex' ? container.sitemap : container.url);
  return entries.map(entry => entry && entry.loc).filter(Boolean);
}

function sitemapFilename(sitemapUrl) {
  try {
    return path.posix.basename(new URL(sitemapUrl).pathname);
  } catch (err) {
    return '';
  }
}

async function findSitemap(baseUrl) {
  const robots = await fetchOk(`${baseUrl}/robots.txt`);
  if (robots) {
    const match = robots.body.match(/^sitemap:\s*(.+)$/im);
    if (match) {
      const sitemapUrl = new URL(match[1].trim(), baseUrl).toString();
      const response = await fetchOk(sitemapUrl);
      if (response) return response;
    }
  }

  for (const sitemapPath of ['/sitemap_index.xml', '/sitemap.xml']) {
    const response = await fetchOk(`${baseUrl}${sitemapPath}`);
    if (response) return response;
  }

  return null;
}

function toRelativePath(candidateUrl, base) {
  try {
    const parsed = new URL(candidateUrl, base.origin);
    if (parsed.origin !== base.origin) return null;
    return parsed.pathname || '/';
  } catch (err) {
    return null;
  }
}

function uniqueSorted(paths) {
  return [...new Set(paths.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function pathDepth(relativePath) {
  return relativePath.split('/').filter(Boolean).length;
}

function selectShopPath(urls, baseUrl) {
  const candidates = ['/shop/', '/products/', '/store/'];
  const paths = urls.map(url => toRelativePath(url, baseUrl)).filter(Boolean);
  return candidates.find(candidate => paths.some(pagePath => pagePath.includes(candidate))) || '/shop/';
}

async function detectWooCommerce(baseUrl, foundSitemaps) {
  if (foundSitemaps.has('product-sitemap.xml') || foundSitemaps.has('product_cat-sitemap.xml')) {
    return true;
  }

  const response = await requestUrl(`${baseUrl}/wp-json/wc/v3/`, { method: 'HEAD' });
  return !!response && [200, 401].includes(response.status);
}

function extractTitle(html, fallbackHost) {
  const og = html.match(/<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["'][^>]*>/i);
  if (og) return og[1].trim();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? title[1].replace(/\s+/g, ' ').trim() : fallbackHost;
}

function extractNavLinks(html, baseUrl) {
  const sections = html.match(/<(nav|header)\b[\s\S]*?<\/\1>/gi) || [];
  const links = [];

  for (const section of sections) {
    const hrefs = section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi);
    for (const match of hrefs) {
      const relativePath = toRelativePath(match[1], baseUrl);
      if (relativePath) links.push(relativePath);
    }
  }

  return uniqueSorted(['/', ...links]);
}

function detectWooCommerceFromHtml(html) {
  const bodyClass = html.match(/<body\b[^>]*class=["']([^"']*)["'][^>]*>/i);
  return (bodyClass && bodyClass[1].toLowerCase().includes('woocommerce'))
    || html.toLowerCase().includes('wc-block');
}

function selectPagesFromSitemaps(sitemaps, baseUrl, isWooCommerce) {
  const pages = ['/'];

  if (sitemaps.flat.length > 0) {
    const flatPaths = sitemaps.flat.map(url => toRelativePath(url, baseUrl)).filter(Boolean);
    pages.push(...flatPaths.filter(relativePath => pathDepth(relativePath) <= 2));

    if (isWooCommerce) {
      pages.push(...flatPaths.filter(relativePath => relativePath.startsWith('/product/')).slice(0, 5));
      pages.push(...flatPaths.filter(relativePath => relativePath.startsWith('/product-category/')));
    }

    return uniqueSorted(pages).slice(0, 25);
  }

  pages.push(...sitemaps.page.map(url => toRelativePath(url, baseUrl)));

  if (isWooCommerce) {
    pages.push(...sitemaps.product_cat.map(url => toRelativePath(url, baseUrl)));
    pages.push(...sitemaps.product.map(url => toRelativePath(url, baseUrl)).slice(0, 3));
    pages.push('/cart/', '/checkout/', '/my-account/');
  } else {
    pages.push(...sitemaps.post.map(url => toRelativePath(url, baseUrl)).slice(0, 3));
  }

  return uniqueSorted(pages);
}

async function loadSitemapData(baseUrl) {
  const sitemaps = {
    page: [],
    product: [],
    product_cat: [],
    post: [],
    flat: []
  };
  const foundSitemaps = new Set();
  const response = await findSitemap(baseUrl);
  if (!response) return { sitemaps, foundSitemaps, hasSitemap: false };

  const parsed = parseXml(response.body);
  if (!parsed) return { sitemaps, foundSitemaps, hasSitemap: false };

  if (parsed.sitemapindex) {
    const childSitemaps = extractLocs(parsed, 'sitemapindex');
    for (const childUrl of childSitemaps) {
      const filename = sitemapFilename(childUrl);
      if (!TARGET_SITEMAPS.has(filename)) continue;

      const child = await fetchOk(childUrl);
      if (!child) continue;

      const childParsed = parseXml(child.body);
      if (!childParsed || !childParsed.urlset) continue;

      foundSitemaps.add(filename);
      const key = filename.replace('-sitemap.xml', '').replace('-', '_');
      sitemaps[key] = extractLocs(childParsed, 'urlset');
    }
    return { sitemaps, foundSitemaps, hasSitemap: true };
  }

  if (parsed.urlset) {
    sitemaps.flat = extractLocs(parsed, 'urlset');
    return { sitemaps, foundSitemaps, hasSitemap: true };
  }

  return { sitemaps, foundSitemaps, hasSitemap: false };
}

function buildSiteConfig({ name, baseUrl, pages, isWooCommerce, shopPath }) {
  const site = {
    name,
    key: siteKeyFromHostname(baseUrl.hostname),
    url: baseUrl.toString().replace(/\/+$/, ''),
    pages,
    journeys: isWooCommerce ? ['woocommerce'] : [],
    auth: null
  };

  if (isWooCommerce && shopPath !== '/shop/') {
    site.journeyOptions = {
      woocommerce: { shopPath }
    };
  }

  return site;
}

function printPreview(site) {
  console.log(chalk.bold('\nSite preview'));
  console.log(`${chalk.blue('Name:')} ${site.name}`);
  console.log(`${chalk.blue('Key:')} ${site.key}`);
  console.log(`${chalk.blue('URL:')} ${site.url}`);
  console.log(`${chalk.blue('Pages:')} ${site.pages.length}`);
  console.log(`${chalk.blue('Journey:')} ${site.journeys.length ? site.journeys.join(', ') : 'none'}`);
  console.log(chalk.bold('\nPages'));
  site.pages.forEach(page => console.log(`  ${page}`));
}

function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(!answer.trim() || answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function importSite(url, { dryRun = false } = {}) {
  const normalizedUrl = normalizeUrl(url);
  const baseUrl = new URL(normalizedUrl);
  const config = readConfig();
  const duplicate = (config.sites || []).find(site => normalizeUrl(site.url) === normalizedUrl);

  if (duplicate) {
    console.log(chalk.yellow(`Warning: ${normalizedUrl} already exists as "${duplicate.name}".`));
    return null;
  }

  console.log(chalk.blue(`Inspecting ${normalizedUrl}...`));
  const { sitemaps, foundSitemaps, hasSitemap } = await loadSitemapData(normalizedUrl);
  let homepage = await fetchOk(normalizedUrl);
  let homepageHtml = homepage ? homepage.body : '';
  let isWooCommerce = await detectWooCommerce(normalizedUrl, foundSitemaps);
  let pages;
  let shopPath = '/shop/';

  if (hasSitemap) {
    shopPath = isWooCommerce
      ? selectShopPath([...sitemaps.page, ...sitemaps.product_cat], baseUrl)
      : '/shop/';
    pages = selectPagesFromSitemaps(sitemaps, baseUrl, isWooCommerce);
  } else {
    if (!homepage) {
      homepage = await fetchOk(`${normalizedUrl}/`);
      homepageHtml = homepage ? homepage.body : '';
    }
    isWooCommerce = isWooCommerce || detectWooCommerceFromHtml(homepageHtml);
    pages = extractNavLinks(homepageHtml, baseUrl);
    if (isWooCommerce) {
      pages = uniqueSorted([...pages, '/cart/', '/checkout/', '/my-account/']);
    }
  }

  const name = extractTitle(homepageHtml, siteKeyFromHostname(baseUrl.hostname));
  const site = buildSiteConfig({ name, baseUrl, pages, isWooCommerce, shopPath });
  printPreview(site);

  if (dryRun) {
    console.log(chalk.bold('\nDry run JSON'));
    console.log(JSON.stringify(site, null, 2));
    return site;
  }

  const shouldWrite = await confirm(chalk.yellow('\nAdd to sites.json? [Y/n] '));
  if (!shouldWrite) {
    console.log(chalk.yellow('Skipped. No changes made.'));
    return site;
  }

  const writableConfig = readConfig();
  writableConfig.sites = writableConfig.sites || [];
  writableConfig.sites.push(site);
  writableConfig.sites.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  fs.writeFileSync(configPath, `${JSON.stringify(writableConfig, null, 2)}\n`);

  console.log(chalk.green(`\nAdded ${site.name} to ${configPath}`));
  return site;
}

module.exports = { importSite };
