// Dip-buying mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Idea: the 1-minute cbBTC tape is noisy and range-bound over a day, so chasing
// trends pays the 6 bps round-trip cost on every whipsaw. Instead this bot only
// buys a sharp intraday dip and only sells into strength, and otherwise sits in
// cash. One symbol, one position, no leverage, no shorts, fully deterministic.
//
// Signal: Wilder's RSI over the last 21 closes.
//   - RSI < 30  -> oversold dip: buy with all available cash (capped by the
//     hello weight cap, and never below the minimum notional).
//   - RSI > 75  -> overbought: sell the whole position.
//   - Stop-loss: sell the whole position if the close falls 2% below the close
//     at which the current position was opened (protects the live race from a
//     real breakdown; it never fired on the published dev window).
// Warm-up bars are used to build RSI history only; no order is sent while
// warming up. The replay flattens any open position at the end of the window.
//
// RSI is computed from close-to-close changes as plain numbers. Closes are
// ~1e10 raw units, far below 2^53, so the arithmetic is exact enough and, more
// importantly, identical on every run: no clock, no environment, no randomness.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const RSI_PERIOD = 21;
const RSI_BUY_BELOW = 30;
const RSI_SELL_ABOVE = 75;
// Sell if the close drops this far below the entry close (basis points).
const STOP_LOSS_BPS = 200;
const MAX_SLIPPAGE_BPS = 10_000;

// Rolling Wilder RSI state, updated once per bar from the latest close.
class RsiTracker {
  private previousClose: number | null = null;
  private averageGain = 0;
  private averageLoss = 0;
  private changesSeen = 0;

  /** Feed one close (raw units as a number). Returns the RSI, or null until seeded. */
  update(close: number): number | null {
    if (this.previousClose === null) {
      this.previousClose = close;
      return null;
    }
    const change = close - this.previousClose;
    this.previousClose = close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    this.changesSeen += 1;
    if (this.changesSeen <= RSI_PERIOD) {
      // Seed with the simple average of the first RSI_PERIOD changes.
      this.averageGain += gain / RSI_PERIOD;
      this.averageLoss += loss / RSI_PERIOD;
      if (this.changesSeen < RSI_PERIOD) return null;
    } else {
      // Wilder smoothing after seeding.
      this.averageGain = (this.averageGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      this.averageLoss = (this.averageLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    }
    if (this.averageLoss === 0) return this.averageGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + this.averageGain / this.averageLoss);
  }
}

const rsi = new RsiTracker();
// Close (raw units) at which the current position was opened; null when flat.
let entryClose: bigint | null = null;

function sellAll(state: BarsState): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (!held || held.qty === 0n) return [];
  entryClose = null;
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function buyAll(state: BarsState, close: bigint): OrderInput[] {
  const { caps, fees } = state.hello;
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const amount = state.cash < byWeight ? state.cash : byWeight;
  if (amount === 0n || amount < BigInt(fees.min_notional_quote_units)) return [];
  entryClose = close;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state, _batch) {
    if (state.warmingUp) {
      // Build history through the warm-up, but never trade on it.
      const warmClose = state.close(SYMBOL);
      if (warmClose !== null) rsi.update(Number(warmClose));
      return [];
    }
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const value = rsi.update(Number(close));
    if (value === null) return []; // RSI not seeded yet.
    const holding = state.positions.has(SYMBOL);
    if (holding) {
      const stopLine = entryClose !== null ? (entryClose * BigInt(10_000 - STOP_LOSS_BPS)) / 10_000n : null;
      if (value > RSI_SELL_ABOVE || (stopLine !== null && close < stopLine)) {
        return sellAll(state);
      }
      return [];
    }
    if (value < RSI_BUY_BELOW) return buyAll(state, close);
    return [];
  },
});
