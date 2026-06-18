const ALLOWED_ORIGINS = new Set([
  'https://narrapulse.vercel.app',
  'http://localhost:3000',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';

  // Allow Vercel preview deployments
  const isVercelPreview = /^https:\/\/narrapulse-.*\.vercel\.app$/.test(origin);
  const allowed = ALLOWED_ORIGINS.has(origin) || isVercelPreview;

  if (!allowed) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const cmcPath = req.url.replace('/api/proxy', '');
  const url = `https://pro-api.coinmarketcap.com${cmcPath}`;

  try {
    const response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY,
        'Accept': 'application/json'
      }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}