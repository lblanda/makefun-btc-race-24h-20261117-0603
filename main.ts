// BTC mean-reversion bot for make.fun's btc-race-24h-20261117-0603.
// Trades Coinbase Wrapped BTC (CBBTC) against USDC on 1-minute bars, long only.
//
// Strategy (found by offline analysis of the published 24h dev window, then
// verified with the kit's grade-local): BTC on this pool spends most of its
// time ranging, and 1-minute noise (about 6 bps per bar) plus a ~26 bps
// round-trip cost kills every fast strategy we tried (EMA crosses 8/21
// through 55/144 all lost $22-$164 on the dev window; buy-and-hold made
// only +$1.07). What survives is a slow mean-reversion fade:
//   - buy, full size, when the close prints below the lowest low of the
//     previous 240 bars (a 4-hour extreme), and
//   - sell the whole position when the close prints above the highest high
//     of the previous 240 bars, or when it falls 1.2% below the entry
//     close (stop-loss, caps catching a falling knife in a trending-down
//     window; it never fired on the dev window).
// On the dev window that made +$6.49 net (3 trades, max drawdown -0.90%);
// the same family is positive for N = 180..360 (+$6.49..+$12.03), so the
// result is not a knife-edge parameter pick. Few trades, wide thresholds,
// tiny drawdown: it banks the range swings and sits in cash otherwise.
//
// All comparisons are exact bigint arithmetic on the bars' integer prices
// (price_scale 5), so the two graded executions produce identical orders.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 240;
const STOP_BPS = 120; // 1.2% below the entry close
const MAX_SLIPPAGE_BPS = 100;

const lows: bigint[] = [];
const highs: bigint[] = [];
let entryClose: bigint | null = null;

function minBig(a: bigint[]): bigint | null {
  let m: bigint | null = null;
  for (const x of a) if (m === null || x < m) m = x;
  return m;
}

function maxBig(a: bigint[]): bigint | null {
  let m: bigint | null = null;
  for (const x of a) if (m === null || x > m) m = x;
  return m;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (bar === undefined) return [];
    if (state.warmingUp) {
      lows.push(BigInt(bar.l));
      highs.push(BigInt(bar.h));
      if (lows.length > LOOKBACK) lows.shift();
      if (highs.length > LOOKBACK) highs.shift();
      return [];
    }
    const close = BigInt(bar.c);
    const held = state.positions.get('CBBTC');
    let orders: OrderInput[] = [];
    if (held === undefined) {
      // Buy only once we have a full lookback of history behind us.
      const low = minBig(lows);
      if (lows.length >= LOOKBACK && low !== null && close < low) {
        entryClose = close;
        orders = [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    } else if (entryClose !== null) {
      const stopPrice = (entryClose * BigInt(10000 - STOP_BPS)) / 10000n;
      const high = maxBig(highs);
      if ((high !== null && close > high) || close < stopPrice) {
        orders = [{ side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        entryClose = null;
      }
    }
    // Record this bar for the next decision (history is the previous bars).
    lows.push(BigInt(bar.l));
    highs.push(BigInt(bar.h));
    if (lows.length > LOOKBACK) lows.shift();
    if (highs.length > LOOKBACK) highs.shift();
    return orders;
  },
});
