import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
dotenv.config();

const CMC_KEY = process.env.CMC_API_KEY;
const CMC_BASE = "https://pro-api.coinmarketcap.com";
const CG_BASE = "https://api.coingecko.com/api/v3";
const cmcHeaders = { "X-CMC_PRO_API_KEY": CMC_KEY, Accept: "application/json" };

// ─── CMC: get current universe ───────────────────────────────────────────────

async function getTokens() {
  const url = `${CMC_BASE}/v1/cryptocurrency/listings/latest?limit=500&convert=USD&sort=market_cap`;
  const res = await fetch(url, { headers: cmcHeaders });
  const data = await res.json();
  return data.data || [];
}

// ─── COINGECKO: build symbol → id map ────────────────────────────────────────

async function getCoinGeckoIdMap() {
  console.log("Fetching CoinGecko coins list...");
  const res = await fetch(`${CG_BASE}/coins/list`);
  const data = await res.json();
  const map = {};
  // Some symbols have multiple CoinGecko IDs — keep all, prefer BSC/BNB ones
  data.forEach((coin) => {
    const sym = coin.symbol.toUpperCase();
    if (!map[sym]) {
      map[sym] = [];
    }
    map[sym].push(coin);
  });
  return map;
}

function resolveCoinGeckoId(symbol, idMap) {
  const matches = idMap[symbol.toUpperCase()] || [];
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0].id;

  const bscMatch = matches.find(c =>
    c.id.includes('bsc') ||
    c.id.includes('bnb') ||
    c.id.includes('binance') ||
    c.name.toLowerCase().includes('bsc')
  );
  if (bscMatch) return bscMatch.id;
  return matches[0].id;
}

async function tryAllCoinGeckoIds(symbol, idMap) {
  const matches = idMap[symbol.toUpperCase()] || [];
  for (const coin of matches.slice(0, 3)) { // try up to 3 IDs
    const candles = await getCoinGeckoOHLC(coin.id);
    if (candles) return { id: coin.id, candles };
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}


async function getCoinGeckoOHLC(coinId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${CG_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=30&interval=daily`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (res.status === 429) {
        // Rate limited — wait and retry
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      if (!res.ok) return null;

      const data = await res.json();
      const prices = data.prices || [];
      if (prices.length < 8) return null;

      const candles = [];
      for (let i = 0; i < prices.length - 1; i++) {
        const open = prices[i][1];
        const close = prices[i + 1][1];
        const high = Math.max(open, close) * 1.005;
        const low = Math.min(open, close) * 0.995;
        candles.push([prices[i][0], open, high, low, close]);
      }

      return candles.length >= 8 ? candles : null;
    } catch {
      return null;
    }
  }
  return null;
}
// ─── SIMULATE TRADE ──────────────────────────────────────────────────────────

function simulateTrade(candles, lookbackDays = 7) {
  // CoinGecko OHLC for 30 days returns candles grouped by day
  // Find entry candle from ~7 days ago
  const now = Date.now();
  const entryTime = now - lookbackDays * 24 * 60 * 60 * 1000;

  // Find the candle closest to entry time
  let entryIdx = 0;
  let minDiff = Infinity;
  candles.forEach((c, i) => {
    const diff = Math.abs(c[0] - entryTime);
    if (diff < minDiff) {
      minDiff = diff;
      entryIdx = i;
    }
  });

  const entryCandle = candles[entryIdx];
  if (!entryCandle) return null;

  const entryPrice = entryCandle[4]; // close
  const stopPrice = entryPrice * 0.93;
  const targetPrice = entryPrice * 1.2;

  // Walk forward from entry
  const forwardCandles = candles.slice(entryIdx + 1);
  let outcome = "OPEN";
  let exitPrice = candles[candles.length - 1][4]; // current close
  let daysHeld = forwardCandles.length;

  for (let i = 0; i < forwardCandles.length; i++) {
    const high = forwardCandles[i][2];
    const low = forwardCandles[i][3];
    daysHeld = i + 1;

    if (low <= stopPrice) {
      outcome = "STOPPED_OUT";
      exitPrice = stopPrice;
      break;
    }
    if (high >= targetPrice) {
      outcome = "TARGET_HIT";
      exitPrice = targetPrice;
      break;
    }
  }

  const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return {
    entryPrice,
    exitPrice,
    stopPrice,
    targetPrice,
    outcome,
    returnPct,
    daysHeld,
  };
}

// ─── QUALITY FILTERS ─────────────────────────────────────────────────────────

function passesFilter(token) {
  const q = token.quote.USD;
  const fdv = q.fully_diluted_market_cap || q.market_cap || 0;
  if (fdv < 50_000_000 || fdv > 500_000_000) return false;
  if ((q.volume_24h || 0) < 5_000_000) return false;
  if ((q.price || 0) < 0.001) return false;
  const c24 = q.percent_change_24h || 0;
  const c7 = q.percent_change_7d || 0;
  if (Math.abs(c24) < 0.1 && Math.abs(c7) < 0.5) return false;
  return true;
}

// ─── NARRATIVE AGE ───────────────────────────────────────────────────────────

function getNarrativeAge(q) {
  const c7 = q.percent_change_7d || 0;
  const c30 = q.percent_change_30d || 0;
  const c24 = q.percent_change_24h || 0;
  const c1 = q.percent_change_1h || 0;
  if (c7 > 10 && c30 < 20 && c1 > 0 && c24 > 3) return "EARLY";
  if (c7 > 10 && c30 > 20 && c24 > 0) return "PRIME";
  if (c30 > 80 && c24 < 5 && c1 < 1) return "EXHAUSTED";
  if (c30 > 40 && c7 < c30 / 4) return "LATE";
  return "MID";
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("NarraPulse Real Backtest — CoinGecko OHLC\n");

  const [tokens, idMap] = await Promise.all([getTokens(), getCoinGeckoIdMap()]);

  const qualified = tokens.filter(passesFilter);
  console.log(
    `CMC universe: ${tokens.length} tokens → ${qualified.length} pass filters`,
  );
  console.log(`CoinGecko map: ${Object.keys(idMap).length} symbols loaded\n`);

  const results = [];
  let fetched = 0,
    skipped = 0;

  for (const token of qualified) {
    const symbol = token.symbol;
    const q = token.quote.USD;
    const age = getNarrativeAge(q);

    if (age === "EXHAUSTED") {
      skipped++;
      continue;
    }

    const cgId = resolveCoinGeckoId(symbol, idMap);
    process.stdout.write(`${symbol.padEnd(14)}`);

    if (!cgId) {
      console.log("— not in CoinGecko");
      skipped++;
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }

    const result = await tryAllCoinGeckoIds(symbol, idMap);
    if (!result) {
      console.log(`— no OHLC data`);
      skipped++;
      continue;
    }
    const { id: resolvedId, candles } = result;

    const trade = simulateTrade(candles, 7);
    if (!trade) {
      console.log("— simulation failed");
      skipped++;
      continue;
    }

    fetched++;
    const ret = trade.returnPct;
    console.log(
      `✓ ${age.padEnd(10)} | ${trade.outcome.padEnd(12)} | ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% in ${trade.daysHeld}d`,
    );

    results.push({
      symbol,
      cgId: resolvedId,
      narrativeAge: age,
      entryPrice: trade.entryPrice.toFixed(6),
      exitPrice: trade.exitPrice.toFixed(6),
      outcome: trade.outcome,
      returnPct: ret.toFixed(2),
      daysHeld: trade.daysHeld,
    });

    // CoinGecko free tier: ~10-30 calls/min — be polite
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ── Stats ──
  const winners = results.filter((r) => parseFloat(r.returnPct) > 0);
  const stopped = results.filter((r) => r.outcome === "STOPPED_OUT");
  const targeted = results.filter((r) => r.outcome === "TARGET_HIT");
  const open = results.filter((r) => r.outcome === "OPEN");
  const avgRet = results.length
    ? results.reduce((s, r) => s + parseFloat(r.returnPct), 0) / results.length
    : 0;
  const winRate = results.length ? (winners.length / results.length) * 100 : 0;
  const expectancy = (avgRet * winRate) / 100;

  const ages = ["EARLY", "PRIME", "MID", "LATE"];
  const ageStats = {};
  ages.forEach((age) => {
    const at = results.filter((r) => r.narrativeAge === age);
    if (!at.length) return;
    const aw = at.filter((r) => parseFloat(r.returnPct) > 0);
    const avg = at.reduce((s, r) => s + parseFloat(r.returnPct), 0) / at.length;
    ageStats[age] = {
      count: at.length,
      winRate: ((aw.length / at.length) * 100).toFixed(1),
      avgRet: avg.toFixed(2),
    };
  });

  console.log("\n══════════════════════════════════════════");
  console.log("REAL BACKTEST RESULTS — CoinGecko OHLC");
  console.log("══════════════════════════════════════════");
  console.log(`Tokens backtested: ${fetched}`);
  console.log(`Tokens skipped   : ${skipped} (not on CoinGecko or no OHLC)`);
  console.log(`Win rate         : ${winRate.toFixed(1)}%`);
  console.log(
    `Avg return       : ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%`,
  );
  console.log(
    `Expectancy       : ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}% per trade`,
  );
  console.log(`Target hit (+20%): ${targeted.length}`);
  console.log(`Stopped out (-7%): ${stopped.length}`);
  console.log(`Still open       : ${open.length}`);

  console.log("\n─── By narrative age ───────────────────────");
  Object.entries(ageStats).forEach(([age, s]) => {
    console.log(
      `${age.padEnd(12)}: ${s.count} trades | ${s.winRate}% win | ${parseFloat(s.avgRet) >= 0 ? "+" : ""}${s.avgRet}% avg`,
    );
  });

  const csv = [
    "symbol,coingecko_id,narrative_age,entry_price,exit_price,outcome,return_pct,days_held",
    ...results.map(
      (r) =>
        `${r.symbol},${r.cgId},${r.narrativeAge},${r.entryPrice},${r.exitPrice},${r.outcome},${r.returnPct},${r.daysHeld}`,
    ),
  ].join("\n");

  fs.writeFileSync("backtest_results.csv", csv);
  console.log(`\n✓ ${results.length} trades saved to backtest_results.csv`);
}

main().catch(console.error);
