// Per-site environment credential lookup — the one idiom, extracted.
//
// Credentials never live in sites.json; they come from .env named by
// convention: a per-site override first (`NAME_<KEY>`), then a global
// fallback (`NAME`). The site-key suffix mangles every non-alphanumeric
// character to '_' and uppercases, so `test.beardbot.dev` reads
// `NAME_TEST_BEARDBOT_DEV`. This module replaces the previously duplicated
// copies of that logic in src/wp-login.js and journeys/templates/login.js.

function envKeySuffix(siteKey) {
  return siteKey.replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

// Resolve one named credential for a site. Returns the resolved value (or
// undefined), plus the names involved so callers can build actionable error
// messages naming the exact env vars to set.
function envForSite(siteKey, name) {
  const suffix = envKeySuffix(siteKey);
  const perSiteName = `${name}_${suffix}`;
  return {
    value: process.env[perSiteName] || process.env[name],
    suffix,
    perSiteName,
    globalName: name
  };
}

module.exports = { envKeySuffix, envForSite };
