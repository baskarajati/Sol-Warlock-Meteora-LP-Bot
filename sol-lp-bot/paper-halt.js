'use strict';
// paper-halt.js — code-enforced halt executor for the PAPER books
// (register #13, deep-analysis §5.5).
//
// The gap it closes: in Batches 1–2 the halt was monitoring-only. No
// FAILED book was ever actually halted — B1: B7 +30, D +23, A +12 closes
// after breach; B2: FP +23, A2 +15 closes after breach — because the halt
// decision sat pending with sole mid-window. The recoveries after breach
// (A +$124.89, D +$16.80, B7 +$183.00, FP +$94.20, A2 +$159.11) do not
// vindicate the gap: a rule that can neither halt a book that keeps
// bleeding nor be relied on to halt one that recovers is not a safety
// rule.
//
// This module is the executor for the frozen paper-book safety rule —
// any ONE prong trips the book:
//   P1  3 consecutive emergency-stop closes
//   P2  equity drawdown > paperHalt.drawdownUsd from the book start
//       (frozen bar: $150 on a $1,000 book)
//   P3  5 consecutive losing closes totalling < -paperHalt.consecLossSumUsd
//       (frozen bar: 5 closes totalling < -$100)
// (The live K1–K9 table lives in live-halt.js for the live path; the
// paper books run this rule because their books are USD-denominated and
// their closes are recorded by paperClose, not by live-halt.recordClose.)
//
// Trip behaviour (pre-authorised per the live-readiness package — no
// mid-window decision is pending with sole): the trip LATCHES per book,
// writes HALT-<bookId> in the paper dir, persists state to
// halt-<bookId>.json (a restart never auto-clears it), logs
// `HALT TRIP [<bookId>] <criterion> ...`, and canOpen() returns false
// from then on — no new opens into that book. Open positions are NOT
// force-closed by the halt itself: they unwind through their normal
// exits (emergency stop / TP / stale), exactly as the live halt does.
// Manual reset only: delete HALT-<bookId> AND halt-<bookId>.json after
// review (the module never deletes either file itself).
//
// Drawdown is measured on REALISED closes only (netUsd from book start).
// Open unrealised PnL is not counted — deliberately, so a halt verdict
// never depends on a quote that may be stale; the emergency stop is the
// defence for open legs, not this rule. Reposition intermediate legs
// (reason 'oor_right_reposition_leg') are NOT closed legs and must not
// be passed to recordClose().
const fs = require('fs');
const path = require('path');

const DEFAULT_PARAMS = Object.freeze({
  enabled: true,
  bookUsd: 1000,
  drawdownUsd: 150,
  consecEmergencyStops: 3,
  consecLosses: 5,
  consecLossSumUsd: 100,
});

function freshState(bookId) {
  return {
    version: 1,
    bookId,
    closedLegs: 0,
    netUsd: 0,
    consecEmergency: 0,
    lossRun: [],
    tripped: null,
  };
}

function create(opts = {}) {
  const bookId = opts.bookId || 'A';
  const dir = opts.dir || process.cwd();
  const log = opts.log || (() => {});
  const params = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
  const stateFile = path.join(dir, `halt-${bookId}.json`);
  const haltFile = path.join(dir, `HALT-${bookId}`);

  let state = freshState(bookId);
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && s.version === 1) state = { ...freshState(bookId), ...s };
    else log(`paper-halt [${bookId}]: state version ${s && s.version} (expected 1); starting fresh (halt latch NOT assumed)`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`paper-halt [${bookId}]: cannot read ${stateFile}: ${e.message}; starting fresh (halt latch NOT assumed)`);
  }
  // The HALT file is the durable latch: if it exists but state was lost,
  // re-latch from it (a restart must never auto-clear a halt).
  if (!state.tripped && fs.existsSync(haltFile)) {
    try {
      const h = JSON.parse(fs.readFileSync(haltFile, 'utf8'));
      state.tripped = { criterion: h.criterion || 'unknown', at: h.at || null, figures: h.figures || {}, recoveredFromHaltFile: true };
    } catch { state.tripped = { criterion: 'unknown', at: null, figures: {}, recoveredFromHaltFile: true }; }
    log(`paper-halt [${bookId}]: HALT file present without state — re-latched trip ${state.tripped.criterion}`);
  }

  function saveState() {
    try {
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) { log(`paper-halt [${bookId}]: cannot write ${stateFile}: ${e.message}`); }
  }

  function trip(criterion, figures) {
    if (state.tripped) {
      log(`paper-halt [${bookId}]: already tripped (${state.tripped.criterion}); ${criterion} also met, not overwriting the latch`);
      return state.tripped;
    }
    const rec = { criterion, at: new Date().toISOString(), figures };
    state.tripped = rec;
    try { fs.writeFileSync(haltFile, JSON.stringify({ ...rec, bookId, bookUsd: params.bookUsd }, null, 2)); } catch (e) { log(`paper-halt [${bookId}]: cannot write ${haltFile}: ${e.message}`); }
    saveState();
    log(`HALT TRIP [${bookId}] ${criterion} figures=${JSON.stringify(figures)} — new opens refused (latched); open positions unwind through normal exits`);
    return rec;
  }

  // ev: {pnlUsd, reason, pool, openedAt}. reason 'emergency_stop' counts
  // for P1; any negative pnlUsd extends the losing run for P3.
  function recordClose(ev = {}, nowMs = Date.now()) {
    if (!params.enabled) return { trips: [], tripped: state.tripped };
    const pnlUsd = Number(ev.pnlUsd) || 0;
    const reason = ev.reason || '';
    state.closedLegs += 1;
    state.netUsd += pnlUsd;
    const trips = [];
    // P1: consecutive emergency stops.
    if (reason === 'emergency_stop') {
      state.consecEmergency += 1;
      if (state.consecEmergency >= params.consecEmergencyStops) {
        trips.push(trip('P1-consec-emergency-stops', { consecEmergency: state.consecEmergency, pool: ev.pool || null }));
      }
    } else state.consecEmergency = 0;
    // P3: consecutive losing closes; trip on the trailing-N sum.
    if (pnlUsd < 0) {
      state.lossRun.push(pnlUsd);
      const lastN = state.lossRun.slice(-params.consecLosses);
      if (state.lossRun.length >= params.consecLosses) {
        const sumN = lastN.reduce((a, b) => a + b, 0);
        if (sumN < -params.consecLossSumUsd) {
          trips.push(trip('P3-consec-losses', { consecLosses: state.lossRun.length, lastNSumUsd: +sumN.toFixed(4), limitUsd: -params.consecLossSumUsd }));
        }
      }
    } else state.lossRun = [];
    // P2: equity drawdown from book start (realised only).
    const drawdown = -state.netUsd;
    if (drawdown > params.drawdownUsd) {
      trips.push(trip('P2-drawdown', { netUsd: +state.netUsd.toFixed(4), drawdownUsd: +drawdown.toFixed(4), limitUsd: params.drawdownUsd, closedLegs: state.closedLegs }));
    }
    saveState();
    return { trips, tripped: state.tripped, state: status() };
  }

  function canOpen() {
    if (!params.enabled) return { ok: true };
    if (state.tripped) return { ok: false, reason: `halt latched [${bookId}]: ${state.tripped.criterion}`, criterion: state.tripped.criterion };
    if (fs.existsSync(haltFile)) return { ok: false, reason: `HALT-${bookId} file present` };
    return { ok: true };
  }

  function status() {
    return {
      bookId,
      tripped: state.tripped,
      closedLegs: state.closedLegs,
      netUsd: +state.netUsd.toFixed(4),
      drawdownUsd: +(-state.netUsd).toFixed(4),
      consecEmergency: state.consecEmergency,
      consecLosses: state.lossRun.length,
      consecLossSumUsd: +state.lossRun.reduce((a, b) => a + b, 0).toFixed(4),
      params: { ...params },
    };
  }

  return {
    params: () => ({ ...params }),
    status, state: () => JSON.parse(JSON.stringify(state)),
    recordClose, canOpen, trip,
    isHalted: () => !!state.tripped,
    files: { haltFile, stateFile },
  };
}

module.exports = { create, DEFAULT_PARAMS };
