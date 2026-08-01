'use strict';

/**
 * Anti-scrape / anti-AI-crawler middleware for autom8-support.
 * Authenticated and internal-secret requests bypass UA blocks (API clients).
 */

const BLOCKED_UA = [
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-web',
  'anthropic-ai',
  'ccbot',
  'google-extended',
  'bytespider',
  'amazonbot',
  'applebot-extended',
  'cohere-ai',
  'diffbot',
  'imagesiftbot',
  'omgilibot',
  'perplexitybot',
  'youbot',
  'facebookbot',
  'meta-externalagent',
  'scrapy',
  'python-requests',
  'python-urllib',
  'aiohttp',
  'httpx',
  'libwww-perl',
  'go-http-client',
  'phantomjs',
  'httrack',
  'sitesucker',
  'dataforseo',
  'semrush',
  'ahrefs',
  'mj12bot',
  'dotbot',
  'petalbot',
  'ia_archiver',
];

function isBlockedUa(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return false;
  return BLOCKED_UA.some((frag) => s.includes(frag));
}

function antiScrape(req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.path === '/health' || req.path === '/robots.txt') {
    return next();
  }

  // Dashboard JWT / service secret — do not UA-block API clients
  if (req.headers.authorization || req.headers['x-internal-secret']) {
    return next();
  }

  if (isBlockedUa(req.headers['user-agent'])) {
    return res.status(403).type('text').send('Forbidden');
  }

  return next();
}

module.exports = { antiScrape, isBlockedUa, BLOCKED_UA };
