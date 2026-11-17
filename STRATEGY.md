# Strategy — btc-race-24h-20261117-0603

## Idea

Dip-buying mean reversion on 1-minute cbBTC bars. The dev window is choppy and
range-bound, so trend-following systems lose money to the 4 bps fee + 2 bps
slippage (+ price impact) on every whipsaw. This bot trades rarely: it buys
only a sharp oversold dip and sells only into strength, and otherwise holds
cash.

## Rules

- Signal: Wilder's RSI(21) on closes.
  - RSI < 30 → buy with all cash (capped by the hello weight cap, min notional respected).
  - RSI > 75 → sell the whole position.
  - Stop-loss: sell if the close falls 2% below the entry close.
- One symbol (CBBTC), one position, long only, no leverage.
- Warm-up bars build RSI history only; no orders while warming up.
- Fully deterministic: no clock, no environment, no randomness.

## Dev-window check (offline, before grading)

Offline replay of the published 1440-bar dev window with the same 6 bps
round-trip cost model gave roughly +$15.7 net on $1,000 (7 trades), versus
about +$2.2 for buy-and-hold and losses for EMA-cross / momentum variants.
The stop-loss never fired on the dev window. The authoritative figure is the
kit's `grade-local` result, reported in REPORT.md.
