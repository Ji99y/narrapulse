import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const API_KEY = process.env.CMC_API_KEY;
const BASE = "https://pro-api.coinmarketcap.com";
const headers = { "X-CMC_PRO_API_KEY": API_KEY, Accept: "application/json" };

// ─── API CALLS ───────────────────────────────────────────────────────────────

async function getMomentumTokens() {
  const url = `${BASE}/v1/cryptocurrency/listings/latest?limit=500&convert=USD&sort=market_cap`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data || [];
}

async function getMarketMetrics() {
  const url = `${BASE}/v1/global-metrics/quotes/latest?convert=USD`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data;
}

async function getTokenCategories(ids) {
  const url = `${BASE}/v2/cryptocurrency/info?id=${ids.join(",")}&aux=tags`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data || {};
}

async function getCMCCategories() {
  const url = `${BASE}/v1/cryptocurrency/categories?limit=50&convert=USD`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data || [];
}
// ─── REGIME ──────────────────────────────────────────────────────────────────

function detectRegime(metrics) {
  const btcDom = metrics.btc_dominance;
  const vol = metrics.quote.USD.total_volume_24h;
  const mcap = metrics.quote.USD.total_market_cap;
  const volMcap = vol / mcap;

  if (btcDom > 58)
    return {
      regime: "BTC_DOMINANCE",
      risk: "LOW",
      note: "Altcoins suppressed — be very selective, stick to top 50",
    };
  if (btcDom < 50)
    return {
      regime: "ALTSEASON",
      risk: "HIGH",
      note: "Broad altcoin momentum — wider opportunities, tighten stops",
    };
  if (volMcap > 0.05)
    return {
      regime: "ACTIVE",
      risk: "MED",
      note: "Healthy volume — standard position sizing",
    };
  return {
    regime: "QUIET",
    risk: "LOW",
    note: "Low volume — reduce position sizes, wait for confirmation",
  };
}

// ─── SENTIMENT COMPOSITE ─────────────────────────────────────────────────────

function computeSentiment(metrics, tokens) {
  const qualified = tokens.filter((t) => {
    const fdv =
      t.quote.USD.fully_diluted_market_cap || t.quote.USD.market_cap || 0;
    return fdv > 50000000 && (t.quote.USD.volume_24h || 0) > 5000000;
  });
  const positive24h = qualified.filter(
    (t) => (t.quote.USD.percent_change_24h || 0) > 0,
  );
  const breadth = qualified.length
    ? (positive24h.length / qualified.length) * 100
    : 50;
  const btcDom = metrics.btc_dominance || 50;
  const btcScore = Math.max(0, Math.min(100, (65 - btcDom) * 3.33 + 50));
  const vol = metrics.quote.USD.total_volume_24h;
  const mcap = metrics.quote.USD.total_market_cap;
  const volScore = Math.min(100, (vol / mcap) * 1000);
  const score = Math.round(breadth * 0.5 + btcScore * 0.3 + volScore * 0.2);

  let gate, label, emoji;
  if (score <= 20) {
    gate = "EXTREME_FEAR";
    emoji = "🔴";
    label = `EXTREME FEAR (${score}/100)`;
  } else if (score <= 40) {
    gate = "FEAR";
    emoji = "🟠";
    label = `FEAR (${score}/100)`;
  } else if (score <= 60) {
    gate = "NEUTRAL";
    emoji = "⚪";
    label = `NEUTRAL (${score}/100)`;
  } else if (score <= 80) {
    gate = "GREED";
    emoji = "🟡";
    label = `GREED (${score}/100)`;
  } else {
    gate = "EXTREME_GREED";
    emoji = "🔴";
    label = `EXTREME GREED (${score}/100)`;
  }

  const gated = gate === "EXTREME_FEAR" || gate === "EXTREME_GREED";
  return { score, gate, label: `${emoji} ${label}`, gated };
}

// ─── VOLUME TREND ────────────────────────────────────────────────────────────

function getVolumeTrend(q) {
  const vc24 = q.volume_change_24h || 0;
  const cexVol = q.cex_volume_24h || 0;
  const dexVol = q.dex_volume_24h || 0;
  const c7 = q.percent_change_7d || 0;
  const vol24 = q.volume_24h || 0;

  // 24h trend (primary)
  let trend, multiplier;
  if (vc24 > 20) {
    trend = "SURGING";
    multiplier = 1.0;
  } else if (vc24 > 0) {
    trend = "RISING";
    multiplier = 1.0;
  } else if (vc24 > -20) {
    trend = "FADING";
    multiplier = 0.5;
  } else {
    trend = "COLLAPSING";
    multiplier = 0.0;
  }

  // Multi-timeframe confirmation:
  // Volume surging AND price in uptrend over 7d = genuinely building
  let weeklyTrend = "FLAT";
  if (vc24 > 20 && c7 > 5)
    weeklyTrend = "BUILDING"; // volume spike + weekly uptrend
  else if (vc24 > 0 && c7 > 0)
    weeklyTrend = "ABOVE_AVG"; // both positive
  else if (vc24 < -20 && c7 < 0)
    weeklyTrend = "DRYING_UP"; // both declining
  else weeklyTrend = "MIXED";

  // DEX vs CEX ratio — high DEX % = more organic, harder to fake
  const dexRatio = vol24 > 0 ? dexVol / vol24 : 0;
  const isOrganic = dexRatio > 0.3; // >30% DEX volume = more organic signal

  return {
    trend,
    multiplier,
    weeklyTrend,
    dexRatio: dexRatio.toFixed(2),
    isOrganic,
  };
}

// ─── DIVERGENCE ──────────────────────────────────────────────────────────────

function getDivergenceSignal(q) {
  const priceUp = q.percent_change_24h > 0;
  const vt = getVolumeTrend(q);

  if (!priceUp) return { signal: "NO_SIGNAL", label: "—" };
  if (vt.trend === "SURGING" || vt.trend === "RISING")
    return { signal: "CONFIRMED", label: "✓ CONFIRMED" };
  if (vt.trend === "FADING") return { signal: "WEAK", label: "⚠ WEAK" };
  return { signal: "DIVERGING", label: "✗ DIVERGING" };
}

// ─── NARRATIVE AGE ───────────────────────────────────────────────────────────

function detectNarrativeAge(q) {
  const c7 = q.percent_change_7d || 0;
  const c30 = q.percent_change_30d || 0;
  const c24 = q.percent_change_24h || 0;
  const c1 = q.percent_change_1h || 0;

  if (c7 > 10 && c30 < 20 && c1 > 0 && c24 > 3)
    return { age: "EARLY", label: "🟢 EARLY", bonus: 3 };
  if (c7 > 3 && c7 < 10 && c24 > 5 && c1 > 1)
    return { age: "NASCENT", label: "🌱 NASCENT", bonus: 1 };
  if (c7 > 10 && c30 > 20 && c24 > 0)
    return { age: "PRIME", label: "🟡 PRIME", bonus: 1 };
  if (c30 > 80 && c24 < 5 && c1 < 1)
    return { age: "EXHAUSTED", label: "🔴 EXHAUSTED", bonus: -3 };
  if (c30 > 40 && c7 < c30 / 4)
    return { age: "LATE", label: "🟠 LATE", bonus: -1 };
  return { age: "MID", label: "⚪ MID", bonus: 0 };
}

// ─── PUMP EXHAUSTION ─────────────────────────────────────────────────────────

function detectPumpExhaustion(q) {
  const c1 = q.percent_change_1h || 0;
  const c24 = q.percent_change_24h || 0;
  const volChg = q.volume_change_24h || 0;

  if (c24 <= 20) return { exhausted: false, label: "—", exitWarning: false };

  const hourlyPace = c1 * 24;
  const pumpSlowing = hourlyPace < c24 * 0.5;
  const volStillHigh = volChg > 30;

  if (pumpSlowing && volStillHigh)
    return { exhausted: true, label: "⚠ EXIT SOON", exitWarning: true };
  if (pumpSlowing && !volStillHigh)
    return { exhausted: true, label: "🚨 EXIT NOW", exitWarning: true };
  return { exhausted: false, label: "✓ RUNNING", exitWarning: false };
}

// ─── NARRATIVE CLASSIFY ──────────────────────────────────────────────────────

function classifyNarrative(tags = []) {
  const t = tags.map((x) => (x.slug || x).toLowerCase());
  if (
    t.some((x) =>
      [
        "ai",
        "artificial-intelligence",
        "machine-learning",
        "ai-agent",
      ].includes(x),
    )
  )
    return "AI";
  if (
    t.some((x) =>
      [
        "defi",
        "decentralized-finance",
        "dex",
        "yield-farming",
        "lending",
      ].includes(x),
    )
  )
    return "DeFi";
  if (t.some((x) => ["meme", "memes", "dog-themed", "cat-themed"].includes(x)))
    return "Meme";
  if (
    t.some((x) =>
      ["layer-1", "layer1", "l1", "smart-contracts", "platform"].includes(x),
    )
  )
    return "L1";
  if (
    t.some((x) =>
      [
        "layer-2",
        "layer2",
        "l2",
        "scaling",
        "rollup",
        "optimistic-rollup",
      ].includes(x),
    )
  )
    return "L2";
  if (
    t.some((x) =>
      [
        "infrastructure",
        "interoperability",
        "oracle",
        "bridge",
        "storage",
      ].includes(x),
    )
  )
    return "Infra";
  if (
    t.some((x) =>
      ["gaming", "metaverse", "nft", "play-to-earn", "gamefi"].includes(x),
    )
  )
    return "Gaming";
  if (t.some((x) => ["stablecoin", "stable"].includes(x))) return "Stablecoin";
  if (t.some((x) => ["exchange", "cex", "centralized-exchange"].includes(x)))
    return "CeFi";
  return "Other";
}

// ─── SCORE TOKEN ─────────────────────────────────────────────────────────────

function scoreToken(token, btc24h) {
  const q = token.quote.USD;
  const c1 = q.percent_change_1h || 0;
  const c24 = q.percent_change_24h || 0;
  const c7 = q.percent_change_7d || 0;
  const vol = q.volume_24h || 0;
  const mcap = q.market_cap || 0;
  const fdv = q.fully_diluted_market_cap || mcap;

  // Quality filters
  if (fdv < 50_000_000 || fdv > 500_000_000) return null;
  if (vol < 5_000_000) return null;
  if (q.price < 0.001) return null;
  // Filter near-zero volatility tokens (stablecoins that slip through price filter)
  if (Math.abs(c7) < 3.0) return null;

  ``;
  const vmr = vol / fdv;
  const supplyRatio = fdv > 0 ? fdv / (mcap || fdv) : 1;
  const volTrend = getVolumeTrend(q);
  const divergence = getDivergenceSignal(q);
  const narAge = detectNarrativeAge(q);
  const pumpStatus = detectPumpExhaustion(q, narAge.age);
  const allPos = c1 > 0 && c24 > 0 && c7 > 0;

  let score = 0;
  if (allPos) score += 4;
  if (c24 > 3) score += 1;
  if (c24 > 8) score += 2;
  if (c24 > 20) score += 1;
  if (c7 > 5) score += 1;
  if (c7 > 20) score += 2;
  if (vmr > 0.1) score += 1;
  if (vmr > 0.25) score += 2;
  if (vmr > 0.5) score += 1;

  score = Math.round(score * volTrend.multiplier);

  if (c24 > 80) score -= 4;
  if (c7 > 100) return null;
  if (vmr > 2.0) score -= 2;
  // Supply pressure — FDV/mcap ratio
  if (supplyRatio < 1.5) score += 2; // most supply circulating, low dilution risk
  if (supplyRatio > 3.0) score -= 2; // large supply overhang
  if (supplyRatio > 5.0) return null; // exclude — serious dilution risk

  // Multi-timeframe volume confirmation
  if (volTrend.weeklyTrend === "BUILDING") score += 2;
  if (volTrend.weeklyTrend === "ABOVE_AVG") score += 1;
  if (volTrend.weeklyTrend === "DRYING_UP") score -= 2;

  // Organic volume bonus — DEX volume harder to fake than CEX
  if (volTrend.isOrganic) score += 1;

  // Relative strength vs BTC
  const rs = c24 - btc24h;
  if (rs > 5) score += 2; // meaningfully outperforming BTC
  if (rs > 10) score += 1; // strongly outperforming
  if (rs < -3) score -= 1; // underperforming BTC

  score += narAge.bonus;
  if (narAge.age === "EARLY" && volTrend.trend === "SURGING") score += 2;
  // Cap score for tokens moving down today — they won't make watchlist anyway
  if (!allPos && c24 < 0) score = Math.min(score, 3);

  // ── SIGNAL QUALITY IMPROVEMENTS ──────────────────────────────────────────

  // 1. Price position within range
  // Estimate 7d high from price before the 7d move
  const priceBase7 = c7 !== -100 ? q.price / (1 + c7 / 100) : q.price;
  const rangeHigh = Math.max(q.price, priceBase7);
  const rangeLow = Math.min(q.price, priceBase7);
  const rangeSpan = rangeHigh - rangeLow;
  const rangePos = rangeSpan > 0 ? (q.price - rangeLow) / rangeSpan : 0.5;
  // Breaking up from bottom of range = strong, already at top = crowded
  if (rangePos < 0.3 && c24 > 0) score += 2; // bottom of range, moving up
  if (rangePos > 0.85) score -= 1; // near top of range, crowded

  // 2. Volume spike detection (normalize against expected daily turnover)
  const volSpike = fdv > 0 ? vol / fdv / 0.05 : 0; // 5% daily turnover = baseline
  if (volSpike > 5)
    score += 3; // very unusual volume
  else if (volSpike > 3)
    score += 2; // unusual volume
  else if (volSpike > 2) score += 1; // above average

  // 3. Cross-timeframe consistency
  const c30 = q.percent_change_30d || 0;
  const consistency =
    (c1 > 1 ? 1 : 0) + (c24 > 3 ? 1 : 0) + (c7 > 5 ? 1 : 0) + (c30 > 0 ? 1 : 0);
  score += consistency;

  // 4. 60d narrative age proxy — token that ran 60d ago now consolidating
  const c60 = q.percent_change_60d || 0;
  if (c60 > 200 && c30 < 30) return null; // old narrative in consolidation — exclude

  return {
    symbol: token.symbol,
    id: token.id,
    price: q.price,
    c1,
    c24,
    c7,
    divergence,
    narAge,
    pumpStatus,
    volTrend,
    allPos,
    narrative: "Other",
    score,
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching CMC data...\n");

  const [tokens, metrics, cmcCategories] = await Promise.all([
    getMomentumTokens(),
    getMarketMetrics(),
    getCMCCategories(),
  ]);

  const regime = detectRegime(metrics);
  // Get BTC 24h change for relative strength calculation
  const btcToken = tokens.find((t) => t.symbol === "BTC");
  const btc24h = btcToken?.quote?.USD?.percent_change_24h || 0;
  console.log(`BTC 24h: ${btc24h >= 0 ? "+" : ""}${btc24h.toFixed(2)}%\n`);
  const fg = computeSentiment(metrics, tokens);

  const maxPos = regime.risk === "HIGH" ? 5 : regime.risk === "MED" ? 3 : 2;
  const allocPct =
    regime.risk === "HIGH" ? 10 : regime.risk === "MED" ? 15 : 20;
  const effectiveMaxPos = fg.gated ? 1 : maxPos;
  const effectiveAlloc = fg.gated ? 10 : allocPct;

  // Score + sort
  const scored = tokens
    .map((t) => scoreToken(t, btc24h))
    .filter(Boolean)
    .sort((a, b) => {
      // Primary: score descending
      if (b.score !== a.score) return b.score - a.score;
      // Secondary: 1h momentum as tiebreaker
      return (b.c1 || 0) - (a.c1 || 0);
    });
  const top10 = scored.slice(0, 10);

  // Attach narratives
  const ids = top10.map((t) => t.id).filter(Boolean);
  const categoryData = await getTokenCategories(ids);
  top10.forEach((t) => {
    const info = categoryData[t.id];
    const tags = info?.tags || [];
    t.narrative = classifyNarrative(tags);
  });

  // Narrative heat map
  const narrativeMap = {};
  top10.forEach((t) => {
    if (!narrativeMap[t.narrative])
      narrativeMap[t.narrative] = { syms: [], total: 0 };
    narrativeMap[t.narrative].syms.push(t.symbol);
    narrativeMap[t.narrative].total += t.score;
  });
  const narrativeRanking = Object.entries(narrativeMap)
    .map(([name, d]) => ({
      name,
      syms: d.syms,
      avg: (d.total / d.syms.length).toFixed(1),
    }))
    .sort((a, b) => b.avg - a.avg);

  // ── Print ──

  console.log("=== MARKET REGIME ===");
  console.log(`Regime : ${regime.regime} | Risk: ${regime.risk}`);
  console.log(
    `BTC Dom: ${metrics.btc_dominance.toFixed(1)}% | MCap: $${(metrics.quote.USD.total_market_cap / 1e12).toFixed(2)}T | Vol: $${(metrics.quote.USD.total_volume_24h / 1e9).toFixed(1)}B`,
  );
  console.log(`Signal : ${regime.note}`);
  console.log(
    `Sentiment: ${fg.label}${fg.gated ? " ⚠ EXTREME — max 1 position, 10% only" : ""}\n`,
  );

  console.log("=== NARRATIVE HEAT MAP ===");
  console.log("Narrative      | Tokens                    | Avg Score");
  console.log("---------------|---------------------------|----------");
  narrativeRanking.forEach((n) => {
    console.log(
      `${n.name.padEnd(15)}| ${n.syms.join(", ").padEnd(25)} | ${n.avg}`,
    );
  });
  // Derive top 1h gainers from our own universe — same signal, zero extra credits
  const topGainers = scored
    .filter((t) => (t.c1 || 0) > 2)
    .sort((a, b) => (b.c1 || 0) - (a.c1 || 0))
    .slice(0, 5);

  // Boost tokens with strong 1h momentum
  topGainers.forEach((t) => {
    t.score += 2;
    t.isGainer = true;
  });

  // Re-sort after boost
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.c1 || 0) - (a.c1 || 0);
  });

  console.log("=== TOP 1H MOVERS (fresh momentum) ===");
  if (topGainers.length === 0) {
    console.log("No tokens with >2% 1h gain in current universe\n");
  } else {
    topGainers.forEach((t) => {
      console.log(
        `${t.symbol.padEnd(10)} | ${t.narAge.label.padEnd(13)} | 1h: ${(t.c1 || 0).toFixed(2).padStart(6)}% | 24h: ${t.c24.toFixed(2).padStart(6)}% | Score: ${t.score}`,
      );
    });
    console.log("");
  }
  console.log(
    `\n🔥 Hottest narrative: ${narrativeRanking[0].name} (avg score: ${narrativeRanking[0].avg})\n`,
  );

  console.log("=== TOP MOMENTUM TOKENS ===");
  console.log(
    "Rank | Symbol    | Narrative | Age         | 24h%   | 7d%    | Divergence   | WeekVol     | DEX%  | Score",
  );
  console.log(
    "-----|-----------|-----------|-------------|--------|--------|--------------|-------------|-------|------",
  );
  // Watchlist — uses object properties consistently
  top10.forEach((t, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${t.symbol.padEnd(9)} | ${t.narrative.padEnd(9)} | ${t.narAge.label.padEnd(13)} | ${t.c24.toFixed(2).padStart(6)}% | ${t.c7.toFixed(2).padStart(6)}% | ${t.divergence.label.padEnd(12)} | ${t.volTrend.weeklyTrend.padEnd(11)} | ${(t.volTrend.dexRatio * 100).toFixed(0).padStart(4)}% | ${t.score}`,
    );
  });

  // Watchlist — uses object properties consistently
  const watchlist = top10
    .filter(
      (t) =>
        t.allPos &&
        t.divergence.signal === "CONFIRMED" &&
        t.narAge.age !== "EXHAUSTED" &&
        !t.pumpStatus.exitWarning,
    )
    .slice(0, effectiveMaxPos);

  console.log("\n=== STRATEGY OUTPUT ===");
  console.log(
    `Regime   : ${regime.regime} → Max ${effectiveMaxPos} positions, ${effectiveAlloc}% each`,
  );
  console.log(`Sentiment: ${fg.label}`);
  console.log(`Narrative: ${narrativeRanking[0].name} is leading`);
  console.log(`Stop loss: 7% | Take profit: 20%\n`);

  if (watchlist.length === 0) {
    console.log("No confirmed signals — hold cash or wait for cleaner setup.");
  } else {
    console.log(
      "Watchlist (allPos + CONFIRMED volume + narrative not EXHAUSTED):",
    );
    watchlist.forEach((t, i) => {
      const stop = (t.price * 0.93).toFixed(6);
      const target = (t.price * 1.2).toFixed(6);
      const warn = t.pumpStatus.exitWarning
        ? " ⚠ PUMP SLOWING — tighten stop"
        : "";
      console.log(
        `  ${i + 1}. ${t.symbol.padEnd(10)} [${t.narAge.label}] Entry: $${t.price.toFixed(6)} | Stop: $${stop} | Target: $${target} | Score: ${t.score}${warn}`,
      );
    });
  }
}

main().catch(console.error);
