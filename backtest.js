import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
dotenv.config();

const API_KEY = process.env.CMC_API_KEY;
const BASE = 'https://pro-api.coinmarketcap.com';
const headers = { 'X-CMC_PRO_API_KEY': API_KEY, 'Accept': 'application/json' };

// Simulate the strategy on historical snapshots using price % changes
// We'll use the 7d, 30d changes available in the listings endpoint as proxies
async function getHistoricalProxy() {
  const url = `${BASE}/v1/cryptocurrency/listings/latest?limit=200&convert=USD&sort=market_cap`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data || [];
}

function passesFilter(token) {
  const q = token.quote.USD;
  if (!q.market_cap || q.market_cap < 50_000_000) return false;
  if (!q.volume_24h  || q.volume_24h  < 5_000_000)  return false;
  if (!q.price || q.price <= 0) return false;
  return true;
}

function wasAllGreen7dAgo(token) {
  const q = token.quote.USD;
  // If 7d change is positive AND 30d change is positive,
  // the token was likely in uptrend a week ago too (conservative proxy)
  return (
    q.percent_change_7d  > 0 &&
    q.percent_change_30d > 0 &&
    q.percent_change_24h > 0
  );
}

function simulateTrade(token) {
  const q = token.quote.USD;
  // Entry price proxy: current price minus 7d gain
  const change7d = q.percent_change_7d / 100;
  const entryPrice = q.price / (1 + change7d);
  const exitPrice  = q.price; // current price = exit after 7 days

  const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;

  // Apply strategy rules: 7% stop, 20% target
  let outcome;
  let actualReturn;
  if (returnPct <= -7) {
    outcome = 'STOPPED_OUT';
    actualReturn = -7;
  } else if (returnPct >= 20) {
    outcome = 'TARGET_HIT';
    actualReturn = 20;
  } else {
    outcome = 'OPEN';
    actualReturn = returnPct;
  }

  return {
    symbol: token.symbol,
    entryPrice: entryPrice.toFixed(6),
    exitPrice: exitPrice.toFixed(6),
    rawReturn: returnPct.toFixed(2),
    actualReturn: actualReturn.toFixed(2),
    outcome
  };
}

async function main() {
  console.log('Running backtest (7-day lookback proxy)...\n');

  const tokens = await getHistoricalProxy();
  const qualified = tokens.filter(passesFilter);
  const signals   = qualified.filter(wasAllGreen7dAgo);

  console.log(`Universe : ${tokens.length} tokens`);
  console.log(`Qualified: ${qualified.length} (passed quality filters)`);
  console.log(`Signals  : ${signals.length} (all-green 7d ago)\n`);

  const trades = signals.map(t => ({ ...simulateTrade(t), marketCap: t.quote.USD.market_cap }));

  // Stats
  const winners  = trades.filter(t => parseFloat(t.actualReturn) > 0);
  const losers   = trades.filter(t => parseFloat(t.actualReturn) < 0);
  const stopped  = trades.filter(t => t.outcome === 'STOPPED_OUT');
  const targeted = trades.filter(t => t.outcome === 'TARGET_HIT');
  const avgReturn = trades.reduce((s, t) => s + parseFloat(t.actualReturn), 0) / trades.length;
  const winRate  = (winners.length / trades.length * 100).toFixed(1);

  console.log('=== BACKTEST RESULTS ===');
  console.log(`Trades      : ${trades.length}`);
  console.log(`Win rate    : ${winRate}%`);
  console.log(`Avg return  : ${avgReturn.toFixed(2)}%`);
  console.log(`Target hit  : ${targeted.length} trades (+20%)`);
  console.log(`Stopped out : ${stopped.length} trades (-7%)`);
  console.log(`Open/partial: ${trades.length - targeted.length - stopped.length} trades\n`);

  console.log('=== TRADE LOG ===');
  console.log('Symbol     | Entry       | Exit        | Raw%   | Actual% | Outcome');
  console.log('-----------|-------------|-------------|--------|---------|----------');
  trades
    .sort((a, b) => parseFloat(b.actualReturn) - parseFloat(a.actualReturn))
    .forEach(t => {
      console.log(
        `${t.symbol.padEnd(10)} | $${t.entryPrice.padStart(11)} | $${t.exitPrice.padStart(11)} | ${t.rawReturn.padStart(6)}% | ${t.actualReturn.padStart(7)}% | ${t.outcome}`
      );
    });

  // Export CSV
  const csv = [
    'symbol,entry_price,exit_price,raw_return_pct,actual_return_pct,outcome',
    ...trades.map(t => `${t.symbol},${t.entryPrice},${t.exitPrice},${t.rawReturn},${t.actualReturn},${t.outcome}`)
  ].join('\n');

  fs.writeFileSync('backtest_results.csv', csv);
  console.log('\n✓ Results saved to backtest_results.csv');
}

main().catch(console.error);