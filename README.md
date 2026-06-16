# NarraPulse

> *A CMC Strategy Skill that detects early narrative momentum on BSC — so you buy before the crowd, not after.*

**Live demo:** https://narrapulse.vercel.app — no API key required  
**Built for:** [BNB HACK: AI Trading Agent Edition](https://dorahacks.io/hackathon/bnbhack-twt-cmc/) — Track 2: Strategy Skills

---

## The Problem

Most BSC traders lose money in two predictable ways:

1. **Buying narrative tops** — you see everyone talking about an AI token, you buy in, and you're immediately down 30% because the narrative peaked two weeks ago
2. **Not knowing when to exit pumps** — a token is up 80%, you jump in, it keeps going briefly, then dumps. You held too long because there was no exit signal

NarraPulse solves both with a 9-layer signal pipeline built entirely on CoinMarketCap data.

---

## How It Works

```
1. Market Regime Detection       — BTC dominance + vol/mcap → macro environment
2. Sentiment Gate                — Live composite score from breadth + BTC dom + volume conviction
3. Universe Filtering            — Quality filters: mcap > $50M, vol > $5M, no dust/stables
4. Momentum Scoring              — Multi-timeframe scoring across 1h, 24h, 7d + vol/mcap ratios
5. Volume Divergence Filter      — Only CONFIRMED signals (price ↑ + volume ↑) proceed
6. Narrative Age Detection       — EARLY / PRIME / LATE / EXHAUSTED classification
7. Pump Exhaustion Detection     — Flags when momentum is slowing on a running pump
8. CMC Category Cross-reference  — Official CMC category momentum vs internal heat map
9. Watchlist Output              — Entry, stop (-7%), target (+20%), allocation per regime
```

---

## CMC Endpoints Used

| Endpoint | Purpose |
|---|---|
| `/v1/cryptocurrency/listings/latest` | Price, volume, % changes, market cap |
| `/v1/global-metrics/quotes/latest` | BTC dominance, market cap, sentiment inputs |
| `/v2/cryptocurrency/info` | Token tags for narrative classification |
| `/v1/cryptocurrency/categories` | Official CMC narrative category momentum |

---

## Narrative Age Detection

The core insight behind NarraPulse. Uses `percent_change_7d` vs `percent_change_30d` to classify each token's narrative cycle:

| Signal | Age | Score Adj | What It Means |
|---|---|---|---|
| 7d > 10% AND 30d < 20% | 🟢 EARLY | +3 | Narrative just waking up — before the crowd |
| 7d > 10% AND 30d > 20% AND 24h > 0 | 🟡 PRIME | +1 | Running strong, still has legs |
| 30d > 40% AND 7d < 30d/4 | 🟠 LATE | -1 | Fading, momentum decelerating |
| 30d > 80% AND 24h < 5% AND 1h < 1% | 🔴 EXHAUSTED | -3 | Played out — excluded from watchlist |

EXHAUSTED tokens never appear on the watchlist. EARLY tokens require a higher pump threshold (40% vs 20%) before exhaustion fires — preventing the conflicting "buy early / exit now" signal.

---

## Sentiment Composite

Since CMC's Fear & Greed Index isn't available on the basic tier, NarraPulse computes its own sentiment score from three signals already in the data:

```
Breadth score    (50%) — % of qualified tokens with positive 24h change
BTC dom score    (30%) — higher dominance = risk-off = bearish for alts
Vol/MCap score   (20%) — higher ratio = more market conviction

Composite = (breadth × 0.5) + (btcDom × 0.3) + (vol × 0.2)
```

Extreme sentiment (score ≤ 20 or ≥ 81) reduces max positions to 1 and allocation to 10%.

---

## Backtest Results

*Multi-window live backtest · top 200 tokens by market cap · 3 time windows · recalculates on every refresh*

| Window | Win Rate | Avg Return |
|---|---|---|
| 1d → 7d | ~87% | +5.9% |
| 7d → 30d | ~15% | -3.6% |
| 30d → 60d | ~100% | +17.9% |
| **Overall (~270 trades)** | **~56%** | **+2.7%** |

**Expectancy: ~+1.5% per trade**

By narrative age:
- 🟢 EARLY signals: ~62% win rate, +6.5% avg
- 🟡 PRIME signals: ~100% win rate, +19% avg

The 7d→30d window is intentionally weak — this is the "mid-narrative chop" zone that NarraPulse's EARLY/PRIME filters are designed to avoid.

---

## Setup

### Prerequisites
- Node.js v18+
- CoinMarketCap API key (Basic tier) — for local CLI use only

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

### Live demo
Visit **https://narrapulse.vercel.app** — no setup, no API key needed.  
The key is handled server-side via Vercel environment variables.

---

## Project Structure

```
narrapulse/
├── fetch.js          — live signal generator (CLI)
├── backtest.js       — multi-window backtest + CSV export
├── index.html        — live dashboard (served via Vercel)
├── api/
│   └── proxy.js      — serverless CMC proxy (Vercel)
├── server.local.js   — local dev server
└── skill.md          — CMC Skill specification
```

---

## Risk Disclaimer

NarraPulse outputs a strategy specification for research and informational purposes only. It does not constitute financial advice. Past backtest performance does not guarantee future results. Crypto assets are highly volatile — always apply your own risk management and never trade more than you can afford to lose.