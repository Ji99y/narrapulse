import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
dotenv.config();

const PORT = 3000;
const API_KEY = process.env.CMC_API_KEY;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve index.html at root
  if (req.url === '/' || req.url === '/index.html') {
    import('fs').then(fs => {
      const html = fs.readFileSync('./index.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }

  // Proxy /api/* → CMC
  if (req.url.startsWith('/api/')) {
    const cmcPath = req.url.replace('/api/', '/');
    const options = {
      hostname: 'pro-api.coinmarketcap.com',
      path: cmcPath,
      headers: { 'X-CMC_PRO_API_KEY': API_KEY, 'Accept': 'application/json' }
    };

    https.get(options, (cmcRes) => {
      res.writeHead(cmcRes.statusCode, { 'Content-Type': 'application/json' });
      cmcRes.pipe(res);
    }).on('error', e => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\n✓ Server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});