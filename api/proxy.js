const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30;  // per IP per window
const requestLog = new Map(); // ip -> [timestamps]

const ALLOWED_PATHS = new Set([
  '/v1/cryptocurrency/listings/latest',
  '/v1/global-metrics/quotes/latest',
  '/v1/cryptocurrency/categories',
  '/v2/cryptocurrency/info',
]);

const ALLOWED_ORIGINS = new Set([
  'https://narrapulse.vercel.app',
  'http://localhost:3000'
]);

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;


  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
    return;
  }

  const cmcPath = req.url.replace('/api/proxy', '').split('?')[0];
  if (!ALLOWED_PATHS.has(cmcPath)) {
    res.status(403).json({ error: 'Endpoint not allowed' });
    return;
  }

  const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
  const url = `https://pro-api.coinmarketcap.com${cmcPath}${queryString ? `?${queryString}` : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY,
        Accept: 'application/json',
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}