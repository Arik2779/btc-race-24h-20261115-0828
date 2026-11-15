// Oversold-reversal bot for cbBTC/USDC, protocol agent-fun/bars-replay/v1.
//
// Strategy (long-only, one position, full-size entries):
//   * Entry on a bar's close when the market has fallen hard over the last
//     2 hours (close 1.5%+ below the close 120 bars ago), has ALSO fallen
//     steeply in the last hour (close 1.5%+ below the close 60 bars ago),
//     AND is snapping back (close 0.5%+ above the close 10 bars ago). The
//     1-hour leg is the discriminator: a deep 2-hour drop that only drifts
//     down and then pops 10 minutes is a false ignition (the dev window has
//     four of those, each losing ~1%, and the steepest last-hour fall among
//     them is -1.31% against the winner's -1.62%); the one real V-reversal
//     falls steeply in its last hour too. A deep drop followed by a sharp
//     short-term rebound is the V-reversal shape: the dev window's one big
//     money move (a ~5% bounce after an ~8% drawdown) has exactly this
//     shape, while ordinary choppy drift has neither leg.
//   * Exit the whole position on the first of: take-profit +4% over the
//     filled value, trailing stop 0.8% below the peak position value, hard
//     stop -1.2% under the filled value, or 240 bars held. The filled value
//     is the position's mark on the first bar it is held (the harness books
//     cost as the full notional spent, ~1.5% above the filled value, so cost
//     must never be the exit reference). All exit comparisons are integer
//     bigint math on quote units.
//   * Fallback entry (guardrail safety net): if no trade has filled by bar
//     1200 and the short trend is up (EMA-12 above EMA-48 with a positive
//     30-bar return), take one trend trade with tight +0.8% / -0.8% exits,
//     so the bot still meets the >= 1 trade guardrail on a quiet race
//     window. It never fires on the dev window (the reversal trade already
//     filled there).
//
// Every decision is a pure function of the closes seen in the hello/batch
// messages: no wall clock, no environment, no randomness, so two runs on the
// same bars produce byte-identical orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- entry: oversold reversal -------------------------------------------
const DROP_WIN = 120; // bars of the deep-drop leg (2 hours)
const DROP_THR = 0.015; // close must be 1.5%+ below the close DROP_WIN bars ago
const DROP60_WIN = 60; // bars of the steep-drop leg (1 hour)
const DROP60_THR = 0.015; // close must be 1.5%+ below the close DROP60_WIN bars ago
const IGNITE_WIN = 10; // bars of the snap-back leg
const IGNITE_THR = 0.005; // close must be 0.5%+ above the close IGNITE_WIN bars ago

// --- exits (fractions of filled cost / peak value) ------------------------
// Stored as integer per-mille so exits compare in exact bigint math.
const TAKE_PROFIT = 1040n; // value >= cost * 1040 / 1000  (+4%)
const TRAIL = 992n; // value <= peak * 992 / 1000  (-0.8% from peak)
const HARD_STOP = 988n; // value <= cost * 988 / 1000  (-1.2% under cost)
const MAX_HOLD = 240; // bars

// --- fallback entry (only if nothing has traded yet) ----------------------
// Half-size and tight exits: it is a safety net for the >= 1 trade
// guardrail, not a profit centre, so a loss on it is capped at ~0.5% of
// half the equity.
const FALLBACK_BAR = 1200;
const FALLBACK_TP = 1006n; // +0.6% over filled value
const FALLBACK_TRAIL = 996n; // -0.4% from peak
const FALLBACK_STOP = 994n; // -0.6% under filled value

const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let emaFast: number | null = null; // EMA(12) of closes
let emaSlow: number | null = null; // EMA(48) of closes
let entryBar = -1; // seq of the bar the current position was decided on
let entryMode: 'reversal' | 'fallback' = 'reversal';
let entryValue = 0n; // position value (quote units) on the first bar it is held:
// the harness books cost as the full notional spent, so cost is ~1.5%
// ABOVE the filled value (fee + slippage + impact); exits must be judged
// against this filled value, never against cost, or the hard stop would
// fire on the very first bar after every entry.
let peakValue = 0n; // highest position value (quote units) since entry
let tradesFilled = 0; // fills reported in batches so far

function emaStep(prev: number | null, close: number, span: number): number {
  const k = 2 / (span + 1);
  return prev === null ? close : prev + k * (close - prev);
}

/** Close now vs close n bars ago, as a fraction, or null. */
function retNow(n: number): number | null {
  if (closes.length <= n) return null;
  return closes[closes.length - 1]! / closes[closes.length - 1 - n]! - 1;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled') tradesFilled++;
    }
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(bar.c);
      closes.push(c);
      emaFast = emaStep(emaFast, c, 12);
      emaSlow = emaStep(emaSlow, c, 48);
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (entryValue === 0n) entryValue = value;
      if (value > peakValue) peakValue = value;
      const tp = entryMode === 'fallback' ? FALLBACK_TP : TAKE_PROFIT;
      const trail = entryMode === 'fallback' ? FALLBACK_TRAIL : TRAIL;
      const stop = entryMode === 'fallback' ? FALLBACK_STOP : HARD_STOP;
      const maxHold = entryMode === 'fallback' ? 120 : MAX_HOLD;
      if (
        value * 1000n >= entryValue * tp ||
        value * 1000n <= peakValue * trail ||
        value * 1000n <= entryValue * stop ||
        state.seq - entryBar >= maxHold
      ) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: look for an entry.
    const drop = retNow(DROP_WIN);
    const drop60 = retNow(DROP60_WIN);
    const ignite = retNow(IGNITE_WIN);
    if (drop !== null && drop60 !== null && ignite !== null && drop <= -DROP_THR && drop60 <= -DROP60_THR && ignite >= IGNITE_THR) {
      entryBar = state.seq;
      entryMode = 'reversal';
      entryValue = 0n;
      peakValue = 0n;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }

    if (tradesFilled === 0 && state.seq >= FALLBACK_BAR && emaFast !== null && emaSlow !== null) {
      const ret30 = retNow(30);
      if (emaFast > emaSlow && ret30 !== null && ret30 > 0.002) {
        entryBar = state.seq;
        entryMode = 'fallback';
        entryValue = 0n;
        peakValue = 0n;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash / 2n, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
      }
    }

    return [];
  },
});
