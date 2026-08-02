// api/signals.js
// Reads signal history from GitHub repo and returns last 30 days
// Also handles POST to update signal outcomes

const GITHUB_API  = 'https://api.github.com';
const REPO        = process.env.GITHUB_REPO;   // Ji99y/narrapulse
const TOKEN       = process.env.GITHUB_TOKEN;
const FILE_PATH   = 'signals.json';

const ghHeaders = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept':        'application/vnd.github.v3+json',
  'Content-Type':  'application/json',
};

// ─── Read signals.json from GitHub ───────────────────────────────────────────

async function readSignalsFile() {
  const url = `${GITHUB_API}/repos/${REPO}/contents/${FILE_PATH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) return { signals: [], sha: null };
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { ...content, sha: data.sha };
}

// ─── Write signals.json back to GitHub ───────────────────────────────────────

async function writeSignalsFile(content, sha) {
  const url  = `${GITHUB_API}/repos/${REPO}/contents/${FILE_PATH}`;
  const body = {
    message:  `Update signal history [${new Date().toISOString()}]`,
    content:  Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha,
  };
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
  return res.ok;
}

// ─── Check if open signals hit target or stop ────────────────────────────────

async function resolveOpenSignals(signals) {
  const openSignals = signals.filter(s => s.outcome === null);
  if (!openSignals.length) return signals;

  // Fetch current prices from CMC
  const CMC_KEY = process.env.CMC_API_KEY;
  const symbols = [...new Set(openSignals.map(s => s.symbol))].join(',');
  const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbols}&convert=USD`;

  try {
    const res  = await fetch(url, {
      headers: { 'X-CMC_PRO_API_KEY': CMC_KEY, 'Accept': 'application/json' }
    });
    const data = await res.json();
    const now  = new Date().toISOString();

    return signals.map(s => {
      if (s.outcome !== null) return s;

      const tokenData = data.data?.[s.symbol]?.[0];
      if (!tokenData) return s;

      const price = tokenData.quote.USD.price;

      // Check target hit
      if (price >= s.target) {
        return { ...s, outcome: 'TARGET_HIT', exitPrice: s.target, closedAt: now,
                 returnPct: 20.0 };
      }
      // Check stop hit
      if (price <= s.stop) {
        return { ...s, outcome: 'STOPPED_OUT', exitPrice: s.stop, closedAt: now,
                 returnPct: -7.0 };
      }
      // Check expired (30 days)
      const openedAt = new Date(s.openedAt);
      const daysSince = (Date.now() - openedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) {
        const returnPct = ((price - s.entry) / s.entry) * 100;
        return { ...s, outcome: 'EXPIRED', exitPrice: price, closedAt: now,
                 returnPct: parseFloat(returnPct.toFixed(2)) };
      }

      return s;
    });
  } catch {
    return signals;
  }
}

// ─── Filter to last 30 days ───────────────────────────────────────────────────

function filterLast30Days(signals) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return signals.filter(s => new Date(s.openedAt).getTime() > cutoff);
}

// ─── Compute P&L summary ─────────────────────────────────────────────────────

function computeSummary(signals) {
  const closed  = signals.filter(s => s.outcome !== null);
  const open    = signals.filter(s => s.outcome === null);
  const winners = closed.filter(s => (s.returnPct || 0) > 0);
  const avgRet  = closed.length
    ? closed.reduce((sum, s) => sum + (s.returnPct || 0), 0) / closed.length
    : 0;
  const winRate = closed.length ? (winners.length / closed.length) * 100 : 0;

  return {
    total:      signals.length,
    open:       open.length,
    closed:     closed.length,
    winRate:    parseFloat(winRate.toFixed(1)),
    avgReturn:  parseFloat(avgRet.toFixed(2)),
    targetHit:  closed.filter(s => s.outcome === 'TARGET_HIT').length,
    stoppedOut: closed.filter(s => s.outcome === 'STOPPED_OUT').length,
    expired:    closed.filter(s => s.outcome === 'EXPIRED').length,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const { signals, sha, lastUpdated } = await readSignalsFile();
    const last30 = filterLast30Days(signals);

    if (req.method === 'GET') {
      // Resolve open signals against current prices
      const resolved = await resolveOpenSignals(last30);
      const summary  = computeSummary(resolved);

      // If any signals got resolved, write back
      const anyResolved = resolved.some((s, i) => s.outcome !== last30[i]?.outcome);
      if (anyResolved && sha) {
        // Update in full signals array
        const updatedAll = signals.map(s => {
          const r = resolved.find(r => r.id === s.id);
          return r || s;
        });
        await writeSignalsFile({ signals: updatedAll, lastUpdated: new Date().toISOString() }, sha);
      }

      res.status(200).json({ signals: resolved, summary, lastUpdated });
      return;
    }

    if (req.method === 'POST') {
      // Bot posts new signals or updates
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (body.action === 'open') {
        // Add new signal
        const newSignal = {
          id:           `${body.symbol}-${Date.now()}`,
          symbol:       body.symbol,
          narrativeAge: body.narrativeAge,
          narrative:    body.narrative || 'Other',
          entry:        body.entry,
          stop:         body.stop,
          target:       body.target,
          score:        body.score,
          regime:       body.regime,
          sentiment:    body.sentiment,
          openedAt:     new Date().toISOString(),
          closedAt:     null,
          outcome:      null,
          exitPrice:    null,
          returnPct:    null,
        };
        signals.push(newSignal);
        await writeSignalsFile({ signals, lastUpdated: new Date().toISOString() }, sha);
        res.status(200).json({ ok: true, signal: newSignal });
        return;
      }

      if (body.action === 'close') {
        // Mark signal as closed
        const idx = signals.findIndex(s => s.id === body.id);
        if (idx !== -1) {
          signals[idx] = { ...signals[idx], ...body.update, closedAt: new Date().toISOString() };
          await writeSignalsFile({ signals, lastUpdated: new Date().toISOString() }, sha);
        }
        res.status(200).json({ ok: true });
        return;
      }
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('signals API error:', e.message);
    res.status(500).json({ error: e.message });
  }
}