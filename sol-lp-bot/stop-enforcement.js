'use strict';
// stop-enforcement.js — the -20% emergency stop, enforced on the worst
// price seen, not only on the poll-end price (deep-analysis §5.3).
//
// The gap: one Batch 1 leg went -0.89% -> -27.86% inside a single
// 39-second poll interval. The stop is poll-sampled, so a fast move can
// gap past it between polls — and worse, a dip below -20% that recovers
// before the next poll never fires the stop at all. A tighter stop alone
// does not fix a gap-able stop.
//
// The fix, in two parts:
//   (a) worst-PnL tracking: every valuation of a position (exitQuote,
//       re-quote near a threshold, post-reshape re-quote) updates
//       pos.worstPnlPct, the lowest net PnL% observed since entry.
//       paper-exit-policy.decide() fires 'emergency_stop' when the worst
//       breaches, even if the current poll's PnL has recovered above -20%.
//   (b) immediate check: checkStopNow() lets the management loop close in
//       the same poll a breach is observed, instead of waiting for the
//       next decide() cycle.
//
// Pure functions only — no IO, no chain calls. The position object is
// the caller's; only worstPnlPct / worstPnlPctAt are written, and only
// downwards (a new low).
function updateWorstPnl(pos, pnlPct, now = Date.now()) {
  if (!pos || !Number.isFinite(pnlPct)) return pos ? pos.worstPnlPct ?? null : null;
  if (!Number.isFinite(pos.worstPnlPct) || pnlPct < pos.worstPnlPct) {
    pos.worstPnlPct = pnlPct;
    pos.worstPnlPctAt = new Date(now).toISOString();
  }
  return pos.worstPnlPct;
}

// True when the stop is breached on the poll-end PnL, on the worst PnL
// seen since entry, or both. emergencyDrop is a fraction (0.20 = -20%).
function isStopBreach({ pnlPct, worstPnlPct, emergencyDrop = 0.2 } = {}) {
  const threshold = -100 * (Number.isFinite(emergencyDrop) ? emergencyDrop : 0.2);
  const atPoll = Number.isFinite(pnlPct) && pnlPct <= threshold;
  const intraPoll = Number.isFinite(worstPnlPct) && worstPnlPct <= threshold;
  return {
    breach: atPoll || intraPoll,
    basis: atPoll && intraPoll ? 'poll-and-worst' : atPoll ? 'poll' : intraPoll ? 'worst-intra-poll' : null,
    thresholdPct: threshold,
  };
}

// Immediate close decision for a fresh valuation, before the next poll.
// Returns {close:true, reason} when the valuation itself breaches.
function checkStopNow({ pnlPct, emergencyDrop = 0.2 } = {}) {
  const r = isStopBreach({ pnlPct, emergencyDrop });
  return r.breach ? { close: true, reason: 'emergency_stop', basis: r.basis, thresholdPct: r.thresholdPct } : { close: false, reason: null, basis: null, thresholdPct: r.thresholdPct };
}

module.exports = { updateWorstPnl, isStopBreach, checkStopNow };
