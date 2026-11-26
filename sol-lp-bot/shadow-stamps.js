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
//
// System-configurable v1 (deep-analysis §5.6, items 1–12) adds the
// missing-data fields below. Same hard rules as stamps-v1: additive
// fields only, no existing field changes meaning (SCHEMA stays
// 'stamps-v1'), missing source fields are stamped null — never
// fabricated — and each untestable-on-this-source field carries a
// *Status field saying so, so an analyst never mistakes null for zero:
//  - #1  pump1h (already stamped from picks), pump5m, buyRatio on scan rows
//  - #2  TF5 volume (vol5mUsd) + trade counts; unique-trade count is NOT
//        in the datapi record -> uniqueTrades null + uniqueTradesStatus
//  - #3  smartWallet flag -> null + smartWalletStatus (no source field
//        exists anywhere in the record or the RugCheck report; H12 stays
//        untestable until a source exists)
//  - #4  trailing-24h fee/TVL (feeTvl24h from fee_tvl_ratio['24h'])
//  - #5  ftBand (band of ft30m at the event) so per-band first-reject
//        extraction can be built without re-deriving the band; the
//        first-reject dedupe itself stays in the extraction
//  - #6  binsBelow / totalBins on poll rows (from the open position when
//        the caller passes it; null on scan rows — no position exists)
//  - #7  pump5m, buyRatio, healthScore (see #1; healthScore has no source)
//  - #8  worstDrawdownPct per leg: poll rows carry the position's
//        worstPnlPct so far; the closed-leg value is stamped by
//        paper-history.csv() from the close record
//  - #9  holders / organic % (holdersPct from the record when present;
//        organicPct has no source -> null + status)
//  - #10 comparison band flag (isComparisonBand: ft30m 0.60–0.80%,
//        TVL >= $10k — the H4 comparison band)
//  - #11 per-book open-attempt labelling: kind:'open-attempt' rows
//        (stampOpenAttempt), one per book per open attempt
//  - #12 entry synchronisation: syncGroup stamped on open-attempt rows
//        (null until synchronised entry is implemented — see config)
//  - #13 19–22 Nov reject universe: UNRECOVERABLE, no field can supply it.

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
    // §5.6 additions (null = no source field; never fabricated).
    vol5mUsd: null, feeTvl24h: null,
    tradeCount5m: null, tradeCount1h: null, tradeCount24h: null,
    holdersPct: null, buyRatio: null,
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
    // §5.6 #2 (TF5 volume + trade counts) and #4 (trailing-24h fee/TVL).
    // Candidate keys are read when the record carries them; anything else
    // stays null — the datapi record shape is not assumed.
    out.vol5mUsd = num(p.volume?.['5m']);
    out.feeTvl24h = num(p.fee_tvl_ratio?.['24h']);
    const trades = p.trades || p.trade_count || p.tradeCount || null;
    if (trades && typeof trades === 'object') {
      out.tradeCount5m = num(trades['5m']);
      out.tradeCount1h = num(trades['1h']);
      out.tradeCount24h = num(trades['24h']);
    } else if (trades != null) {
      out.tradeCount24h = num(trades);
    }
    // §5.6 #9 holders (top-10 share when the record carries it) and
    // #1/#7 buy ratio (buys/(buys+sells) when the record carries it).
    out.holdersPct = num(p.top10_hold_pct ?? p.holders_pct ?? p.token_x?.top10_hold_pct);
    const buys = num(p.buys?.['1h'] ?? p.buy_count_1h);
    const sells = num(p.sells?.['1h'] ?? p.sell_count_1h);
    if (buys != null && sells != null && buys + sells > 0) out.buyRatio = buys / (buys + sells);
    else out.buyRatio = num(p.buy_ratio ?? p.buyRatio);
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
    // §5.6 #2 TF5 volume + trade counts (#2: unique-trade count has no
    // source in the datapi record — see uniqueTradesStatus).
    vol5mUsd: d.vol5mUsd,
    tradeCount5m: d.tradeCount5m,
    tradeCount1h: d.tradeCount1h,
    tradeCount24h: d.tradeCount24h,
    uniqueTrades: null,
    uniqueTradesStatus: 'not_exposed_by_datapi: no unique-trade count in the datapi record (spike rule as stated stays untestable)',
    // §5.6 #3 smart-wallet flag (H12): no source field exists anywhere.
    smartWallet: null,
    smartWalletStatus: 'not_exposed_by_datapi: no smart-wallet field in the datapi record or the RugCheck report (H12 untestable until a source exists)',
    // §5.6 #4 trailing-24h fee/TVL series (feeTvl24h; feeTvl4h above is the 4h point).
    feeTvl24h: d.feeTvl24h,
    feeTvlTrailing24h: d.feeTvl24h,
    // §5.6 #7 5m change / buy ratio / health score (pump5m comes from the
    // pick in buildScanRow; healthScore has no source).
    buyRatio: d.buyRatio,
    healthScore: null,
    healthScoreStatus: 'not_exposed_by_datapi: no health score in the datapi record (areio as specified stays untestable)',
    // §5.6 #9 holders / organic % (organic has no source).
    holdersPct: d.holdersPct,
    organicPct: null,
    organicPctStatus: 'not_exposed_by_datapi: no organic-holder share in the datapi record',
    // §5.6 #6 binsBelow vs total width (scan rows have no position; poll
    // rows fill these from ctx.position when the caller passes it).
    binsBelow: null,
    totalBins: null,
  };
}

// FT band of an ft30m value, for §5.6 #5 per-band first-reject extraction
// and #10 (the H4 comparison band is 0.60–0.80% at TVL >= $10k).
function ftBandOf(ft30m) {
  if (!Number.isFinite(ft30m)) return null;
  if (ft30m < 0.30) return '<0.30%';
  if (ft30m < 0.45) return '0.30-0.45%';
  if (ft30m < 0.60) return '0.45-0.60%';
  if (ft30m < 0.80) return '0.60-0.80%';
  return '>=0.80%';
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
    ftBand: null,
    isComparisonBand: null,
    ageH: null,
    binStep: num(p?.pool_config?.bin_step),
    pump1h: null,
    pump5m: null,
    pump24h: null,
    vol1h: num(p?.volume?.['1h']),
    vol24h: num(p?.volume?.['24h']),
  };
  try {
    if (typeof ctx.feeTvlFn === 'function') {
      row.ft30m = num(ctx.feeTvlFn(p, '30m'));
      row.ftWindow = num(ctx.feeTvlFn(p, ctx.ftWindow));
    }
    // §5.6 #5/#10: band of ft30m at the event + the H4 comparison band.
    row.ftBand = ftBandOf(row.ft30m);
    row.isComparisonBand = row.ft30m != null && row.ft30m >= 0.60 && row.ft30m < 0.80 && num(p?.tvl) != null && num(p.tvl) >= 10000;
    if (Number.isFinite(+ctx.nowS) && p?.created_at != null) {
      row.ageH = (+ctx.nowS - createdAtSec(p)) / 3600;
    }
    const pick = ctx.pickByAddress?.get(p?.address);
    if (pick) {
      // Picks carry pump fractions (0.05 = +5%); stamps store percent, the
      // same units the scan log and screening UI print.
      row.pump1h = num(pick.pump1h) != null ? (+pick.pump1h) * 100 : null;
      row.pump24h = num(pick.pump24h) != null ? (+pick.pump24h) * 100 : null;
      // §5.6 #1/#7: 5m change when the pick carries it (null otherwise).
      row.pump5m = num(pick.pump5m) != null ? (+pick.pump5m) * 100 : null;
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
// ctx.position (optional, the open position) supplies §5.6 #6 binsBelow /
// totalBins and #8 worstDrawdownPct (worst net PnL% so far this leg).
function buildPollRow(p, ctx) {
  const row = {
    kind: 'poll',
    schema: SCHEMA,
    at: ctx?.at ?? null,
    instance: ctx?.instance ?? null,
    scanStartedAt: null,
    ...baseRow(p),
    ft30m: (ctx && typeof ctx.feeTvlFn === 'function') ? num(ctx.feeTvlFn(p, '30m')) : num(p?.fee_tvl_ratio?.['30m']),
  };
  try {
    const pos = ctx?.position;
    if (pos && typeof pos === 'object') {
      row.binsBelow = num(pos.binsBelow ?? (Number.isFinite(pos.entryActiveBin) && Number.isFinite(pos.minBinId) ? pos.entryActiveBin - pos.minBinId + 1 : null));
      row.totalBins = num(pos.nBins ?? pos.totalBins ?? (Number.isFinite(pos.maxBinId) && Number.isFinite(pos.minBinId) ? pos.maxBinId - pos.minBinId + 1 : null));
      row.worstDrawdownPct = num(pos.worstPnlPct);
    } else {
      row.worstDrawdownPct = null;
    }
  } catch { row.worstDrawdownPct = null; }
  return row;
}

// Build one kind:'open-attempt' row (§5.6 #11 per-book open-attempt
// labelling, #12 entry synchronisation). One row per book per open
// attempt: {pool, bookId, result:'opened'|'skipped', skipReason,
// syncGroup}. syncGroup is null until synchronised entry is implemented
// (config entrySync.enabled=false); the field exists so the next batch
// can stamp the group id without a schema change.
function buildOpenAttemptRow({ pool, bookId, result, skipReason = null, syncGroup = null, at = null, instance = null } = {}) {
  return {
    kind: 'open-attempt',
    schema: SCHEMA,
    at,
    instance: instance ?? null,
    pool: pool?.address ?? pool ?? null,
    name: pool?.name ?? null,
    bookId: bookId ?? null,
    result: result === 'opened' ? 'opened' : 'skipped',
    skipReason: skipReason != null ? String(skipReason) : null,
    syncGroup: syncGroup ?? null,
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

// stampPoll(ctx): ctx = { paperDir, at, instance, record, feeTvlFn, position }
// `record` MUST be a pool record the caller already fetched for position
// management — this function never fetches anything. Null record = no-op.
// `position` (optional) supplies §5.6 #6/#8 fields on the poll row.
function stampPoll(ctx) {
  try {
    if (!enabled() || !ctx || !ctx.record) return;
    appendRows(ctx.paperDir, [buildPollRow(ctx.record, ctx)]);
  } catch { /* best-effort, exactly like railsEvent */ }
}

// stampOpenAttempt(ctx): ctx = { paperDir, at, instance, pool, bookId,
//   result, skipReason, syncGroup }. Best-effort, never throws.
function stampOpenAttempt(ctx) {
  try {
    if (!enabled() || !ctx || !ctx.paperDir) return;
    appendRows(ctx.paperDir, [buildOpenAttemptRow(ctx)]);
  } catch { /* best-effort, exactly like railsEvent */ }
}

module.exports = { stampScan, stampPoll, stampOpenAttempt, buildScanRow, buildPollRow, buildOpenAttemptRow, derive, ftBandOf, SCHEMA };
