'use strict';
// test-configurable-v1.js — Warlock system-configurable v1 tests.
//
// Covers: config profiles + fail-fast validation, H17 reject rule,
// paper halt executor (register #13), stop enforcement (intra-poll
// breach), §5.6 stamp fields, paper-history CSV fields, and the bot.js
// wiring (source checks, same style as test-live-bugfix.js).
// Pure node, no network, no chain, no live files: all file writes go to
// mkdtemp dirs. Run: node test-configurable-v1.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const loader = require('./config-loader');
const h17 = require('./h17-reject');
const paperHalt = require('./paper-halt');
const stopEnf = require('./stop-enforcement');
const paperExit = require('./paper-exit-policy');
const stamps = require('./shadow-stamps');
const paperHistory = require('./paper-history');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const botSrc = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfgv1-'));

// ---------- 1. config profiles ----------
t('config: e-baseline matches the settled profile (0.6% floor, TP 13%, emTP 10%, SL+ 3%/0.1%, stop -20%, $500/leg, max 2, reshape-freeze-5, 5 SOL / 1.25 SOL)', () => {
  const { profile: p } = loader.loadConfig({ profile: 'e-baseline' });
  assert.equal(p.screening.minFt, 0.6);
  assert.equal(p.screening.ageGateEnabled, false);
  assert.equal(p.screening.feeTvlGate20Enabled, false);
  assert.equal(p.exits.tpUsdPct, 13);
  assert.equal(p.exits.emergencyTpPct, 10);
  assert.equal(p.exits.slPlusArmPct, 3);
  assert.equal(p.exits.slPlusLockPct, 0.1);
  assert.equal(p.exits.emergencyDrop, 0.2);
  assert.equal(p.sizing.positionUsdc, 500);
  assert.equal(p.sizing.maxPositions, 2);
  assert.equal(p.sizing.bookSol, 5);
  assert.equal(p.sizing.legSol, 1.25);
  assert.equal(p.reshape.reshapeMax, 5);
  assert.equal(p.reshape.reshapeN, 5);
  assert.equal(p.management.pollSec, 300);
  assert.equal(p.h17.enabled, false);
  assert.equal(p.paperHalt.drawdownUsd, 150);
  assert.equal(p.paperHalt.consecEmergencyStops, 3);
  assert.equal(p.paperHalt.consecLosses, 5);
  assert.equal(p.paperHalt.consecLossSumUsd, 100);
  assert.equal(p.halt.k1LegLossPct, 0.3);
  assert.equal(p.halt.k2DrawdownPct, 0.15);
  assert.equal(p.halt.k3ConsecEmergency, 3);
  assert.equal(p.halt.k5Worst3Pct, 0.3);
  assert.equal(p.halt.k6MinLegs, 30);
  assert.equal(p.halt.k7MaxBreaches, 2);
  assert.equal(p.halt.k8GapSol, 0.0625);
});

t('config: h17 profile is e-baseline + H17 only (nothing else moves)', () => {
  const e = loader.loadConfig({ profile: 'e-baseline' }).profile;
  const h = loader.loadConfig({ profile: 'h17' }).profile;
  assert.equal(h.h17.enabled, true);
  assert.equal(h.h17.pump24hMin, 0.4);
  assert.equal(h.h17.pump1hLow, -0.2);
  assert.equal(h.h17.pump1hHigh, -0.05);
  assert.equal(h.screening.minFt, e.screening.minFt);
  assert.equal(h.exits.tpUsdPct, e.exits.tpUsdPct);
  assert.equal(h.sizing.maxPositions, e.sizing.maxPositions);
  assert.equal(h.paperHalt.drawdownUsd, e.paperHalt.drawdownUsd);
});

t('config: paper-safety profile is e-baseline at paper-book scale (max 10/book, $1,000 book)', () => {
  const p = loader.loadConfig({ profile: 'paper-safety' }).profile;
  assert.equal(p.sizing.maxPositions, 10);
  assert.equal(p.paperHalt.bookUsd, 1000);
  assert.equal(p.exits.tpUsdPct, 13);
  assert.equal(p.h17.enabled, false);
});

t('config: halt table matches halt-params.json (one K1–K9 truth, two readers)', () => {
  // The LIVE executor (live-halt.js) reads halt-params.json; the paper
  // executor reads config.halt. They must agree — if a number changes in
  // one place, this test fails until the other is changed too.
  const hp = JSON.parse(fs.readFileSync(path.join(__dirname, 'halt-params.json'), 'utf8'));
  const h = loader.loadConfig({ profile: 'e-baseline' }).profile.halt;
  for (const k of ['bookSol', 'legSol', 'k1LegLossPct', 'k2DrawdownPct', 'k3ConsecEmergency', 'k4ConsecLosses', 'k4LossSumPct', 'k5Worst3Pct', 'k6MinLegs', 'k6NetPct', 'k6WindowDays', 'dailyLossPct', 'k7MaxBreaches', 'k8GapSol', 'k8GapConsec', 'maxFeeBps', 'feedStalePolls', 'feedDegradedPolls', 'pollSec', 'reshapeMax']) {
    assert.equal(h[k], hp[k], `halt.${k}: config=${h[k]} halt-params.json=${hp[k]}`);
  }
});

t('config: WARLOCK_PROFILE env selects the profile; default is e-baseline', () => {
  const saved = process.env.WARLOCK_PROFILE;
  try {
    delete process.env.WARLOCK_PROFILE;
    assert.equal(loader.loadConfig().profileName, 'e-baseline');
    process.env.WARLOCK_PROFILE = 'h17';
    assert.equal(loader.loadConfig().profileName, 'h17');
    assert.equal(loader.loadConfig().profile.h17.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.WARLOCK_PROFILE; else process.env.WARLOCK_PROFILE = saved;
  }
});

t('config: unknown profile fails fast', () => {
  assert.throws(() => loader.loadConfig({ profile: 'no-such-profile' }), /unknown profile/);
});

t('config: fail fast on bad values (range, type, cross-field, refuted rules, unknown key)', () => {
  const bad = (overrides, re) => assert.throws(() => loader.loadConfig({ profile: 'e-baseline', overrides }), re);
  bad({ screening: { minFt: -1 } }, /minFt/);
  bad({ exits: { emergencyDrop: 2 } }, /emergencyDrop/);
  bad({ exits: { tpUsdPct: 'thirteen' } }, /tpUsdPct/);
  bad({ exits: { slPlusLockPct: 3, slPlusArmPct: 3 } }, /slPlusLockPct must be < exits.slPlusArmPct/);
  bad({ screening: { feeTvlGate20Enabled: true } }, /20% fee\/TVL gate must not be enabled/);
  bad({ screening: { ageGateEnabled: true } }, /age gates hurt/);
  bad({ screening: { minBinStep: 500, maxBinStep: 400 } }, /minBinStep must be <= screening.maxBinStep/);
  bad({ typoKey: 1 }, /not a known config key/);
});

// ---------- 2. H17 ----------
t('h17: rejects the joint band (pump24h >= +40% AND pump1h in [-20%, -5%])', () => {
  const rule = { enabled: true, pump24hMin: 0.4, pump1hLow: -0.2, pump1hHigh: -0.05 };
  assert.equal(h17.isH17Reject({ pump1h: -0.10, pump24h: 0.45 }, rule).reject, true);
  assert.equal(h17.isH17Reject({ pump1h: -0.20, pump24h: 0.40 }, rule).reject, true);
  assert.equal(h17.isH17Reject({ pump1h: -0.05, pump24h: 0.60 }, rule).reject, true);
});
t('h17: keeps everything outside the joint band (incl. the U-shape: pump24h >= +60% alone, deep dips)', () => {
  const rule = { enabled: true, pump24hMin: 0.4, pump1hLow: -0.2, pump1hHigh: -0.05 };
  assert.equal(h17.isH17Reject({ pump1h: -0.10, pump24h: 0.30 }, rule).reject, false); // pump24h below 40%
  assert.equal(h17.isH17Reject({ pump1h: -0.30, pump24h: 0.80 }, rule).reject, false); // deep dip wins
  assert.equal(h17.isH17Reject({ pump1h: 0.02, pump24h: 0.80 }, rule).reject, false); // flat 1h
  assert.equal(h17.isH17Reject({ pump1h: -0.04, pump24h: 0.50 }, rule).reject, false); // dip too shallow
  assert.equal(h17.isH17Reject({ pump1h: -0.10, pump24h: 0.90 }, rule).reject, true); // inside band even at +90%
});
t('h17: disabled rule never rejects; missing pump data keeps the entry (fail-open, logged)', () => {
  const off = { enabled: false, pump24hMin: 0.4, pump1hLow: -0.2, pump1hHigh: -0.05 };
  assert.equal(h17.isH17Reject({ pump1h: -0.10, pump24h: 0.45 }, off).reject, false);
  const on = { enabled: true, pump24hMin: 0.4, pump1hLow: -0.2, pump1hHigh: -0.05 };
  const r = h17.isH17Reject({ pump1h: null, pump24h: 0.45 }, on);
  assert.equal(r.reject, false);
  assert.match(r.reason, /unevaluated/);
});

// ---------- 3. paper halt executor (register #13) ----------
function mkHalt(bookId) {
  const d = tmpDir();
  const logs = [];
  const h = paperHalt.create({ bookId, dir: d, log: (m) => logs.push(m) });
  return { d, h, logs };
}
t('paper-halt: P1 trips on 3 consecutive emergency stops, blocks opens, latches, writes HALT file', () => {
  const { d, h, logs } = mkHalt('A');
  assert.equal(h.canOpen().ok, true);
  h.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P1', openedAt: '2026-11-26T10:00:00.000Z' });
  h.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P2', openedAt: '2026-11-26T10:05:00.000Z' });
  assert.equal(h.canOpen().ok, true);
  assert.equal(h.isHalted(), false);
  const r = h.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P3', openedAt: '2026-11-26T10:10:00.000Z' });
  assert.equal(r.tripped.criterion, 'P1-consec-emergency-stops');
  assert.equal(h.isHalted(), true);
  assert.equal(h.canOpen().ok, false);
  assert.match(h.canOpen().reason, /halt latched/);
  assert.ok(fs.existsSync(path.join(d, 'HALT-A')), 'HALT-A file written');
  assert.ok(logs.some((l) => /HALT TRIP \[A\] P1-consec-emergency-stops/.test(l)), 'trip logged');
  // A fourth close does not overwrite the latch.
  h.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P4', openedAt: '2026-11-26T10:15:00.000Z' });
  assert.equal(h.status().tripped.criterion, 'P1-consec-emergency-stops');
  fs.rmSync(d, { recursive: true });
});
t('paper-halt: P1 does NOT trip below 3, and a non-stop close resets the run', () => {
  const { d, h } = mkHalt('D');
  h.recordClose({ pnlUsd: -30, reason: 'emergency_stop', pool: 'P1', openedAt: '2026-11-26T10:00:00.000Z' });
  h.recordClose({ pnlUsd: -30, reason: 'emergency_stop', pool: 'P2', openedAt: '2026-11-26T10:05:00.000Z' });
  h.recordClose({ pnlUsd: 5, reason: 'TP USDC +13%', pool: 'P3', openedAt: '2026-11-26T10:10:00.000Z' });
  h.recordClose({ pnlUsd: -30, reason: 'emergency_stop', pool: 'P4', openedAt: '2026-11-26T10:15:00.000Z' });
  h.recordClose({ pnlUsd: -30, reason: 'emergency_stop', pool: 'P5', openedAt: '2026-11-26T10:20:00.000Z' });
  assert.equal(h.isHalted(), false);
  assert.equal(h.status().consecEmergency, 2);
  fs.rmSync(d, { recursive: true });
});
t('paper-halt: P2 trips when realised drawdown passes $150 (frozen bar)', () => {
  const { d, h } = mkHalt('E');
  h.recordClose({ pnlUsd: -80, reason: 'TP USDC +13%', pool: 'P1', openedAt: '2026-11-26T10:00:00.000Z' });
  assert.equal(h.isHalted(), false);
  const r = h.recordClose({ pnlUsd: -80, reason: 'oor_right_take_profit', pool: 'P2', openedAt: '2026-11-26T10:05:00.000Z' });
  assert.equal(r.tripped.criterion, 'P2-drawdown');
  assert.equal(h.status().drawdownUsd, 160);
  fs.rmSync(d, { recursive: true });
});
t('paper-halt: P3 trips on 5 consecutive losing closes totalling < -$100', () => {
  const { d, h } = mkHalt('B7');
  for (let i = 0; i < 4; i++) h.recordClose({ pnlUsd: -25, reason: 'oor_right_take_profit', pool: `P${i}`, openedAt: `2026-11-26T10:0${i}:00.000Z` });
  assert.equal(h.isHalted(), false);
  const r = h.recordClose({ pnlUsd: -25, reason: 'oor_right_take_profit', pool: 'P4', openedAt: '2026-11-26T10:04:00.000Z' });
  assert.equal(r.tripped.criterion, 'P3-consec-losses');
  assert.equal(h.status().consecLossSumUsd, -125);
  fs.rmSync(d, { recursive: true });
});
t('paper-halt: a winning close resets the P3 loss run; small losses do not trip P3', () => {
  const { d, h } = mkHalt('A');
  for (let i = 0; i < 4; i++) h.recordClose({ pnlUsd: -10, reason: 'oor_right_take_profit', pool: `P${i}`, openedAt: `2026-11-26T10:0${i}:00.000Z` });
  h.recordClose({ pnlUsd: 3, reason: 'TP USDC +13%', pool: 'W', openedAt: '2026-11-26T10:05:00.000Z' });
  assert.equal(h.status().consecLosses, 0);
  for (let i = 0; i < 5; i++) h.recordClose({ pnlUsd: -10, reason: 'oor_right_take_profit', pool: `Q${i}`, openedAt: `2026-11-26T10:1${i}:00.000Z` });
  assert.equal(h.isHalted(), false, '5 x -$10 = -$50, above the -$100 bar');
  fs.rmSync(d, { recursive: true });
});
t('paper-halt: trip survives a restart (state file re-latches; HALT file re-latches without state)', () => {
  const d = tmpDir();
  const h1 = paperHalt.create({ bookId: 'A', dir: d, log: () => {} });
  h1.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P1', openedAt: '2026-11-26T10:00:00.000Z' });
  h1.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P2', openedAt: '2026-11-26T10:05:00.000Z' });
  h1.recordClose({ pnlUsd: -40, reason: 'emergency_stop', pool: 'P3', openedAt: '2026-11-26T10:10:00.000Z' });
  assert.equal(h1.isHalted(), true);
  const h2 = paperHalt.create({ bookId: 'A', dir: d, log: () => {} });
  assert.equal(h2.isHalted(), true, 'state file re-latches');
  assert.equal(h2.canOpen().ok, false);
  fs.unlinkSync(path.join(d, 'halt-A.json'));
  const h3 = paperHalt.create({ bookId: 'A', dir: d, log: () => {} });
  assert.equal(h3.isHalted(), true, 'HALT file re-latches without state');
  fs.rmSync(d, { recursive: true });
});

// ---------- 4. stop enforcement ----------
t('stop-enforcement: poll-end breach fires; no breach above the stop', () => {
  assert.equal(stopEnf.isStopBreach({ pnlPct: -20.5, emergencyDrop: 0.2 }).breach, true);
  assert.equal(stopEnf.isStopBreach({ pnlPct: -20, emergencyDrop: 0.2 }).breach, true);
  assert.equal(stopEnf.isStopBreach({ pnlPct: -19.9, emergencyDrop: 0.2 }).breach, false);
  assert.equal(stopEnf.checkStopNow({ pnlPct: -25, emergencyDrop: 0.2 }).close, true);
  assert.equal(stopEnf.checkStopNow({ pnlPct: -5, emergencyDrop: 0.2 }).close, false);
});
t('stop-enforcement: a breach BETWEEN polls is caught even after the price recovers (the Batch 1 gap leg)', () => {
  // The Batch 1 leg: -0.89% at one poll, -27.86% inside the next poll
  // interval, then a recovery. Previously the stop never fired if the
  // poll-end price was back above -20%.
  const pos = {};
  stopEnf.updateWorstPnl(pos, -0.89);
  stopEnf.updateWorstPnl(pos, -27.86); // intra-poll observation
  assert.equal(pos.worstPnlPct, -27.86);
  stopEnf.updateWorstPnl(pos, -15); // recovery does not erase the worst
  assert.equal(pos.worstPnlPct, -27.86);
  const r = stopEnf.isStopBreach({ pnlPct: -15, worstPnlPct: pos.worstPnlPct, emergencyDrop: 0.2 });
  assert.equal(r.breach, true);
  assert.equal(r.basis, 'worst-intra-poll');
});
t('stop-enforcement: decide() fires emergency_stop on the intra-poll worst, not only on the poll price', () => {
  const settings = { EMERGENCY_DROP: 0.2, EMERGENCY_SLPLUS_ENABLED: false, MAX_HOURS: 12, STALE_CLOSE_ENABLED: false, OOR_RIGHT_CLOSE: false, TP_USD_PCT: 13 };
  const base = () => ({
    minBinId: 100, maxBinId: 170, binStep: 100, entryActiveBin: 150,
    openedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    capitalAsset: 'USDC',
  });
  const val = (pnlPct) => ({ pnlPct, pnlCapital: pnlPct, pnlUsd: pnlPct, quoted: true, usdcOut: 100 });
  // Gap leg replayed through decide(): worst -27.86% observed, poll at -15%.
  const pos = base();
  paperExit.updateWorstPnl(pos, -0.89);
  paperExit.updateWorstPnl(pos, -27.86);
  assert.equal(paperExit.decide({ pos, val: val(-15), activeBin: 150, settings }), 'emergency_stop');
  // Same leg without the intra-poll dip stays open.
  const pos2 = base();
  paperExit.updateWorstPnl(pos2, -0.89);
  assert.equal(paperExit.decide({ pos: pos2, val: val(-15), activeBin: 150, settings }), null);
  // A healthy leg never stops.
  const pos3 = base();
  assert.equal(paperExit.decide({ pos: pos3, val: val(2), activeBin: 150, settings }), null);
  assert.equal(pos3.worstPnlPct, 2);
  // Poll-end breach still fires exactly as before.
  const pos4 = base();
  assert.equal(paperExit.decide({ pos: pos4, val: val(-21), activeBin: 150, settings }), 'emergency_stop');
});

// ---------- 5. stamps (§5.6) ----------
const fakePool = {
  address: 'POOL1', name: 'TEST-SOL', tvl: 20000, created_at: Date.now() / 1000 - 3600,
  token_x: { address: 'MINT1', market_cap: 400000, price: 1 },
  token_y: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', price: 70 },
  token_x_amount: 1000, token_y_amount: 100,
  fees: { '1h': 10, '4h': 40 }, fee_tvl_ratio: { '1h': 0.05, '4h': 0.2, '24h': 1.2, '30m': 0.9 },
  volume: { '5m': 500, '30m': 3000, '1h': 5000, '24h': 100000 },
  pool_config: { bin_step: 100 },
};
t('stamps: scan row carries §5.6 fields incl. smart-wallet null + status, vol5m, feeTvl24h, ftBand, comparison band', () => {
  const row = stamps.buildScanRow(fakePool, {
    at: '2026-11-26T00:00:00.000Z', instance: 'B1', scanStartedAt: '2026-11-26T00:00:00.000Z',
    nowS: Date.now() / 1000, ftWindow: '30m', feeTvlFn: (p, w) => p.fee_tvl_ratio?.[w] ?? null,
    pickByAddress: new Map(), basicSet: new Set(), reasonsByAddress: new Map(),
  });
  assert.equal(row.smartWallet, null);
  assert.match(row.smartWalletStatus, /H12 untestable/);
  assert.equal(row.vol5mUsd, 500);
  assert.equal(row.feeTvl24h, 1.2);
  assert.equal(row.feeTvlTrailing24h, 1.2);
  assert.equal(row.ftBand, '>=0.80%');
  assert.equal(row.isComparisonBand, false);
  assert.equal(row.uniqueTrades, null);
  assert.match(row.uniqueTradesStatus, /spike rule as stated stays untestable/);
  assert.equal(row.healthScore, null);
  assert.equal(row.organicPct, null);
  assert.equal(row.pump5m, null);
  assert.equal(row.binsBelow, null);
});
t('stamps: ftBand + comparison band mark the H4 band (0.60–0.80% at TVL >= $10k)', () => {
  assert.equal(stamps.ftBandOf(0.25), '<0.30%');
  assert.equal(stamps.ftBandOf(0.40), '0.30-0.45%');
  assert.equal(stamps.ftBandOf(0.55), '0.45-0.60%');
  assert.equal(stamps.ftBandOf(0.70), '0.60-0.80%');
  assert.equal(stamps.ftBandOf(1.5), '>=0.80%');
  assert.equal(stamps.ftBandOf(null), null);
  const row = stamps.buildScanRow({ ...fakePool, fee_tvl_ratio: { '30m': 0.70 } }, {
    at: '2026-11-26T00:00:00.000Z', instance: 'B1', nowS: Date.now() / 1000, ftWindow: '30m',
    feeTvlFn: (p, w) => p.fee_tvl_ratio?.[w] ?? null,
    pickByAddress: new Map(), basicSet: new Set(), reasonsByAddress: new Map(),
  });
  assert.equal(row.ftBand, '0.60-0.80%');
  assert.equal(row.isComparisonBand, true);
});
t('stamps: poll row carries binsBelow/totalBins/worstDrawdownPct from the open position (§5.6 #6/#8)', () => {
  const row = stamps.buildPollRow(fakePool, {
    at: '2026-11-26T00:00:00.000Z', instance: 'B1',
    feeTvlFn: (p, w) => p.fee_tvl_ratio?.[w] ?? null,
    position: { entryActiveBin: 150, minBinId: 100, maxBinId: 170, worstPnlPct: -12.4 },
  });
  assert.equal(row.binsBelow, 51);
  assert.equal(row.totalBins, 71);
  assert.equal(row.worstDrawdownPct, -12.4);
  const noPos = stamps.buildPollRow(fakePool, { at: '2026-11-26T00:00:00.000Z', feeTvlFn: (p, w) => p.fee_tvl_ratio?.[w] ?? null });
  assert.equal(noPos.worstDrawdownPct, null);
});
t('stamps: open-attempt rows label the book (§5.6 #11) with a null syncGroup (§5.6 #12)', () => {
  const row = stamps.buildOpenAttemptRow({ pool: fakePool, bookId: 'E', result: 'opened', at: '2026-11-26T00:00:00.000Z', instance: 'B1' });
  assert.equal(row.kind, 'open-attempt');
  assert.equal(row.bookId, 'E');
  assert.equal(row.result, 'opened');
  assert.equal(row.syncGroup, null);
  const skipped = stamps.buildOpenAttemptRow({ pool: fakePool, bookId: 'A', result: 'skipped', skipReason: 'halt latched [A]: P1-consec-emergency-stops' });
  assert.equal(skipped.result, 'skipped');
  assert.match(skipped.skipReason, /halt latched/);
});

// ---------- 6. paper-history CSV (§5.6 #8/#11/#12) ----------
t('history: csv() carries worst drawdown, book id and sync group', () => {
  const h = {
    variant: 'E', worstPnlPct: -27.86, syncGroup: null, capitalAsset: 'USDC',
    pnlCapital: 10, pnlCapitalPct: 2, openedAt: '2026-11-26T10:00:00.000Z',
    openContext: { source: 'Auto (bot)', snapshot: { strategy: 'E' } },
    closeReasonText: 'Take profit USDC +13%',
  };
  const row = paperHistory.csv(h);
  assert.equal(row.entry_worst_drawdown_pct, -27.86);
  assert.equal(row.entry_book_id, 'E');
  assert.equal(row.entry_sync_group, null);
  const noWorst = paperHistory.csv({ ...h, worstPnlPct: undefined });
  assert.equal(noWorst.entry_worst_drawdown_pct, null);
});

// ---------- 7. bot.js wiring (source checks) ----------
t('wiring: bot.js loads the config at start and fails fast on an invalid one', () => {
  assert.ok(/configLoader\.loadConfig\(\)/.test(botSrc), 'loads config');
  assert.ok(/REFUSING START/.test(botSrc), 'refuses start on invalid config');
  assert.ok(/const WC = WARLOCK_CONFIG\.profile/.test(botSrc), 'resolved profile WC');
});
t('wiring: no hard-coded strategy literals left in the CFG block (moved parameters come from WC)', () => {
  const cfg = botSrc.slice(botSrc.indexOf('const CFG = {'), botSrc.indexOf('};', botSrc.indexOf('const CFG = {')));
  for (const key of ['MIN_FT', 'MAX_PUMP1H', 'MIN_AGE_H', 'MIN_LIQ_USD', 'MAX_POSITIONS', 'POSITION_USDC', 'EMERGENCY_DROP', 'MAX_HOURS', 'POLL_SEC', 'RESHAPE_MAX', 'MAX_PUMP_24H', 'MIN_BIN_STEP', 'MAX_BIN_STEP', 'MIN_VOL_1H', 'VOL_SPIKE_1H_OF_24H', 'TP_USD_PCT', 'EMERGENCY_TP_PCT', 'GAS_BUFFER_SOL', 'POSITION_SOL']) {
    assert.ok(!new RegExp(`process\\.env\\.${key}`).test(cfg), `CFG still reads env for ${key}`);
  }
  for (const lit of ['|| 300', '|| 0.20', '|| 0.15', '|| 0.50', '|| 10000', '|| 100000']) {
    assert.ok(!cfg.includes(lit), `CFG still has literal fallback ${lit}`);
  }
  assert.ok(/MIN_FT: WC\.screening\.minFt/.test(cfg), 'MIN_FT from config');
  assert.ok(/EMERGENCY_DROP: WC\.exits\.emergencyDrop/.test(cfg), 'EMERGENCY_DROP from config');
  assert.ok(/POLL_SEC: WC\.management\.pollSec/.test(cfg), 'POLL_SEC from config');
  assert.ok(/MAX_POSITIONS: WC\.sizing\.maxPositions/.test(cfg), 'MAX_POSITIONS from config');
  assert.ok(/H17_ENABLED: WC\.h17\.enabled/.test(cfg), 'H17 flag from config');
});
t('wiring: paper halt executor gates opens and records closes in bot.js', () => {
  assert.ok(/paperHaltFor\(x\.id\)\.canOpen\(\)\.ok/.test(botSrc), 'canOpenInSomeBook gated');
  assert.ok(/haltOpenable\(v\) && openable/.test(botSrc), 'paperOpenAll gated');
  assert.ok(/paperHaltFor\(variant\.id\)\.recordClose\(\{pnlUsd:val\.pnlUsd,reason,pool:pos\.pool,openedAt:pos\.openedAt\}\)/.test(botSrc), 'paperClose records closes');
  assert.ok(/HALT refuses open into/.test(botSrc), 'halted fan-out logged');
  assert.ok(/paperHalt: VARIANTS\.map\(\(v\) => paperHaltFor\(v\.id\)\.status\(\)\)/.test(botSrc), 'halt status in paper status');
});
t('wiring: H17 hook sits in the scan loop after the pump checks', () => {
  const i = botSrc.indexOf('H17 pump-cliff reject');
  assert.ok(i > 0, 'H17 hook present');
  assert.ok(/h17\.isH17Reject\(\{ pump1h: pu, pump24h: pu24 \}, WC\.h17\)/.test(botSrc), 'H17 evaluated on pick pumps');
});
t('wiring: startup log names the active profile and the halt bars (no hard-coded book/size string)', () => {
  assert.ok(/profile=\$\{WARLOCK_CONFIG\.profileName\}/.test(botSrc), 'profile in startup log');
  assert.ok(!/4 books x \$1000, \$500\/position, max 10\/book/.test(botSrc), 'old hard-coded sizing string gone');
});

// ---------- 8. settings/strategy derive from the config ----------
t('wiring: paper-settings and paper-strategy defaults follow the active profile', () => {
  const ps = require('./paper-settings');
  const st = require('./paper-strategy');
  const p = loader.loadConfig().profile;
  assert.equal(ps.DEFAULTS.MIN_FT, p.screening.minFt);
  assert.equal(ps.DEFAULTS.MAX_POSITIONS, p.sizing.maxPositions);
  assert.equal(ps.DEFAULTS.MAX_PUMP1H, p.screening.maxPump1h);
  assert.equal(ps.DEFAULTS.MAX_PUMP_24H, p.screening.maxPump24h);
  assert.equal(ps.DEFAULTS.TP_USD_PCT, p.exits.tpUsdPct);
  assert.equal(ps.DEFAULTS.EMERGENCY_DROP, p.exits.emergencyDrop);
  assert.equal(st.DEFAULTS.RANGE_DOWN_PCT, p.geometry.rangeDownPct);
  assert.equal(st.DEFAULTS.MAX_POSITION_TVL_PCT, p.geometry.maxPositionTvlPct);
});

console.log(`all ${n} tests passed`);
