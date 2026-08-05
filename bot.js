import dotenv from "dotenv";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";
dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL = process.env.TELEGRAM_CHANNEL_ID;
const STATE_FILE = "./last_signals.json";
const SIGNALS_API =
  process.env.SIGNALS_API_URL || "https://narrapulse.vercel.app/api/signals";

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
      note: "Altcoins suppressed — be very selective",
    };
  if (btcDom < 50)
    return {
      regime: "ALTSEASON",
      risk: "HIGH",
      note: "Broad altcoin momentum — wider opportunities",
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
    note: "Low volume — reduce position sizes",
  };
}

// ─── SENTIMENT ───────────────────────────────────────────────────────────────

function computeSentiment(metrics, tokens) {
  const qualified = tokens.filter((t) => {
    const q = t.quote.USD;
    const fdv = q.fully_diluted_market_cap || q.market_cap || 0;
    return fdv > 50000000 && fdv < 500000000 && (q.volume_24h || 0) > 5000000;
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
  const dexVol = q.dex_volume_24h || 0;
  const c7 = q.percent_change_7d || 0;
  const vol24 = q.volume_24h || 0;

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

  let weeklyTrend = "FLAT";
  if (vc24 > 20 && c7 > 5) weeklyTrend = "BUILDING";
  else if (vc24 > 0 && c7 > 0) weeklyTrend = "ABOVE_AVG";
  else if (vc24 < -20 && c7 < 0) weeklyTrend = "DRYING_UP";
  else weeklyTrend = "MIXED";

  const dexRatio = vol24 > 0 ? dexVol / vol24 : 0;
  const isOrganic = dexRatio > 0.3;

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
  const vt = getVolumeTrend(q);
  if (q.percent_change_24h <= 0) return { signal: "NO_SIGNAL" };
  if (vt.trend === "SURGING" || vt.trend === "RISING")
    return { signal: "CONFIRMED" };
  if (vt.trend === "FADING") return { signal: "WEAK" };
  return { signal: "DIVERGING" };
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

function detectPumpExhaustion(q, narAge) {
  const c1 = q.percent_change_1h || 0;
  const c24 = q.percent_change_24h || 0;
  const threshold = narAge === "EARLY" ? 40 : 20;
  if (c24 <= threshold) return { exitWarning: false };
  const pumpSlowing = c1 * 24 < c24 * 0.5;
  return { exitWarning: pumpSlowing };
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
    t.some((x) => ["layer-2", "layer2", "l2", "scaling", "rollup"].includes(x))
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
  return "Other";
}

// ─── SCORE TOKEN ─────────────────────────────────────────────────────────────

function scoreToken(token, btc24h = 0) {
  const q = token.quote.USD;
  const fdv = q.fully_diluted_market_cap || q.market_cap || 0;
  const mcap = q.market_cap || 0;
  const vol = q.volume_24h || 0;

  if (fdv < 50_000_000 || fdv > 500_000_000) return null;
  if (vol < 5_000_000 || q.price < 0.001) return null;
  if (
    q.price > 0.99 &&
    q.price < 1.01 &&
    Math.abs(q.percent_change_7d || 0) < 1
  )
    return null;

  const c1 = q.percent_change_1h || 0;
  const c24 = q.percent_change_24h || 0;
  const c7 = q.percent_change_7d || 0;

  if (Math.abs(c7) < 3.0) return null;

  const vmr = vol / fdv;
  const supplyRatio = fdv > 0 ? fdv / (mcap || fdv) : 1;
  if (supplyRatio > 5.0) return null;

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
  if (c7 > 200) score -= 3;
  if (vmr > 2.0) score -= 2;
  if (supplyRatio < 1.5) score += 2;
  if (supplyRatio > 3.0) score -= 2;
  if (volTrend.weeklyTrend === "BUILDING") score += 2;
  if (volTrend.weeklyTrend === "ABOVE_AVG") score += 1;
  if (volTrend.weeklyTrend === "DRYING_UP") score -= 2;
  if (volTrend.isOrganic) score += 1;

  const rs = c24 - btc24h;
  if (rs > 10) score += 2;
  else if (rs > 5) score += 1;
  else if (rs < -3) score -= 1;

  score += narAge.bonus;
  if (narAge.age === "EARLY" && volTrend.trend === "SURGING") score += 2;

  return {
    symbol: token.symbol,
    id: token.id,
    price: q.price,
    c1,
    c24,
    c7,
    volTrend,
    divergence,
    narAge,
    pumpStatus,
    allPos,
    narrative: "Other",
    score,
  };
}

// ─── STATE ───────────────────────────────────────────────────────────────────

function loadLastSignals() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveLastSignals(signals) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(signals));
}

// ─── SIGNAL HISTORY API ──────────────────────────────────────────────────────

async function postSignalOpen(signal) {
  try {
    await fetch(SIGNALS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", ...signal }),
    });
  } catch (e) {
    console.error("Failed to post signal open:", e.message);
  }
}

// ─── MESSAGE FORMATTING ──────────────────────────────────────────────────────

function escMD(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function formatNewSignal(t, regime, fg, allocPct) {
  const ageEmoji =
    t.narAge.age === "EARLY" ? "🟢" : t.narAge.age === "PRIME" ? "🟡" : "⚪";
  const stop = (t.price * 0.93).toFixed(6);
  const target = (t.price * 1.2).toFixed(6);
  return `${ageEmoji} *NEW SIGNAL — NarraPulse*

*Token:* \`${escMD(t.symbol)}\` — ${escMD(t.narrative)}
*Narrative age:* ${escMD(t.narAge.label)}
*Entry:* \`$${escMD(t.price.toFixed(6))}\`
*Stop loss:* \`$${escMD(stop)}\` \\(−7%\\)
*Take profit:* \`$${escMD(target)}\` \\(\\+20%\\)
*Score:* ${t.score} \\| *Volume:* ${escMD(t.volTrend.trend)}
*Weekly vol:* ${escMD(t.volTrend.weeklyTrend)} \\| *DEX:* ${(t.volTrend.dexRatio * 100).toFixed(0)}%
*Regime:* ${escMD(regime.regime)} — ${allocPct}% per position
*Sentiment:* ${escMD(fg.label)}

_⚠️ Not financial advice\\. Always apply your own risk management\\._`;
}

function formatMarketSummary(regime, fg, hotNarrative, watchlistCount) {
  return `📊 *NarraPulse — Market Update*

*Regime:* ${escMD(regime.regime)} \\(${escMD(regime.risk)} risk\\)
*Sentiment:* ${escMD(fg.label)}
*Hottest narrative:* ${escMD(hotNarrative)}
*Signals on watchlist:* ${watchlistCount}
*Note:* ${escMD(regime.note)}

_Updated every 4 hours · narrapulse\\.vercel\\.app_`;
}

function formatCloseAlert(symbol, outcome, returnPct) {
  const emoji =
    outcome === "TARGET_HIT" ? "🎯" : outcome === "STOPPED_OUT" ? "🛑" : "⏱";
  const label =
    outcome === "TARGET_HIT"
      ? "TARGET HIT"
      : outcome === "STOPPED_OUT"
        ? "STOPPED OUT"
        : "EXPIRED";
  const ret =
    returnPct >= 0 ? `\\+${returnPct.toFixed(2)}%` : `${returnPct.toFixed(2)}%`;
  return `${emoji} *Signal closed:* \`${escMD(symbol)}\`\n*Outcome:* ${escMD(label)} \\| *Return:* ${ret}`;
}

// ─── MAIN SIGNAL CHECK ───────────────────────────────────────────────────────

async function runCheck() {
  console.log(`\n[${new Date().toISOString()}] Running signal check...`);
  try {
    const [tokens, metrics] = await Promise.all([
      getMomentumTokens(),
      getMarketMetrics(),
    ]);

    const regime = detectRegime(metrics);
    const fg = computeSentiment(metrics, tokens);
    const maxPos = fg.gated
      ? 1
      : regime.risk === "HIGH"
        ? 5
        : regime.risk === "MED"
          ? 3
          : 2;
    const allocPct = fg.gated
      ? 10
      : regime.risk === "HIGH"
        ? 10
        : regime.risk === "MED"
          ? 15
          : 20;

    const btcToken = tokens.find((t) => t.symbol === "BTC");
    const btc24h = btcToken?.quote?.USD?.percent_change_24h || 0;

    const scored = tokens
      .map((t) => scoreToken(t, btc24h))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const topGainers = [...scored]
      .filter((t) => (t.c1 || 0) > 2)
      .sort((a, b) => (b.c1 || 0) - (a.c1 || 0))
      .slice(0, 5);
    topGainers.forEach((t) => {
      t.score += 2;
    });
    scored.sort((a, b) => b.score - a.score);

    const top10 = scored.slice(0, 10);
    const ids = top10.map((t) => t.id).filter(Boolean);
    const catData = await getTokenCategories(ids);
    top10.forEach((t) => {
      t.narrative = classifyNarrative(catData[t.id]?.tags || []);
    });

    const narrativeMap = {};
    top10.forEach((t) => {
      if (!narrativeMap[t.narrative])
        narrativeMap[t.narrative] = { syms: [], total: 0 };
      narrativeMap[t.narrative].syms.push(t.symbol);
      narrativeMap[t.narrative].total += t.score;
    });
    const hotNarrative =
      Object.entries(narrativeMap)
        .map(([name, d]) => ({ name, avg: d.total / d.syms.length }))
        .sort((a, b) => b.avg - a.avg)[0]?.name || "Unknown";

    const watchlist = top10
      .filter(
        (t) =>
          t.allPos &&
          t.divergence.signal === "CONFIRMED" &&
          t.narAge.age !== "EXHAUSTED" &&
          !t.pumpStatus.exitWarning,
      )
      .slice(0, maxPos);

    const currentSymbols = watchlist.map((t) => t.symbol);
    const lastSignals = loadLastSignals();
    const lastSymbols = lastSignals.map((s) => s.symbol);

    const newSignals = watchlist.filter((t) => !lastSymbols.includes(t.symbol));
    const closedSymbols = lastSymbols.filter(
      (s) => !currentSymbols.includes(s),
    );

    console.log(`Regime: ${regime.regime} | Sentiment: ${fg.label}`);
    console.log(`Watchlist: ${currentSymbols.join(", ") || "empty"}`);
    console.log(`New: ${newSignals.map((t) => t.symbol).join(", ") || "none"}`);
    console.log(`Closed: ${closedSymbols.join(", ") || "none"}`);

    for (const t of newSignals) {
      const msg = formatNewSignal(t, regime, fg, allocPct);
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      console.log(`✓ Sent new signal: ${t.symbol}`);
      await postSignalOpen({
        symbol: t.symbol,
        narrativeAge: t.narAge.age,
        narrative: t.narrative,
        entry: t.price,
        stop: parseFloat((t.price * 0.93).toFixed(6)),
        target: parseFloat((t.price * 1.2).toFixed(6)),
        score: t.score,
        regime: regime.regime,
        sentiment: fg.label,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const symbol of closedSymbols) {
      const last = lastSignals.find((s) => s.symbol === symbol);
      const msg = formatCloseAlert(
        symbol,
        last?.outcome || "CLOSED",
        last?.returnPct || 0,
      );
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      console.log(`✓ Sent close alert: ${symbol}`);
      await new Promise((r) => setTimeout(r, 500));
    }

    if (newSignals.length === 0 && closedSymbols.length === 0) {
      const summary = formatMarketSummary(
        regime,
        fg,
        hotNarrative,
        watchlist.length,
      );
      await bot.sendMessage(CHANNEL, summary, { parse_mode: "MarkdownV2" });
      console.log("✓ Sent market summary");
    }

    saveLastSignals(
      watchlist.map((t) => ({
        symbol: t.symbol,
        entry: t.price,
        stop: parseFloat((t.price * 0.93).toFixed(6)),
        target: parseFloat((t.price * 1.2).toFixed(6)),
        outcome: null,
        returnPct: null,
      })),
    );
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    try {
      await bot.sendMessage(
        CHANNEL,
        `⚠️ *NarraPulse bot error:* ${e.message}`,
        { parse_mode: "MarkdownV2" },
      );
    } catch {}
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

// Lightweight check every hour — listings + metrics only, ~2 CMC credits
async function runLightCheck() {
  console.log(`\n[${new Date().toISOString()}] Light check...`);
  try {
    const [tokens, metrics] = await Promise.all([
      getMomentumTokens(),
      getMarketMetrics(),
    ]);

    const regime = detectRegime(metrics);
    const fg = computeSentiment(metrics, tokens);
    const maxPos = fg.gated
      ? 1
      : regime.risk === "HIGH"
        ? 5
        : regime.risk === "MED"
          ? 3
          : 2;
    const allocPct = fg.gated
      ? 10
      : regime.risk === "HIGH"
        ? 10
        : regime.risk === "MED"
          ? 15
          : 20;

    const btcToken = tokens.find((t) => t.symbol === "BTC");
    const btc24h = btcToken?.quote?.USD?.percent_change_24h || 0;

    const scored = tokens
      .map((t) => scoreToken(t, btc24h))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const topGainers = [...scored]
      .filter((t) => (t.c1 || 0) > 2)
      .sort((a, b) => (b.c1 || 0) - (a.c1 || 0))
      .slice(0, 5);
    topGainers.forEach((t) => {
      t.score += 2;
    });
    scored.sort((a, b) => b.score - a.score);

    // No category fetch — narrative stays 'Other' in light check
    const top20 = scored.slice(0, 20);

    const watchlist = top20
      .filter(
        (t) =>
          t.allPos &&
          t.divergence.signal === "CONFIRMED" &&
          t.narAge.age !== "EXHAUSTED" &&
          !t.pumpStatus.exitWarning,
      )
      .slice(0, maxPos);

    const currentSymbols = watchlist.map((t) => t.symbol);
    const lastSignals = loadLastSignals();
    const lastSymbols = lastSignals.map((s) => s.symbol);

    const newSignals = watchlist.filter((t) => !lastSymbols.includes(t.symbol));
    const closedSymbols = lastSymbols.filter(
      (s) => !currentSymbols.includes(s),
    );

    // WATCH list — tokens ranked 11-20 that pass quality filters
    const watchOnly = top20
      .slice(10)
      .filter(
        (t) =>
          t.allPos &&
          t.divergence.signal === "CONFIRMED" &&
          !t.pumpStatus.exitWarning,
      )
      .slice(0, 3);

    console.log(
      `Light: ${regime.regime} | New: ${newSignals.map((t) => t.symbol).join(",") || "none"} | Watch: ${watchOnly.map((t) => t.symbol).join(",") || "none"}`,
    );

    // Send new signals immediately
    for (const t of newSignals) {
      const msg = formatNewSignal(t, regime, fg, allocPct);
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      await postSignalOpen({
        symbol: t.symbol,
        narrativeAge: t.narAge.age,
        narrative: t.narrative,
        entry: t.price,
        stop: parseFloat((t.price * 0.93).toFixed(6)),
        target: parseFloat((t.price * 1.2).toFixed(6)),
        score: t.score,
        regime: regime.regime,
        sentiment: fg.label,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    // Send close alerts
    for (const symbol of closedSymbols) {
      const last = lastSignals.find((s) => s.symbol === symbol);
      const msg = formatCloseAlert(
        symbol,
        last?.outcome || "CLOSED",
        last?.returnPct || 0,
      );
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      await new Promise((r) => setTimeout(r, 500));
    }

    // Send WATCH alert if new tokens appear in watch zone
    if (watchOnly.length > 0) {
      const lastWatchSymbols = loadLastSignals()._watch || [];
      const newWatches = watchOnly.filter(
        (t) => !lastWatchSymbols.includes(t.symbol),
      );
      if (newWatches.length > 0) {
        const watchMsg = `👁 *WATCH LIST — NarraPulse*\n\n${newWatches
          .map(
            (t) =>
              `\\[${escMD(t.narAge.label)}\\] *${escMD(t.symbol)}* — ${escMD((t.c24 >= 0 ? "+" : "") + t.c24.toFixed(2) + "%")} 24h · score ${t.score}`,
          )
          .join(
            "\n",
          )}\n\n_Ranked 11\\-20 in momentum\\. Not yet actionable — monitor for entry\\._`;
        await bot.sendMessage(CHANNEL, watchMsg, { parse_mode: "MarkdownV2" });
      }
    }

    // Save state
    const stateToSave = watchlist.map((t) => ({
      symbol: t.symbol,
      entry: t.price,
      stop: parseFloat((t.price * 0.93).toFixed(6)),
      target: parseFloat((t.price * 1.2).toFixed(6)),
      outcome: null,
      returnPct: null,
    }));
    stateToSave._watch = watchOnly.map((t) => t.symbol);
    saveLastSignals(stateToSave);
  } catch (e) {
    console.error(`[LIGHT ERROR] ${e.message}`);
  }
}

// Full check every 4 hours — includes category fetch and market summary
async function runCheck() {
  console.log(`\n[${new Date().toISOString()}] Full check...`);
  try {
    const [tokens, metrics] = await Promise.all([
      getMomentumTokens(),
      getMarketMetrics(),
    ]);

    const regime = detectRegime(metrics);
    const fg = computeSentiment(metrics, tokens);
    const maxPos = fg.gated
      ? 1
      : regime.risk === "HIGH"
        ? 5
        : regime.risk === "MED"
          ? 3
          : 2;
    const allocPct = fg.gated
      ? 10
      : regime.risk === "HIGH"
        ? 10
        : regime.risk === "MED"
          ? 15
          : 20;

    const btcToken = tokens.find((t) => t.symbol === "BTC");
    const btc24h = btcToken?.quote?.USD?.percent_change_24h || 0;

    const scored = tokens
      .map((t) => scoreToken(t, btc24h))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const topGainers = [...scored]
      .filter((t) => (t.c1 || 0) > 2)
      .sort((a, b) => (b.c1 || 0) - (a.c1 || 0))
      .slice(0, 5);
    topGainers.forEach((t) => {
      t.score += 2;
    });
    scored.sort((a, b) => b.score - a.score);

    const top20 = scored.slice(0, 20);
    const ids = top20.map((t) => t.id).filter(Boolean);
    const catData = await getTokenCategories(ids);
    top20.forEach((t) => {
      t.narrative = classifyNarrative(catData[t.id]?.tags || []);
    });

    const narrativeMap = {};
    top20.forEach((t) => {
      if (!narrativeMap[t.narrative])
        narrativeMap[t.narrative] = { syms: [], total: 0 };
      narrativeMap[t.narrative].syms.push(t.symbol);
      narrativeMap[t.narrative].total += t.score;
    });
    const hotNarrative =
      Object.entries(narrativeMap)
        .map(([name, d]) => ({ name, avg: d.total / d.syms.length }))
        .sort((a, b) => b.avg - a.avg)[0]?.name || "Unknown";

    const watchlist = top20
      .filter(
        (t) =>
          t.allPos &&
          t.divergence.signal === "CONFIRMED" &&
          t.narAge.age !== "EXHAUSTED" &&
          !t.pumpStatus.exitWarning,
      )
      .slice(0, maxPos);

    const currentSymbols = watchlist.map((t) => t.symbol);
    const lastSignals = loadLastSignals();
    const lastSymbols = Array.isArray(lastSignals)
      ? lastSignals.map((s) => s.symbol)
      : lastSignals.map?.((s) => s.symbol) || [];

    const newSignals = watchlist.filter((t) => !lastSymbols.includes(t.symbol));
    const closedSymbols = lastSymbols.filter(
      (s) => !currentSymbols.includes(s),
    );

    console.log(`Full: ${regime.regime} | Sentiment: ${fg.label}`);
    console.log(`Watchlist: ${currentSymbols.join(", ") || "empty"}`);
    console.log(`New: ${newSignals.map((t) => t.symbol).join(", ") || "none"}`);

    for (const t of newSignals) {
      const msg = formatNewSignal(t, regime, fg, allocPct);
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      await postSignalOpen({
        symbol: t.symbol,
        narrativeAge: t.narAge.age,
        narrative: t.narrative,
        entry: t.price,
        stop: parseFloat((t.price * 0.93).toFixed(6)),
        target: parseFloat((t.price * 1.2).toFixed(6)),
        score: t.score,
        regime: regime.regime,
        sentiment: fg.label,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const symbol of closedSymbols) {
      const last = Array.isArray(lastSignals)
        ? lastSignals.find((s) => s.symbol === symbol)
        : null;
      const msg = formatCloseAlert(
        symbol,
        last?.outcome || "CLOSED",
        last?.returnPct || 0,
      );
      await bot.sendMessage(CHANNEL, msg, { parse_mode: "MarkdownV2" });
      await new Promise((r) => setTimeout(r, 500));
    }

    if (newSignals.length === 0 && closedSymbols.length === 0) {
      const summary = formatMarketSummary(
        regime,
        fg,
        hotNarrative,
        watchlist.length,
      );
      await bot.sendMessage(CHANNEL, summary, { parse_mode: "MarkdownV2" });
    }

    saveLastSignals(
      watchlist.map((t) => ({
        symbol: t.symbol,
        entry: t.price,
        stop: parseFloat((t.price * 0.93).toFixed(6)),
        target: parseFloat((t.price * 1.2).toFixed(6)),
        outcome: null,
        returnPct: null,
      })),
    );
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    try {
      await bot.sendMessage(
        CHANNEL,
        `⚠️ *NarraPulse error:* ${escMD(e.message)}`,
        { parse_mode: "MarkdownV2" },
      );
    } catch {}
  }
}

// 1-hour lightweight signal scan
cron.schedule("0 * * * *", runLightCheck);

// 4-hour full check with market summary
cron.schedule("0 */4 * * *", runCheck);

// Run full check on startup
runCheck();
console.log(
  "NarraPulse bot started — light check every hour, full check every 4 hours",
);
