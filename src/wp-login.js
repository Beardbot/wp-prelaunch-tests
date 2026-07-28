// WordPress login bootstrap for maintenance-mode staging sites.
//
// Many staging sites sit behind an Elementor maintenance page that only
// logged-in WordPress users can see past. When a site enables this in config
// (`"auth": { "type": "wp-login" }`), we authenticate once through
// wp-login.php at the start of the site's run. The session cookies live on the
// browser context, so every check that follows (screenshots, links, console,
// journeys) runs as a logged-in visitor without logging in again.
//
// Credentials come from the environment, never sites.json — per-site override
// first, then a global fallback (src/env-credentials.js).

const { envForSite } = require('./env-credentials');

// wp-login.php field IDs are WordPress core defaults and stable across versions.
const USERNAME_SELECTOR = '#user_login';
const PASSWORD_SELECTOR = '#user_pass';
const SUBMIT_SELECTOR = '#wp-submit';

function credentialsFor(site) {
  const { value: username, suffix: siteKeyUpper } = envForSite(site.key, 'WP_LOGIN_USER');
  const { value: password } = envForSite(site.key, 'WP_LOGIN_PASSWORD');
  return { username, password, siteKeyUpper };
}

// Authenticate the context so its cookies carry a logged-in WordPress session.
// Throws on failure so the caller can mark the site's run as failed rather than
// silently proceeding as anonymous (which would only ever see the maintenance page).
async function authenticateWpLogin(context, site) {
  const auth = site.auth || {};
  const loginPath = auth.loginPath || '/wp-login.php';
  const { username, password, siteKeyUpper } = credentialsFor(site);

  if (!username || !password) {
    throw new Error(
      `wp-login is enabled for "${site.key}" but credentials are not set — ` +
      `set WP_LOGIN_USER_${siteKeyUpper}/WP_LOGIN_PASSWORD_${siteKeyUpper} ` +
      `or the global WP_LOGIN_USER/WP_LOGIN_PASSWORD in .env`
    );
  }

  const page = await context.newPage();
  try {
    const response = await page.goto(site.url + loginPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response || response.status() >= 400) {
      throw new Error(`wp-login page ${loginPath} returned status ${response?.status()}`);
    }

    // Visiting wp-login.php sets the test cookie WordPress requires before it
    // will accept a login POST, so filling and submitting here is enough.
    await page.fill(USERNAME_SELECTOR, username);
    await page.fill(PASSWORD_SELECTOR, password);
    await page.click(SUBMIT_SELECTOR);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // wp-login.php re-renders with #login_error on bad credentials; grab its
    // text for a useful message before falling back to the cookie check.
    const errorLocator = page.locator('#login_error');
    if (await errorLocator.isVisible().catch(() => false)) {
      const message = ((await errorLocator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      throw new Error(`wp-login rejected credentials for "${site.key}": ${message || 'login error shown'}`);
    }

    // The authoritative signal: a successful login sets a wordpress_logged_in_*
    // cookie on the context. If it is absent the session was not established.
    const cookies = await context.cookies();
    if (!cookies.some(cookie => cookie.name.startsWith('wordpress_logged_in'))) {
      throw new Error(`wp-login for "${site.key}" did not establish a session (no wordpress_logged_in cookie)`);
    }
  } finally {
    await page.close();
  }
}

function isWpLoginEnabled(site) {
  return !!(site.auth && site.auth.type === 'wp-login');
}

module.exports = { authenticateWpLogin, isWpLoginEnabled };
