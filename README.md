# NarraPulse — BSC Narrative Momentum Strategy Skill

> *Built for BSC retail traders who keep buying narrative tops and missing exits.*

**[Live demo →](https://narrapulse.vercel.app)** *(no API key required, hit "Run signals")*

NarraPulse scans the top 200 tokens by market cap, scores them on momentum and narrative timing, and tells you which ones are early, which are about to top, and which to skip — built entirely on free-tier CoinMarketCap data.

It solves two problems most retail traders hit on repeat:
1. **Buying narrative tops** — getting in after social media hype peaks, immediately down 30%
2. **Not knowing when to exit pumps** — holding through the dump because there was no exit signal

### What it looks like running
*Captured June 15, 2026 — BTC_DOMINANCE regime, NEUTRAL sentiment*

```
=== MARKET REGIME ===
Regime : BTC_DOMINANCE | Risk: LOW
BTC Dom: 58.4% | MCap: $2.28T | Vol: $99.4B
Sentiment: ⚪ NEUTRAL (51/100) — Breadth: 54% · BTC score: 47 · Vol score: 48

=== CMC OFFICIAL CATEGORY MOMENTUM ===
🔥 Celo Ecosystem   +9.05% | $12.5B mcap
Perpetuals          +8.96% | $21.5B mcap
X Layer Ecosystem   +8.94% | $1.6B mcap

=== NARRATIVE HEAT MAP ===
DeFi   | JTO, ZRO, AERO      | avg score 13.3  🔥
Other  | FARTCOIN, XPL, GRASS | avg score 11.2
L1     | ZEC, XMR             | avg score 9.0

=== STRATEGY OUTPUT ===
Regime: BTC_DOMINANCE → Max 2 positions, 20% each

Watchlist:
1. JTO      [🟡 PRIME] Entry: $0.7771 | Stop: $0.7227 | Target: $0.9325 | Score: 16 ⚠ EXIT SOON
2. FARTCOIN [🟢 EARLY] Entry: $0.1394 | Stop: $0.1296 | Target: $0.1673 | Score: 14
```

### What "Skill" means here
NarraPulse is structured as a **CoinMarketCap Skill**: a defined, repeatable pipeline of CMC API calls plus deterministic scoring logic that produces a structured trading strategy spec. It's runnable three ways — as a live web demo, as a local CLI (`fetch.js` / `backtest.js`), or invoked through the CMC Agent Hub MCP server (see [CMC Agent Hub Compatibility](#cmc-agent-hub-compatibility) below).

**GitHub:** https://github.com/Ji99y/narrapulse

---

## How It Works

NarraPulse addresses both problems above with a multi-layer signal pipeline built entirely on CMC data.

## CMC Endpoints Used

| Endpoint | Purpose |
|---|---|
| `/v1/cryptocurrency/listings/latest` | Token price, volume, % changes, market cap |
| `/v1/global-metrics/quotes/latest` | BTC dominance, market cap, sentiment composite inputs |
| `/v2/cryptocurrency/info` | Token tags for narrative classification |
| `/v1/cryptocurrency/categories` | Official CMC category momentum (authoritative narrative ranking) |

---

## Strategy Pipeline

```
1. Market Regime Detection
        ↓
2. Sentiment Composite Gate
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

### Step 2 — Sentiment Gate (CMC Composite)
Computed from the same `/v1/global-metrics/quotes/latest` call plus the listings data. No extra API credit used.

Rather than relying on a single Fear & Greed field (unavailable on basic tier), NarraPulse computes its own sentiment score from three CMC data signals:

| Signal | Weight | Source |
|---|---|---|
| Market breadth (% of qualified tokens with positive 24h change) | 50% | `/v1/cryptocurrency/listings/latest` |
| BTC dominance score (higher dominance = more bearish for alts) | 30% | `/v1/global-metrics/quotes/latest` |
| Volume/MCap conviction ratio | 20% | `/v1/global-metrics/quotes/latest` |

Combined into a 0–100 composite score:

| Score | Classification | Effect |
|---|---|---|
| 0–20 | 🔴 EXTREME FEAR | Max 1 position, 10% only |
| 21–40 | 🟠 FEAR | Normal sizing, tighten stops |
| 41–60 | ⚪ NEUTRAL | Standard sizing |
| 61–80 | 🟡 GREED | Standard sizing, watch exits |
| 81–100 | 🔴 EXTREME GREED | Max 1 position, 10% only |

Extreme sentiment in either direction reduces position sizing — markets at extremes are more likely to reverse.

---

### Step 3 — Universe Filtering
Call `/v1/cryptocurrency/listings/latest?limit=200&sort=market_cap`.

Quality filters applied:
- Market cap ≥ $30M (eliminates micro-caps)
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

Volume trend derived from `volume_change_24h`:

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

**Why this matters:** Most retail traders enter a narrative after it trends on social media — which is LATE or EXHAUSTED. NarraPulse flags tokens where the narrative is mathematically early, before mainstream attention arrives.

---

### Step 7 — Pump Exhaustion Detection

Applied to any token whose 24h gain exceeds an age-adjusted threshold:

```
Threshold = 40% if narAge = EARLY, else 20%

If 24h change <= Threshold:                                —  (no signal, score unaffected)

Hourly pace = percent_change_1h × 24
Pump slowing = hourly pace < 50% of 24h pace

If 24h change > Threshold:
  If pump slowing AND volume still high (volChange > 30%):  ⚠ EXIT SOON
  If pump slowing AND volume also fading:                   🚨 EXIT NOW
  If pump still accelerating:                               ✓ STILL RUNNING
```

**Why the EARLY threshold is higher:** Narrative Age (Step 6) and Pump Exhaustion look at different time windows — Age reads the 7d/30d trend, Exhaustion reads the 1h/24h trend — so without coordination a token could be tagged both 🟢 EARLY ("buy the story, it's just starting") and ⚠ EXIT SOON/🚨 EXIT NOW ("sell now, it's topping") in the same render. A single-day spike is expected chop for a narrative that's still early, so EARLY tokens get a higher bar (40% vs 20%) before a same-day spike is treated as exhaustion. This removes the contradictory pairing without touching how EXIT signals work for PRIME, LATE, or MID tokens.

**Why this matters:** Pumps don't announce their top. This detects when price is still elevated but momentum is losing fuel — giving traders an actionable exit cue instead of holding through the dump, without flagging normal early-narrative volatility as a false exit.

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
- `pumpStatus.warn = false` (not currently flagging EXIT SOON / EXIT NOW per Step 7)

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
*Illustrative only — see limitation below before reading these as validated performance*

⚠ **Methodology limitation:** CMC's listings endpoint only returns percent-change snapshots (1h/24h/7d/30d/60d), not a real historical price series. The backtest below reconstructs past prices algebraically from today's snapshot, which means the "entry signal" and the simulated "outcome" for a given window are derived from overlapping data rather than independent, time-separated observations. In practice this inflates the results below — a token that already rose over a window will tend to satisfy the entry filter for that same window by construction, regardless of whether the underlying strategy logic has any real predictive power. **Treat the numbers in this section as a worked example of the scoring methodology, not as evidence the pipeline has genuine edge.** A trustworthy backtest would need an actual historical OHLCV dataset with entry signals computed strictly before the outcome window — that's flagged as future work below.

*Snapshot: June 18, 2026 — figures recompute live on each refresh, these represent a single session*

| Metric | Value |
|---|---|
| Trades | 48 |
| Win Rate | 54.2% |
| Avg Return | +4.45% |
| Expectancy | +2.41% |

**Expectancy: +2.41% per trade** *(under this methodology — not a forward-looking guarantee, see limitation above)*

> Note: This recomputes live on every page refresh using current CMC data, so numbers vary slightly session to session. That variability reflects the input snapshot changing, not genuine out-of-sample validation.

### Results by Narrative Age
*June 18, 2026 snapshot*

| Age | Trades | Win Rate | Avg Return |
|---|---|---|---|
| 🟢 EARLY | 4 | 25.0% | -1.65% |
| 🟡 PRIME | 8 | 100.0% | +20.00% |

### Observations (not claims of edge)
In this June 18 snapshot, PRIME tokens dominate — 100% win rate, +20% avg return across 8 trades. EARLY shows a negative avg return (-1.65% across 4 trades), consistent with early-narrative chop where the move hasn't confirmed yet. Overall win rate of 54.2% with +2.41% expectancy across 48 trades.

The PRIME result in particular should be read as directionally interesting given the small sample and the look-ahead bias described above — not as proof that narrative-age detection adds measurable edge.

### Planned fix
Rebuilding this backtest against real historical OHLCV data (rather than algebraically reconstructed prices) is the top priority follow-up, so entry signals and outcomes are genuinely time-separated.

---

## Setup & Usage

### Prerequisites
- Node.js v18+
- CoinMarketCap API key (Basic tier or above) — for running `fetch.js` and `backtest.js` locally

### Install
```bash
git clone https://github.com/Ji99y/narrapulse
cd narrapulse
npm install
echo "CMC_API_KEY=your_key_here" > .env
```

### Run live signals (CLI)
```bash
node fetch.js
```

### Run backtest (CLI)
```bash
node backtest.js
# Outputs backtest_results.csv
```

### Live demo (no API key needed)
Visit **https://narrapulse.vercel.app** and hit Run signals.  
The API key is handled server-side — zero setup for any user.

---

## CMC Agent Hub Compatibility

NarraPulse is compatible with the CMC Agent Hub MCP server. To invoke via MCP:

1. Connect to the CMC MCP endpoint
2. Call `get_listings_latest` with `limit=200&sort=market_cap`
3. Call `get_global_metrics` (extracts regime + sentiment composite inputs in one call)
4. Call `get_cryptocurrency_info` on top 10 token IDs for tags
5. Call `get_categories` for official narrative momentum
6. Apply scoring, filtering, and output the watchlist spec above

---

## Risk Disclaimer

NarraPulse outputs a strategy specification for research and informational purposes only. It does not constitute financial advice. Always apply your own risk management.