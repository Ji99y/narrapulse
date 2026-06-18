import dotenv from 'dotenv';
import fetch from 'node-fetch';
dotenv.config();

const API_KEY = process.env.CMC_API_KEY;
const BASE    = 'https://pro-api.coinmarketcap.com';
const headers = { 'X-CMC_PRO_API_KEY': API_KEY, 'Accept': 'application/json' };

// ─── API CALLS ───────────────────────────────────────────────────────────────

async function getMomentumTokens() {
  const url = `${BASE}/v1/cryptocurrency/listings/latest?limit=200&convert=USD&sort=market_cap`;
  const res  = await fetch(url, { headers });
  const data = await res.json();
  return data.data || [];
}

async function getMarketMetrics() {
  const url  = `${BASE}/v1/global-metrics/quotes/latest?convert=USD`;
  const res  = await fetch(url, { headers });
  const data = await res.json();
  return data.data;
}

async function getTokenCategories(ids) {
  const url  = `${BASE}/v2/cryptocurrency/info?id=${ids.join(',')}&aux=tags`;
  const res  = await fetch(url, { headers });
  const data = await res.json();
  return data.data || {};
}

// ─── REGIME ──────────────────────────────────────────────────────────────────

function detectRegime(metrics) {
  const btcDom  = metrics.btc_dominance;
  const vol     = metrics.quote.USD.total_volume_24h;
  const mcap    = metrics.quote.USD.total_market_cap;
  const volMcap = vol / mcap;

  if (btcDom > 58) return { regime: 'BTC_DOMINANCE', risk: 'LOW',  note: 'Altcoins suppressed — be very selective, stick to top 50' };
  if (btcDom < 50) return { regime: 'ALTSEASON',     risk: 'HIGH', note: 'Broad altcoin momentum — wider opportunities, tighten stops' };
  if (volMcap > 0.05) return { regime: 'ACTIVE',     risk: 'MED',  note: 'Healthy volume — standard position sizing' };
  return               { regime: 'QUIET',            risk: 'LOW',  note: 'Low volume — reduce position sizes, wait for confirmation' };
}

// ─── SENTIMENT COMPOSITE ─────────────────────────────────────────────────────

function computeSentiment(metrics, tokens) {
  const qualified   = tokens.filter(t => (t.quote.USD.market_cap||0) > 50000000 && (t.quote.USD.volume_24h||0) > 5000000);
  const positive24h = qualified.filter(t => (t.quote.USD.percent_change_24h||0) > 0);
  const breadth     = qualified.length ? (positive24h.length / qualified.length) * 100 : 50;
  const btcDom      = metrics.btc_dominance || 50;
  const btcScore    = Math.max(0, Math.min(100, (65 - btcDom) * 3.33 + 50));
  const vol         = metrics.quote.USD.total_volume_24h;
  const mcap        = metrics.quote.USD.total_market_cap;
  const volScore    = Math.min(100, (vol / mcap) * 1000);
  const score       = Math.round((breadth * 0.5) + (btcScore * 0.3) + (volScore * 0.2));

  let gate, label, emoji;
  if (score <= 20)      { gate='EXTREME_FEAR';  emoji='🔴'; label=`EXTREME FEAR (${score}/100)`;  }
  else if (score <= 40) { gate='FEAR';          emoji='🟠'; label=`FEAR (${score}/100)`;          }
  else if (score <= 60) { gate='NEUTRAL';       emoji='⚪'; label=`NEUTRAL (${score}/100)`;       }
  else if (score <= 80) { gate='GREED';         emoji='🟡'; label=`GREED (${score}/100)`;         }
  else                  { gate='EXTREME_GREED'; emoji='🔴'; label=`EXTREME GREED (${score}/100)`; }

  const gated = gate === 'EXTREME_FEAR' || gate === 'EXTREME_GREED';
  return { score, gate, label: `${emoji} ${label}`, gated };
}

// ─── VOLUME TREND ────────────────────────────────────────────────────────────

function getVolumeTrend(q) {
  const vc = q.volume_change_24h || 0;
  if (vc > 20)  return { trend: 'SURGING',    multiplier: 1.0 };
  if (vc > 0)   return { trend: 'RISING',     multiplier: 1.0 };
  if (vc > -20) return { trend: 'FADING',     multiplier: 0.5 };
  return              { trend: 'COLLAPSING',  multiplier: 0.0 };
}

// ─── DIVERGENCE ──────────────────────────────────────────────────────────────

function getDivergenceSignal(q) {
  const priceUp = q.percent_change_24h > 0;
  const vt      = getVolumeTrend(q);

  if (!priceUp)                                          return { signal: 'NO_SIGNAL', label: '—' };
  if (vt.trend === 'SURGING' || vt.trend === 'RISING')  return { signal: 'CONFIRMED', label: '✓ CONFIRMED' };
  if (vt.trend === 'FADING')                            return { signal: 'WEAK',      label: '⚠ WEAK' };
  return                                                       { signal: 'DIVERGING',  label: '✗ DIVERGING' };
}

// ─── NARRATIVE AGE ───────────────────────────────────────────────────────────

function detectNarrativeAge(q) {
  const c7  = q.percent_change_7d  || 0;
  const c30 = q.percent_change_30d || 0;
  const c24 = q.percent_change_24h || 0;
  const c1  = q.percent_change_1h  || 0;

  if (c7 > 10 && c30 < 20 && c1 > 0 && c24 > 3) return { age: 'EARLY', label: '🟢 EARLY', bonus: 3 };
  if (c7 > 10 && c30 > 20 && c24 > 0)   return { age: 'PRIME',    label: '🟡 PRIME',    bonus:  1 };
  if (c30 > 80 && c24 < 5 && c1 < 1)    return { age: 'EXHAUSTED',label: '🔴 EXHAUSTED',bonus: -3 };
  if (c30 > 40 && c7 < c30 / 4)         return { age: 'LATE',     label: '🟠 LATE',     bonus: -1 };
  return                                        { age: 'MID',      label: '⚪ MID',      bonus:  0 };
}

// ─── PUMP EXHAUSTION ─────────────────────────────────────────────────────────

function detectPumpExhaustion(q) {
  const c1      = q.percent_change_1h  || 0;
  const c24     = q.percent_change_24h || 0;
  const volChg  = q.volume_change_24h  || 0;

  if (c24 <= 20) return { exhausted: false, label: '—', exitWarning: false };

  const hourlyPace  = c1 * 24;
  const pumpSlowing = hourlyPace < c24 * 0.5;
  const volStillHigh = volChg > 30;

  if (pumpSlowing && volStillHigh)  return { exhausted: true, label: '⚠ EXIT SOON', exitWarning: true  };
  if (pumpSlowing && !volStillHigh) return { exhausted: true, label: '🚨 EXIT NOW',  exitWarning: true  };
  return                                   { exhausted: false, label: '✓ RUNNING',   exitWarning: false };
}

// ─── NARRATIVE CLASSIFY ──────────────────────────────────────────────────────

function classifyNarrative(tags = []) {
  const t = tags.map(x => (x.slug || x).toLowerCase());
  if (t.some(x => ['ai','artificial-intelligence','machine-learning','ai-agent'].includes(x)))       return 'AI';
  if (t.some(x => ['defi','decentralized-finance','dex','yield-farming','lending'].includes(x)))     return 'DeFi';
  if (t.some(x => ['meme','memes','dog-themed','cat-themed'].includes(x)))                           return 'Meme';
  if (t.some(x => ['layer-1','layer1','l1','smart-contracts','platform'].includes(x)))               return 'L1';
  if (t.some(x => ['layer-2','layer2','l2','scaling','rollup','optimistic-rollup'].includes(x)))     return 'L2';
  if (t.some(x => ['infrastructure','interoperability','oracle','bridge','storage'].includes(x)))    return 'Infra';
  if (t.some(x => ['gaming','metaverse','nft','play-to-earn','gamefi'].includes(x)))                 return 'Gaming';
  if (t.some(x => ['stablecoin','stable'].includes(x)))                                              return 'Stablecoin';
  if (t.some(x => ['exchange','cex','centralized-exchange'].includes(x)))                            return 'CeFi';
  return 'Other';
}

// ─── SCORE TOKEN ─────────────────────────────────────────────────────────────

function scoreToken(token) {
  const q    = token.quote.USD;
  const c1   = q.percent_change_1h  || 0;
  const c24  = q.percent_change_24h || 0;
  const c7   = q.percent_change_7d  || 0;
  const vol  = q.volume_24h  || 0;
  const mcap = q.market_cap  || 0;

  // Quality filters
  if (mcap < 30_000_000) return null;
  if (vol  <  5_000_000) return null;
  if (q.price <= 0)      return null;
  // Filter near-zero volatility tokens (stablecoins that slip through price filter)
  if (Math.abs(c24) < 0.1 && Math.abs(c7) < 0.5) return null;

  const vmr        = vol / mcap;
  const volTrend   = getVolumeTrend(q);
  const divergence = getDivergenceSignal(q);
  const narAge     = detectNarrativeAge(q);
  const pumpStatus = detectPumpExhaustion(q);
  const allPos     = c1 > 0 && c24 > 0 && c7 > 0;

  let score = 0;
  if (allPos)    score += 4;
  if (c24 > 3)   score += 1;
  if (c24 > 8)   score += 2;
  if (c24 > 20)  score += 1;
  if (c7  > 5)   score += 1;
  if (c7  > 20)  score += 2;
  if (vmr > 0.10) score += 1;
  if (vmr > 0.25) score += 2;
  if (vmr > 0.50) score += 1;

  score = Math.round(score * volTrend.multiplier);

  if (c24 > 80)   score -= 4;
  if (c7  > 200)  score -= 3;
  if (vmr > 2.0)  score -= 2;

  score += narAge.bonus;
  if (narAge.age === 'EARLY' && volTrend.trend === 'SURGING') score += 2;

  return {
    // identity
    symbol:         token.symbol,
    name:           token.name,
    id:             token.id,
    price:          q.price,
    // changes
    c1, c24, c7,
    volChange24h:   q.volume_change_24h || 0,
    // ratios
    vmr:            vmr.toFixed(3),
    // signals — ALL stored as objects so .signal / .age / etc always work
    volTrend,       // { trend, multiplier }
    divergence,     // { signal, label }
    narAge,         // { age, label, bonus }
    pumpStatus,     // { exhausted, label, exitWarning }
    // booleans
    allPos,
    // narrative — attached later
    narrative:      'Other',
    // score
    score,
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching CMC data...\n');

  const [tokens, metrics] = await Promise.all([getMomentumTokens(), getMarketMetrics()]);

  const regime = detectRegime(metrics);
  const fg     = computeSentiment(metrics, tokens);

  const maxPos   = regime.risk === 'HIGH' ? 5 : regime.risk === 'MED' ? 3 : 2;
  const allocPct = regime.risk === 'HIGH' ? 10 : regime.risk === 'MED' ? 15 : 20;
  const effectiveMaxPos = fg.gated ? 1 : maxPos;
  const effectiveAlloc  = fg.gated ? 10 : allocPct;

  // Score + sort
  const scored = tokens.map(scoreToken).filter(Boolean).sort((a, b) => b.score - a.score);
  const top10  = scored.slice(0, 10);

  // Attach narratives
  const ids          = top10.map(t => t.id).filter(Boolean);
  const categoryData = await getTokenCategories(ids);
  top10.forEach(t => {
    const info = categoryData[t.id];
    const tags = info?.tags || [];
    t.narrative = classifyNarrative(tags);
  });

  // Narrative heat map
  const narrativeMap = {};
  top10.forEach(t => {
    if (!narrativeMap[t.narrative]) narrativeMap[t.narrative] = { syms: [], total: 0 };
    narrativeMap[t.narrative].syms.push(t.symbol);
    narrativeMap[t.narrative].total += t.score;
  });
  const narrativeRanking = Object.entries(narrativeMap)
    .map(([name, d]) => ({ name, syms: d.syms, avg: (d.total / d.syms.length).toFixed(1) }))
    .sort((a, b) => b.avg - a.avg);

  // ── Print ──

  console.log('=== MARKET REGIME ===');
  console.log(`Regime : ${regime.regime} | Risk: ${regime.risk}`);
  console.log(`BTC Dom: ${metrics.btc_dominance.toFixed(1)}% | MCap: $${(metrics.quote.USD.total_market_cap/1e12).toFixed(2)}T | Vol: $${(metrics.quote.USD.total_volume_24h/1e9).toFixed(1)}B`);
  console.log(`Signal : ${regime.note}`);
  console.log(`Sentiment: ${fg.label}${fg.gated ? ' ⚠ EXTREME — max 1 position, 10% only' : ''}\n`);

  console.log('=== NARRATIVE HEAT MAP ===');
  console.log('Narrative      | Tokens                    | Avg Score');
  console.log('---------------|---------------------------|----------');
  narrativeRanking.forEach(n => {
    console.log(`${n.name.padEnd(15)}| ${n.syms.join(', ').padEnd(25)} | ${n.avg}`);
  });
  console.log(`\n🔥 Hottest narrative: ${narrativeRanking[0].name} (avg score: ${narrativeRanking[0].avg})\n`);

  console.log('=== TOP MOMENTUM TOKENS ===');
  console.log('Rank | Symbol    | Narrative | Age         | 24h%   | 7d%    | Divergence   | Pump        | Score');
  console.log('-----|-----------|-----------|-------------|--------|--------|--------------|-------------|------');
  top10.forEach((t, i) => {
    console.log(
      `${String(i+1).padStart(4)} | ${t.symbol.padEnd(9)} | ${t.narrative.padEnd(9)} | ${t.narAge.label.padEnd(13)} | ${t.c24.toFixed(2).padStart(6)}% | ${t.c7.toFixed(2).padStart(6)}% | ${t.divergence.label.padEnd(12)} | ${t.pumpStatus.label.padEnd(11)} | ${t.score}`
    );
  });

  // Watchlist — uses object properties consistently
  const watchlist = top10
    .filter(t =>
      t.allPos &&
      t.divergence.signal === 'CONFIRMED' &&
      t.narAge.age !== 'EXHAUSTED' &&
      !t.pumpStatus.exitWarning
    )
    .slice(0, effectiveMaxPos);

  console.log('\n=== STRATEGY OUTPUT ===');
  console.log(`Regime   : ${regime.regime} → Max ${effectiveMaxPos} positions, ${effectiveAlloc}% each`);
  console.log(`Sentiment: ${fg.label}`);
  console.log(`Narrative: ${narrativeRanking[0].name} is leading`);
  console.log(`Stop loss: 7% | Take profit: 20%\n`);

  if (watchlist.length === 0) {
    console.log('No confirmed signals — hold cash or wait for cleaner setup.');
  } else {
    console.log('Watchlist (allPos + CONFIRMED volume + narrative not EXHAUSTED):');
    watchlist.forEach((t, i) => {
      const stop   = (t.price * 0.93).toFixed(6);
      const target = (t.price * 1.20).toFixed(6);
      const warn   = t.pumpStatus.exitWarning ? ' ⚠ PUMP SLOWING — tighten stop' : '';
      console.log(`  ${i+1}. ${t.symbol.padEnd(10)} [${t.narAge.label}] Entry: $${t.price.toFixed(6)} | Stop: $${stop} | Target: $${target} | Score: ${t.score}${warn}`);
    });
  }
}

main().catch(console.error);