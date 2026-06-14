# NarraPulse — BSC Narrative Momentum Strategy Skill

> *Built for BSC retail traders who keep buying narrative tops and missing exits.*

## Overview

NarraPulse is a CoinMarketCap Skill that detects early narrative momentum across the top 200 tokens by market cap, filters for quality and sentiment, and outputs a structured, backtestable trading strategy spec.

It was built to solve two real trader problems:
1. **Buying narrative tops** — getting in after social media hype peaks, immediately down 30%
2. **Not knowing when to exit pumps** — holding through the dump because there was no exit signal

NarraPulse addresses both with a multi-layer signal pipeline built entirely on CMC data.

---

## CMC Endpoints Used

| Endpoint | Purpose |
|---|---|
| `/v1/cryptocurrency/listings/latest` | Token price, volume, % changes, market cap |
| `/v1/global-metrics/quotes/latest` | BTC dominance, market cap, Fear & Greed Index |
| `/v2/cryptocurrency/info` | Token tags for narrative classification |
| `/v1/cryptocurrency/categories` | Official CMC category momentum (authoritative narrative ranking) |

---

## Strategy Pipeline

```
1. Market Regime Detection
        ↓
2. Fear & Greed Sentiment Gate
        ↓
3. Universe Filtering (quality filters)
        ↓
4. Momentum Scoring
        ↓
5. Volume Divergence Filter
        ↓
6. Narrative Age Detection  ← solves Problem 1 (buying tops)
        ↓
7. Pump Exhaustion Detection ← solves Problem 2 (missing exits)
        ↓
8. CMC Official Category Cross-reference
        ↓
9. Watchlist Output
```

---

## Step-by-Step Logic

### Step 1 — Market Regime Detection
Call `/v1/global-metrics/quotes/latest`. Classify by BTC dominance:

| BTC Dominance | Regime | Risk | Max Positions | Allocation |
|---|---|---|---|---|
| > 58% | BTC_DOMINANCE | LOW | 2 | 20% each |
| 50–58%, vol/mcap > 0.05 | ACTIVE | MED | 3 | 15% each |
| 50–58%, vol/mcap ≤ 0.05 | QUIET | LOW | 2 | 20% each |
| < 50% | ALTSEASON | HIGH | 5 | 10% each |

---

### Step 2 — Fear & Greed Sentiment Gate
Parsed from the same `/v1/global-metrics/quotes/latest` call.

| F&G Value | Classification | Effect |
|---|---|---|
| 0–25 | EXTREME FEAR | Max 1 position, 10% only |
| 26–45 | FEAR | Normal sizing, tighten stops |
| 46–55 | NEUTRAL | Standard sizing |
| 56–75 | GREED | Standard sizing, watch exits |
| 76–100 | EXTREME GREED | Max 1 position, 10% only |

Extreme sentiment in either direction reduces position sizing — markets at extremes are more likely to reverse.

---

### Step 3 — Universe Filtering
Call `/v1/cryptocurrency/listings/latest?limit=200&sort=market_cap`.

Quality filters applied:
- Market cap ≥ $50M (eliminates micro-caps)
- 24h volume ≥ $5M (eliminates illiquid tokens)
- Price > $0.001 (eliminates dust tokens)
- Price not in $0.99–$1.01 range with <1% 7d change (eliminates stablecoins)

---

### Step 4 — Momentum Scoring

```
+4  All timeframes positive (1h > 0 AND 24h > 0 AND 7d > 0)
+1  24h change > 3%
+2  24h change > 8%
+1  24h change > 20%
+1  7d change > 5%
+2  7d change > 20%
+1  Vol/MCap ratio > 0.10
+2  Vol/MCap ratio > 0.25
+1  Vol/MCap ratio > 0.50
×   Multiply total by volume trend multiplier (see Step 5)
-4  24h change > 80%       (pump-and-dump filter)
-3  7d change > 200%       (parabolic extension filter)
-2  Vol/MCap > 2.0         (wash trading filter)
+   Narrative age bonus/penalty applied last (see Step 6)
```

---

### Step 5 — Volume Divergence Filter

Volume trend is derived from `volume_change_24h`:

| Volume Change | Trend | Score Multiplier |
|---|---|---|
| > 20% | SURGING | 1.0× |
| 0–20% | RISING | 1.0× |
| -20–0% | FADING | 0.5× |
| < -20% | COLLAPSING | 0.0× |

Divergence signal (price vs volume direction):

| Price | Volume | Signal |
|---|---|---|
| ↑ | SURGING/RISING | ✓ CONFIRMED — proceed |
| ↑ | FADING | ⚠ WEAK — reduce size |
| ↑ | COLLAPSING | ✗ DIVERGING — skip |
| ↓ | any | — NO SIGNAL |

Only CONFIRMED signals are eligible for the watchlist.

**Why this matters:** Price moves without volume are unsustained. A token up 15% on falling volume is likely a thin-order-book move that reverses quickly.

---

### Step 6 — Narrative Age Detection

Uses `percent_change_7d` and `percent_change_30d` to classify where the token is in its narrative cycle:

| Condition | Age | Score Adj | Meaning |
|---|---|---|---|
| 7d > 10% AND 30d < 20% | 🟢 EARLY | +3 | Narrative just waking up — get in before the crowd |
| 7d > 10% AND 30d > 20% AND 24h > 0 | 🟡 PRIME | +1 | Narrative running strong, still has legs |
| 30d > 40% AND 7d < 30d/4 | 🟠 LATE | -1 | Narrative fading, momentum decelerating |
| 30d > 80% AND 24h < 5% AND 1h < 1% | 🔴 EXHAUSTED | -3 | Narrative played out — excluded from watchlist |
| Default | ⚪ MID | 0 | Mid-cycle, no strong signal either way |

EXHAUSTED tokens are excluded from the watchlist entirely regardless of other signals.

**Why this matters:** This directly solves the "buying the top" problem. Most retail traders enter a narrative after it trends on social media — which is LATE or EXHAUSTED. NarraPulse flags tokens where the narrative is mathematically early, before mainstream attention arrives.

---

### Step 7 — Pump Exhaustion Detection

Applied to any token with 24h gain > 20%:

```
Hourly pace = percent_change_1h × 24
Pump slowing = hourly pace < 50% of 24h pace

If pump slowing AND volume still high (volChange > 30%):  ⚠ EXIT SOON
If pump slowing AND volume also fading:                   🚨 EXIT NOW
If pump still accelerating:                               ✓ STILL RUNNING
```

**Why this matters:** Pumps don't announce their top. This detects when price is still elevated but momentum is losing fuel — giving traders an actionable exit cue instead of holding through the dump.

---

### Step 8 — CMC Official Category Cross-reference

Call `/v1/cryptocurrency/categories?limit=50`. Filter for categories with market cap > $100M.

Sort by `avg_price_change` (24h) to find which official CMC narrative categories are outperforming.

Cross-reference against our internal narrative heat map — if they agree, signal confidence is higher. If they diverge, flag for manual review.

---

### Step 9 — Watchlist Output

A token enters the watchlist only if ALL of the following are true:
- `allPos = true` (1h, 24h, 7d all positive)
- `divergence.signal = CONFIRMED` (price + volume both rising)
- `narAge.age ≠ EXHAUSTED` (narrative not played out)

For each watchlist token:
```
Entry:       current price
Stop loss:   entry × 0.93   (7% max loss)
Take profit: entry × 1.20   (20% target)
Allocation:  regime + sentiment adjusted % of portfolio
Hold period: up to 7 days or until stop/target hit
```

---

## Backtest Results
*Run: June 14, 2026 | Universe: top 200 by market cap | Lookback: 7-day proxy*

| Metric | Value |
|---|---|
| Universe | 200 tokens |
| Qualified (passed filters) | 173 |
| Signals generated | 10 |
| Win rate | 100% |
| Average return | +10.01% |
| Trades hitting +20% target | 2 |
| Trades stopped out (-7%) | 0 |

### Trade Log

| Symbol | Entry | Exit | Return | Outcome |
|---|---|---|---|---|
| SKYAI | $0.280 | $0.366 | +30.8% | TARGET HIT |
| RIF | $0.066 | $0.100 | +50.8% | TARGET HIT |
| WLD | $0.419 | $0.502 | +19.7% | Open |
| LIT | $1.416 | $1.602 | +13.1% | Open |
| NEAR | $1.892 | $2.115 | +11.8% | Open |
| SOON | $0.168 | $0.178 | +6.3% | Open |
| HYPE | $58.72 | $61.18 | +4.2% | Open |
| FET | $0.206 | $0.212 | +2.7% | Open |

---

## Live Output Example
*Captured June 14, 2026 — BTC_DOMINANCE regime, NEUTRAL sentiment*

```
=== MARKET REGIME ===
Regime : BTC_DOMINANCE | Risk: LOW
BTC Dom: 58.7% | MCap: $2.19T | Vol: $45.9B
Sentiment: ⚪ NEUTRAL (unavailable)

=== CMC OFFICIAL CATEGORY MOMENTUM ===
Generative AI     +2.01% | $5.7B mcap
X Layer Ecosystem +0.95% | $1.6B mcap
xStocks Ecosystem +0.71% | $5.6B mcap

=== NARRATIVE HEAT MAP ===
Other  | AKT, JASMY, KAITO  | avg score 8.5  🔥
Meme   | BANANAS31           | avg score 8.0
DeFi   | PYTH, ATOM, GENIUS  | avg score 7.4

=== STRATEGY OUTPUT ===
Regime: BTC_DOMINANCE → Max 2 positions, 20% each

Watchlist:
1. AKT  [🟢 EARLY] Entry: $0.765 | Stop: $0.712 | Target: $0.919 | Score: 11
2. PYTH [🟢 EARLY] Entry: $0.038 | Stop: $0.035 | Target: $0.046 | Score: 10
```

---

## Setup & Usage

### Prerequisites
- Node.js v18+
- CoinMarketCap API key (Basic tier or above)

### Install
```bash
git clone https://github.com/YOUR_USERNAME/narrapulse
cd narrapulse
npm install
echo "CMC_API_KEY=your_key_here" > .env
```

### Run live signals
```bash
node fetch.js
```

### Run backtest
```bash
node backtest.js
# Outputs backtest_results.csv
```

### Demo site
Open `index.html` via the local server:
```bash
node server.js
# Visit http://localhost:3000
```

---

## CMC Agent Hub Compatibility

NarraPulse is compatible with the CMC Agent Hub MCP server. To invoke via MCP:

1. Connect to the CMC MCP endpoint
2. Call `get_listings_latest` with `limit=200&sort=market_cap`
3. Call `get_global_metrics` (extracts regime + Fear & Greed in one call)
4. Call `get_cryptocurrency_info` on top 10 token IDs for tags
5. Call `get_categories` for official narrative momentum
6. Apply scoring, filtering, and output the watchlist spec above

---

## Risk Disclaimer

NarraPulse outputs a strategy specification for research and backtesting purposes only. It does not constitute financial advice. Past backtest performance does not guarantee future results. Always apply your own risk management before executing any trade.