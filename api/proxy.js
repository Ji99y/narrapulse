import https from 'https';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const cmcPath = req.url.replace('/api/proxy', '');
  const options = {
    hostname: 'pro-api.coinmarketcap.com',
    path: cmcPath,
    headers: {
      'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY,
      'Accept': 'application/json'
    }
  };

  https.get(options, (cmcRes) => {
    res.status(cmcRes.statusCode);
    res.setHeader('Content-Type', 'application/json');
    cmcRes.pipe(res);
  }).on('error', e => {
    res.status(500).json({ error: e.message });
  });
}