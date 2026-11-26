'use strict';
// paper-chain-budget.js — X5 chain-reshape budget + X3 pool cooldown.
//
// Port of Batch 3 rail-set batch3-rails-v1 X5/X3 (batch3/code/build2/
// paper-rails.js, FROZEN-SPEC §§3, 5) into Warlock system-configurable v1.8,
// with ONE deliberate departure from B3 (feature spec §4): the budget and
// the window are NOT frozen literals here — they come from the resolved
// profile's reshape.chainBudget section in warlock-config.json, loaded by
// config-loader.js. The values stay the B3 values (budget 3, window 24h);
// their home moves from code to config. No budget/window literal exists
// anywhere in this file: windowMs is computed from config windowHours,
// and the ledger retention bound is derived from the window (2x).
//
// The X3 cooldown steps below ARE literals, and deliberately so: they are
// the frozen parameters of the named 'x3' cooldown scheme that the config
// selects with reshape.chainBudget.cooldown === 'x3' (B3 FROZEN-SPEC §3:
// profit close -> 15 min; loss closes escalate 4h -> 24h -> 72h inside a
// 7-day window; last >=2 closes both negative -> 72h memory). They are not
// strategy tunables and there is no config key for them — exactly as B3
// froze them in paper-rails.js.
//
// Semantics (FROZEN-SPEC §5, unchanged): budget N re-centre events per
// pool per rolling window, per book, counted across ALL legs of that pool
// in that book. A reposition opens a new leg but does NOT reset the count.
// What counts: a completed reshape AND a completed right-reposition (both
// are re-centring actions that keep exposure alive). Failed/blocked
// attempts do NOT count — only completed re-centres. At exhaustion the leg
// exits with reason chain_reshape_budget_exit and the pool enters the X3
// cooldown. Never freeze-and-hold.
//
// Scoping (Delta/Golf pre-registrations, 27 Nov 2026): the budget counts
// book E's legs only. bot.js enforces this module only for variant 'E';
// this module itself is book-agnostic and keys by `${variant}|${pool}`,
// exactly as B3's chainKey, so each book keeps its own count.
//
// Persistence: the count survives a restart — the ledger lives in
// <instance>/paper/rails-state.json, loaded at first use and saved after
// every recorded event (atomic tmp + rename, as B3). A lost ledger would
// silently reset every pool's budget, so the test covers restart
// persistence (test-chain-budget.js).
const fs = require('fs');
const path = require('path');

// X3 — re-entry cooldown scheme (B3 FROZEN-SPEC §3, paper-rails.js X3).
// Selected by config reshape.chainBudget.cooldown === 'x3'.
const X3 = {
  PROFIT_MIN: 15,
  LOSS_STEPS_MIN: [240, 1440, 4320], // 4h -> 24h -> 72h
  MEMORY_MIN: 4320,                  // last >=2 closes net negative -> 72h
  ESCALATION_WINDOW_MS: 7 * 24 * 3600e3,
};

// ---------- Config ----------
// Reads ONLY reshape.chainBudget. Returns null when the feature is off
// (section absent, or enabled !== true): callers must not touch the
// ledger, emit x5_* events, or change any exit when this returns null —
// Alpha / Echo / Foxtrot behave exactly as before the feature existed.
function chainBudgetFromProfile(profile) {
  const cb = profile && profile.reshape && profile.reshape.chainBudget;
  if (!cb || cb.enabled !== true) return null;
  return {
    enabled: true,
    budget: cb.budget,
    windowMs: cb.windowHours * 3600e3,
    windowHours: cb.windowHours,
    scope: cb.scope,
    count: Array.isArray(cb.count) ? [...cb.count] : [],
    onExhaust: cb.onExhaust,
    cooldown: cb.cooldown,
  };
}
// Does this budget count a completed re-centre of this kind?
// kind is 'reshape' or 'right_reposition' (config reshape.chainBudget.count).
function countsEvent(cfg, kind) {
  return !!cfg && Array.isArray(cfg.count) && cfg.count.includes(kind);
}

// ---------- Ledger (persisted chain-event state) ----------
function emptyLedger() { return { chainEvents: {} }; }
function loadLedger(dir) {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'rails-state.json'), 'utf8'));
    if (l && typeof l === 'object') return { ...emptyLedger(), ...l };
  } catch { /* fresh */ }
  return emptyLedger();
}
function saveLedger(dir, ledger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `rails-state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, path.join(dir, 'rails-state.json'));
  } catch { /* rail state is best-effort; decisions are logged separately */ }
}
function chainKey(variant, pool) { return `${variant}|${pool}`; }
// Record one completed re-centre event. Entries older than twice the
// window are pruned (for the specified 24h window that is 48h, as B3).
function recordChainEvent(ledger, variant, pool, nowMs, windowMs) {
  const k = chainKey(variant, pool);
  const arr = (ledger.chainEvents[k] = ledger.chainEvents[k] || []);
  arr.push(nowMs);
  const retainMs = 2 * windowMs;
  while (arr.length && arr[0] < nowMs - retainMs) arr.shift();
}
// Re-centre events for this (variant, pool) inside [nowMs - windowMs, nowMs].
function chainEventsInWindow(ledger, variant, pool, nowMs, windowMs) {
  const arr = (ledger.chainEvents && ledger.chainEvents[chainKey(variant, pool)]) || [];
  return arr.filter((t) => t >= nowMs - windowMs && t <= nowMs).length;
}
function budgetExhausted(ledger, variant, pool, nowMs, cfg) {
  if (!cfg) return false;
  return chainEventsInWindow(ledger, variant, pool, nowMs, cfg.windowMs) >= cfg.budget;
}

// ---------- X3 cooldown (B3 paper-rails.js cooldownStatus, unchanged) ----------
const pnlOf = (h) => { const v = h.pnlUsd != null ? +h.pnlUsd : +h.netPnlUsd; return Number.isFinite(v) ? v : null; };
function poolCloses(history, pool) {
  return (history || []).filter((h) => h.pool === pool && h.reason !== 'oor_right_reposition_leg' && Number.isFinite(Date.parse(h.closedAt)) && pnlOf(h) != null)
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
}
function cooldownStatus(history, pool, nowMs = Date.now()) {
  const closes = poolCloses(history, pool);
  if (!closes.length) return { blocked: false, closes: 0 };
  const last = closes[closes.length - 1], lastT = Date.parse(last.closedAt), lastPnl = pnlOf(last);
  let until, kind;
  if (lastPnl >= 0) { until = lastT + X3.PROFIT_MIN * 60000; kind = 'profit'; }
  else {
    const losses = closes.filter((c) => pnlOf(c) < 0 && Date.parse(c.closedAt) > nowMs - X3.ESCALATION_WINDOW_MS && Date.parse(c.closedAt) <= lastT).length;
    const step = Math.min(Math.max(losses, 1), 3);
    until = lastT + X3.LOSS_STEPS_MIN[step - 1] * 60000; kind = 'loss' + step;
  }
  // Pool memory: last >= 2 closes both net negative -> 72h from the later close.
  // Precedence (FROZEN-SPEC §3): longest applicable cooldown governs; never summed.
  if (closes.length >= 2 && lastPnl < 0 && pnlOf(closes[closes.length - 2]) < 0) {
    const memUntil = lastT + X3.MEMORY_MIN * 60000;
    if (memUntil > until) { until = memUntil; kind = 'memory'; }
  }
  return { blocked: nowMs < until, until, kind, closes: closes.length, lastClose: { closedAt: last.closedAt, reason: last.reason, pnlUsd: lastPnl } };
}

module.exports = {
  X3,
  chainBudgetFromProfile, countsEvent,
  emptyLedger, loadLedger, saveLedger,
  chainKey, recordChainEvent, chainEventsInWindow, budgetExhausted,
  poolCloses, cooldownStatus,
};
