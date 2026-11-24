'use strict';
// shadow-stamps.js — stamps-v1 SHADOW STAMP PACKAGE (Warlock v1, logging-only).
//
// Appends one JSONL row per screened pool per scan (kind:'scan') and one row
// per position-management poll that already fetched a fresh pool record
// (kind:'poll') to <PAPER_DIR>/shadow-stamps.jsonl, so pools the screen
// REJECTS become analysable later (the "shadow universe").
//
// Hard rules (frozen spec, sole approval 2026-11-23):
//  - ZERO strategy behaviour change: this module is called only AFTER scan
//    decisions are final, never reads back into any decision, returns nothing
//    the caller uses, and performs NO network calls.
//  - Best-effort exactly like railsEvent() in bot.js: every entry point is
//    wrapped in try/catch and swallows all errors. A broken stamp file can
//    never break a scan, a poll, or the bot.
//  - Missing source fields are stamped null — never fabricated.
//  - Kill switch: env SHADOW_STAMPS=off disables all writes.
//
// Field provenance (verified 2026-11-23 against live Meteora datapi records,
// the same records performScan already fetches):
//  - S-1: datapi exposes fee_tvl_ratio over TOTAL TVL only; there is NO
//    active-TVL field. fee/ACTIVE-TVL is therefore proxied by fee/total-TVL
//    and stamped honestly (feeTvlDenominator:'total_tvl', activeTvl:null).
//  - S-2: volAccel30m is derived within the SAME record:
//    vol30m / (vol1h - vol30m) = latest 30m volume vs the prior 30m volume.
//  - S-3: marketCapUsd is token_x.market_cap, taken directly.
//  - S-4: the datapi record carries no bin distribution, so the true
//    ±70-bin SOL-side split is NOT derivable without new per-pool DLMM bin
//    fetches (out of scope). We stamp a reserve-share proxy instead and mark
//    skewBinSplit blocked, in every row, so nobody mistakes it for the split.

const fs = require('fs');
const path = require('path');

const SCHEMA = 'stamps-v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BIN_SPLIT_STATUS = 'blocked: bin distribution not in datapi record; ±70-bin split would need per-pool DLMM bin fetches (new decision-path calls — out of scope)';

function enabled() {
  try { return process.env.SHADOW_STAMPS !== 'off'; } catch { return false; }
}

// Finite-number-or-null. Never NaN/Infinity in a stamp row.
// (+null === 0 and +'' === 0 in JS, so null/undefined/'' must be rejected
// explicitly — a missing field is null, never a fabricated 0.)
function num(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

function createdAtSec(p) {
  const t = +p?.created_at || 0;
  return t > 1e12 ? t / 1000 : t;
}

// S-1..S-4 derivations shared by scan and poll rows. Pure: record in, fields out.
function derive(p) {
  const out = {
    fees1hUsd: null, fees4hUsd: null, feeTvl1h: null, feeTvl4h: null,
    vol30mUsd: null, vol1hUsd: null, volAccel30m: null,
    marketCapUsd: null, tvlMcapRatio: null,
    skewSolPct: null, skewQuotePct: null,
  };
  try {
    if (!p || typeof p !== 'object') return out;
    out.fees1hUsd = num(p.fees?.['1h']);
    out.fees4hUsd = num(p.fees?.['4h']);
    out.feeTvl1h = num(p.fee_tvl_ratio?.['1h']);
    out.feeTvl4h = num(p.fee_tvl_ratio?.['4h']);
    out.vol30mUsd = num(p.volume?.['30m']);
    out.vol1hUsd = num(p.volume?.['1h']);
    // S-2: same-record derivation — latest 30m vs prior 30m (= 1h total minus latest 30m).
    if (out.vol30mUsd != null && out.vol1hUsd != null && out.vol1hUsd > out.vol30mUsd && out.vol30mUsd > 0) {
      out.volAccel30m = out.vol30mUsd / (out.vol1hUsd - out.vol30mUsd);
    }
    out.marketCapUsd = num(p.token_x?.market_cap);
    const tvl = num(p.tvl);
    if (tvl != null && out.marketCapUsd != null && out.marketCapUsd > 0) {
      out.tvlMcapRatio = tvl / out.marketCapUsd;
    }
    // S-4 reserve-share proxy: quote-side reserve USD / total reserve USD.
    const xUsd = num(p.token_x_amount) != null && num(p.token_x?.price) != null
      ? (+p.token_x_amount) * (+p.token_x.price) : null;
    const yUsd = num(p.token_y_amount) != null && num(p.token_y?.price) != null
      ? (+p.token_y_amount) * (+p.token_y.price) : null;
    if (xUsd != null && yUsd != null && xUsd + yUsd > 0) {
      const sharePct = (yUsd / (xUsd + yUsd)) * 100;
      out.skewQuotePct = sharePct;
      if (p.token_y?.address === SOL_MINT) out.skewSolPct = sharePct;
    }
  } catch { /* missing/odd fields -> nulls, never a throw */ }
  return out;
}

function baseRow(p) {
  const d = derive(p);
  return {
    pool: p?.address ?? null,
    name: p?.name ?? null,
    mintX: p?.token_x?.address ?? null,
    quoteSymbol: p?.token_y?.symbol ?? null,
    quoteMint: p?.token_y?.address ?? null,
    tvl: num(p?.tvl),
    // S-1 (fee/ACTIVE-TVL proxied by fee/total-TVL — see header)
    fees1hUsd: d.fees1hUsd,
    fees4hUsd: d.fees4hUsd,
    feeTvl1h: d.feeTvl1h,
    feeTvl4h: d.feeTvl4h,
    feeTvlDenominator: 'total_tvl',
    activeTvl: null,
    activeTvlStatus: 'not_exposed_by_datapi',
    // S-2
    vol30mUsd: d.vol30mUsd,
    vol1hUsd: d.vol1hUsd,
    volAccel30m: d.volAccel30m,
    // S-3
    marketCapUsd: d.marketCapUsd,
    tvlMcapRatio: d.tvlMcapRatio,
    // S-4 (reserve-share proxy; true bin split blocked — see header)
    skewSolPct: d.skewSolPct,
    skewQuotePct: d.skewQuotePct,
    skewBasis: 'reserve_share_proxy',
    skewBinSplit: null,
    skewBinSplitStatus: BIN_SPLIT_STATUS,
  };
}

// Build one kind:'scan' row. Exported for unit tests; stampScan uses it too.
// ctx: { at, instance, scanStartedAt, nowS, ftWindow, feeTvlFn,
//        pickByAddress: Map<addr, pick>, basicSet: Set<addr>,
//        reasonsByAddress: Map<addr, string[]> }
function buildScanRow(p, ctx) {
  const row = {
    kind: 'scan',
    schema: SCHEMA,
    at: ctx.at,
    instance: ctx.instance ?? null,
    scanStartedAt: ctx.scanStartedAt ?? null,
    ...baseRow(p),
    decision: 'rejected',
    rejectReason: null,
    ft30m: null,
    ftWindow: null,
    ftWindowName: ctx.ftWindow ?? null,
    ageH: null,
    binStep: num(p?.pool_config?.bin_step),
    pump1h: null,
    pump24h: null,
    vol1h: num(p?.volume?.['1h']),
    vol24h: num(p?.volume?.['24h']),
  };
  try {
    if (typeof ctx.feeTvlFn === 'function') {
      row.ft30m = num(ctx.feeTvlFn(p, '30m'));
      row.ftWindow = num(ctx.feeTvlFn(p, ctx.ftWindow));
    }
    if (Number.isFinite(+ctx.nowS) && p?.created_at != null) {
      row.ageH = (+ctx.nowS - createdAtSec(p)) / 3600;
    }
    const pick = ctx.pickByAddress?.get(p?.address);
    if (pick) {
      // Picks carry pump fractions (0.05 = +5%); stamps store percent, the
      // same units the scan log and screening UI print.
      row.pump1h = num(pick.pump1h) != null ? (+pick.pump1h) * 100 : null;
      row.pump24h = num(pick.pump24h) != null ? (+pick.pump24h) * 100 : null;
    }
    const reasons = ctx.reasonsByAddress?.get(p?.address) || [];
    if (ctx.pickByAddress?.has(p?.address)) {
      row.decision = 'pick';
    } else if (ctx.basicSet?.has(p?.address) && !reasons.length) {
      // Tail status semantics (bot.js toRow): passed->pick,
      // pending->passed_not_picked, rejected->rejected + first reason.
      row.decision = 'passed_not_picked';
    } else {
      row.decision = 'rejected';
      row.rejectReason = reasons.length ? String(reasons[0]) : null;
    }
  } catch { /* a malformed record still gets its base row, decision rejected */ }
  return row;
}

// Build one kind:'poll' row from an already-fetched pool record (S-3 per-poll).
function buildPollRow(p, ctx) {
  return {
    kind: 'poll',
    schema: SCHEMA,
    at: ctx?.at ?? null,
    instance: ctx?.instance ?? null,
    scanStartedAt: null,
    ...baseRow(p),
    ft30m: (ctx && typeof ctx.feeTvlFn === 'function') ? num(ctx.feeTvlFn(p, '30m')) : num(p?.fee_tvl_ratio?.['30m']),
  };
}

function appendRows(paperDir, rows) {
  if (!paperDir || !rows.length) return;
  fs.mkdirSync(paperDir, { recursive: true });
  fs.appendFileSync(path.join(paperDir, 'shadow-stamps.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// stampScan(ctx): ctx = { paperDir, at, instance, scanStartedAt, pools,
//   pickByAddress, basicSet, reasonsByAddress, ftWindow, feeTvlFn, nowS }
// Called ONCE per scan, after decisions are final. Best-effort: never throws.
function stampScan(ctx) {
  try {
    if (!enabled() || !ctx || !Array.isArray(ctx.pools)) return;
    const rows = [];
    for (const p of ctx.pools) {
      try { rows.push(buildScanRow(p, ctx)); } catch { /* skip the odd record */ }
    }
    appendRows(ctx.paperDir, rows);
  } catch { /* best-effort, exactly like railsEvent */ }
}

// stampPoll(ctx): ctx = { paperDir, at, instance, record, feeTvlFn }
// `record` MUST be a pool record the caller already fetched for position
// management — this function never fetches anything. Null record = no-op.
function stampPoll(ctx) {
  try {
    if (!enabled() || !ctx || !ctx.record) return;
    appendRows(ctx.paperDir, [buildPollRow(ctx.record, ctx)]);
  } catch { /* best-effort, exactly like railsEvent */ }
}

module.exports = { stampScan, stampPoll, buildScanRow, buildPollRow, derive, SCHEMA };
