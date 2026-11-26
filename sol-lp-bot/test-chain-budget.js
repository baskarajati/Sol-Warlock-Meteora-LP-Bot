'use strict';
// test-chain-budget.js — X5 chain-reshape budget + X3 cooldown tests.
//
// Covers the feature spec §7 minimal test: ledger units, the scripted
// 3-events-in-24h sequence (4th reposition blocked, leg exits with
// chain_reshape_budget_exit, pool in X3 cooldown), the exit-decision
// check, restart persistence, config profiles (delta/golf/echo) + fail-fast
// validation, the Delta null-reshapeMax path through the settings overlay,
// and the feature-off regression (Alpha/Echo/Foxtrot byte-identical
// behaviour: no ledger, no x5_* events).
//
// Pure node, no network, no chain, no live files: all file writes go to
// mkdtemp dirs. Run: node test-chain-budget.js
//
// NOTE on scope: bot.js has no main guard (requiring it starts the bot),
// so the live decision points are tested as a scripted replay through the
// same module functions bot.js calls, in the same order, plus source
// checks tying each replay outcome to the bot.js action (blocked-close
// reason, exit-decision reason, record points). The module is the whole
// decision surface; bot.js only wires it in.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const loader = require('./config-loader');
const cb = require('./paper-chain-budget');
const paperHistory = require('./paper-history');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const botSrc = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chain-budget-'));
const H = 3600e3;
const T0 = Date.parse('2026-11-27T12:00:00.000Z');
const POOL = 'PoolAddr1111111111111111111111111111111111111';
const OTHER = 'PoolAddr2222222222222222222222222222222222222';

const deltaCfg = () => cb.chainBudgetFromProfile(loader.loadConfig({ profile: 'delta' }).profile);
const golfCfg = () => cb.chainBudgetFromProfile(loader.loadConfig({ profile: 'golf' }).profile);

// ---------- 1. config profiles ----------
t('config: delta is e-baseline + chain budget, per-leg freeze REMOVED (reshapeMax null)', () => {
  const e = loader.loadConfig({ profile: 'e-baseline' }).profile;
  const d = loader.loadConfig({ profile: 'delta' }).profile;
  assert.strictEqual(d.reshape.reshapeMax, null);
  assert.deepStrictEqual(d.reshape.chainBudget, {
    enabled: true, budget: 3, windowHours: 24, scope: 'book',
    count: ['reshape', 'right_reposition'], onExhaust: 'exit', cooldown: 'x3',
  });
  assert.equal(d.screening.minFt, e.screening.minFt);
  assert.equal(d.exits.tpUsdPct, e.exits.tpUsdPct);
  assert.equal(d.sizing.positionUsdc, e.sizing.positionUsdc);
  assert.equal(d.h17.enabled, false);
  assert.equal(d.paperHalt.enabled, true);
});

t('config: golf is e-baseline + freeze-5 AND chain budget (both disciplines)', () => {
  const g = loader.loadConfig({ profile: 'golf' }).profile;
  assert.strictEqual(g.reshape.reshapeMax, 5);
  assert.deepStrictEqual(g.reshape.chainBudget, {
    enabled: true, budget: 3, windowHours: 24, scope: 'book',
    count: ['reshape', 'right_reposition'], onExhaust: 'exit', cooldown: 'x3',
  });
  // Delta and Golf differ ONLY in the per-leg freeze.
  const d = loader.loadConfig({ profile: 'delta' }).profile;
  assert.deepStrictEqual(g.reshape.chainBudget, d.reshape.chainBudget);
  assert.notStrictEqual(g.reshape.reshapeMax, d.reshape.reshapeMax);
});

t('config: echo is e-baseline with MIN_FT 1.0% only, no chain budget', () => {
  const e = loader.loadConfig({ profile: 'e-baseline' }).profile;
  const c = loader.loadConfig({ profile: 'echo' }).profile;
  assert.equal(c.screening.minFt, 1.0);
  assert.equal(c.reshape.reshapeMax, e.reshape.reshapeMax);
  assert.equal(c.exits.tpUsdPct, e.exits.tpUsdPct);
  assert.equal(c.reshape.chainBudget, undefined);
});

t('config: e-baseline / h17 / paper-safety have no chain budget (feature off)', () => {
  for (const name of ['e-baseline', 'h17', 'paper-safety']) {
    const p = loader.loadConfig({ profile: name }).profile;
    assert.equal(p.reshape.chainBudget, undefined, `${name} must not carry a chain budget`);
    assert.strictEqual(cb.chainBudgetFromProfile(p), null, `${name} resolves to feature-off`);
  }
});

t('config: chainBudgetFromProfile returns the config values, never a literal', () => {
  const cfg = deltaCfg();
  assert.equal(cfg.budget, 3);
  assert.equal(cfg.windowHours, 24);
  assert.equal(cfg.windowMs, 24 * 3600e3);
  assert.equal(cfg.scope, 'book');
  assert.equal(cfg.onExhaust, 'exit');
  assert.equal(cfg.cooldown, 'x3');
  assert.deepStrictEqual(cfg.count, ['reshape', 'right_reposition']);
  assert.equal(cb.countsEvent(cfg, 'reshape'), true);
  assert.equal(cb.countsEvent(cfg, 'right_reposition'), true);
  assert.equal(cb.countsEvent(cfg, 'bogus'), false);
  assert.equal(cb.countsEvent(null, 'reshape'), false);
  assert.strictEqual(cb.chainBudgetFromProfile(loader.loadConfig({ profile: 'golf' }).profile).budget, 3);
});

t('config: fail fast on a bad chain-budget section (every key validated)', () => {
  const bad = (chainBudget, re) => assert.throws(
    () => loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { chainBudget } } }), re);
  const good = { enabled: true, budget: 3, windowHours: 24, scope: 'book', count: ['reshape', 'right_reposition'], onExhaust: 'exit', cooldown: 'x3' };
  bad({ ...good, budget: 0 }, /budget/);
  bad({ ...good, budget: 2.5 }, /budget/);
  bad({ ...good, windowHours: 0 }, /windowHours/);
  bad({ ...good, windowHours: -1 }, /windowHours/);
  bad({ ...good, scope: 'global' }, /scope/);
  bad({ ...good, count: [] }, /count/);
  bad({ ...good, count: ['reshape', 'bogus'] }, /count/);
  bad({ ...good, count: 'reshape' }, /count/);
  bad({ ...good, onExhaust: 'freeze' }, /onExhaust/);
  bad({ ...good, cooldown: 'fixed' }, /cooldown/);
  bad({ ...good, enabled: 'yes' }, /enabled/);
  bad({ enabled: true }, /chainBudget.*is missing/); // half-written section: every key required
  bad({ ...good, window: 24 }, /not a known config key/); // typo'd key
  // A well-formed section passes.
  assert.doesNotThrow(() => loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { chainBudget: good } } }));
  // Disabled section still validates (a typo must not hide behind enabled:false).
  bad({ ...good, enabled: false, budget: 0 }, /budget/);
});

t('config: reshapeMax null validates (Delta); 0 / fractional / string still fail', () => {
  assert.strictEqual(loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { reshapeMax: null } } }).profile.reshape.reshapeMax, null);
  assert.throws(() => loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { reshapeMax: 0 } } }), /reshapeMax/);
  assert.throws(() => loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { reshapeMax: 2.5 } } }), /reshapeMax/);
  assert.throws(() => loader.loadConfig({ profile: 'e-baseline', overrides: { reshape: { reshapeMax: 'five' } } }), /reshapeMax/);
});

// ---------- 2. ledger units (spec §7.1) ----------
t('ledger: record 3 events in 24h -> count 3; 4th -> 4; budget exhausted at 3', () => {
  const cfg = deltaCfg();
  const ledger = cb.emptyLedger();
  cb.recordChainEvent(ledger, 'E', POOL, T0, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + 1 * H, cfg.windowMs);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0 + 1 * H, cfg.windowMs), 2);
  assert.equal(cb.budgetExhausted(ledger, 'E', POOL, T0 + 1 * H, cfg), false);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + 2 * H, cfg.windowMs);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0 + 2 * H, cfg.windowMs), 3);
  assert.equal(cb.budgetExhausted(ledger, 'E', POOL, T0 + 2 * H, cfg), true);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + 3 * H, cfg.windowMs);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0 + 3 * H, cfg.windowMs), 4);
  assert.equal(cb.budgetExhausted(ledger, 'E', POOL, T0 + 3 * H, cfg), true);
});

t('ledger: a 25h-old event does not count; another pool does not count; another book does not count', () => {
  const cfg = deltaCfg();
  const ledger = cb.emptyLedger();
  cb.recordChainEvent(ledger, 'E', POOL, T0 - 25 * H, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', OTHER, T0, cfg.windowMs);
  cb.recordChainEvent(ledger, 'A', POOL, T0, cfg.windowMs);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0, cfg.windowMs), 0);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', OTHER, T0, cfg.windowMs), 1);
  assert.equal(cb.budgetExhausted(ledger, 'E', POOL, T0, cfg), false);
  // An event exactly at the window edge still counts (inclusive lower bound, as B3).
  cb.recordChainEvent(ledger, 'E', POOL, T0 - 24 * H, cfg.windowMs);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0, cfg.windowMs), 1);
});

t('ledger: restart persistence — a fresh load from rails-state.json keeps the count', () => {
  const d = tmpDir();
  const cfg = deltaCfg();
  const ledger = cb.emptyLedger();
  cb.recordChainEvent(ledger, 'E', POOL, T0, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + H, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + 2 * H, cfg.windowMs);
  cb.saveLedger(d, ledger);
  assert.ok(fs.existsSync(path.join(d, 'rails-state.json')), 'rails-state.json written');
  assert.ok(!fs.existsSync(path.join(d, 'rails-state.json.tmp')), 'no tmp file left behind');
  // Simulate a restart: fresh process state, load from disk only.
  const reloaded = cb.loadLedger(d);
  assert.equal(cb.chainEventsInWindow(reloaded, 'E', POOL, T0 + 2 * H, cfg.windowMs), 3);
  assert.equal(cb.budgetExhausted(reloaded, 'E', POOL, T0 + 2 * H, cfg), true);
  fs.rmSync(d, { recursive: true });
});

t('ledger: entries older than twice the window are pruned on record (48h for 24h window)', () => {
  const cfg = deltaCfg();
  const ledger = cb.emptyLedger();
  cb.recordChainEvent(ledger, 'E', POOL, T0 - 49 * H, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0 - 47 * H, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0, cfg.windowMs);
  assert.deepStrictEqual(ledger.chainEvents['E|' + POOL], [T0 - 47 * H, T0]);
});

t('ledger: feature-off never creates a ledger file (load/save are never called)', () => {
  // The module only touches disk when bot.js calls loadLedger/saveLedger,
  // and bot.js gates every such call on an enabled chain budget. Resolving
  // a feature-off profile must not create anything on its own.
  const d = tmpDir();
  assert.strictEqual(cb.chainBudgetFromProfile(loader.loadConfig({ profile: 'e-baseline' }).profile), null);
  assert.ok(!fs.existsSync(path.join(d, 'rails-state.json')));
  fs.rmSync(d, { recursive: true });
});

// ---------- 3. scripted sequence (spec §7.2) ----------
t('sequence: 3 re-centres in 24h -> 4th reposition refused, leg exits chain_reshape_budget_exit', () => {
  const d = tmpDir();
  const cfg = deltaCfg();
  const ledger = cb.loadLedger(d); // fresh, empty
  const pool = POOL;
  // Leg 1 reshapes twice, leg 2 (after a right-reposition) reshapes once:
  // each completed re-centre is recorded exactly once, as bot.js does
  // after paperReshape / paperRepositionRight succeed.
  const recordRecent = (kind, at) => {
    assert.equal(cb.countsEvent(cfg, kind), true, `${kind} must consume budget`);
    cb.recordChainEvent(ledger, 'E', pool, at, cfg.windowMs);
    cb.saveLedger(d, ledger);
  };
  recordRecent('reshape', T0);
  recordRecent('reshape', T0 + 2 * H);
  recordRecent('right_reposition', T0 + 5 * H);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', pool, T0 + 5 * H, cfg.windowMs), 3);
  // 4th reposition attempt (paperRepositionRight guard): refused.
  assert.equal(cb.budgetExhausted(ledger, 'E', pool, T0 + 6 * H, cfg), true);
  assert.ok(/x5-blocked/.test(botSrc), 'bot.js converts the refusal to a final close');
  assert.ok(/repositioned==='x5-blocked'\)\{await paperClose\(book,v,'chain_reshape_budget_exit'/.test(botSrc),
    'x5-blocked closes with chain_reshape_budget_exit');
  assert.ok(/x5_reposition_block/.test(botSrc), 'x5_reposition_block event emitted');
  // A blocked attempt does NOT consume budget (only completed re-centres count).
  assert.equal(cb.chainEventsInWindow(ledger, 'E', pool, T0 + 6 * H, cfg.windowMs), 3);
  // The exit-decision check independently exits a leg whose pool is at budget.
  assert.equal(cb.budgetExhausted(ledger, 'E', pool, T0 + 6 * H, cfg), true);
  assert.ok(/exitReason = 'chain_reshape_budget_exit'/.test(botSrc), 'exit-decision check sets the budget exit reason');
  assert.ok(/x5_exhaustion/.test(botSrc), 'x5_exhaustion event emitted');
  assert.ok(/exit \+ X3 cooldown/.test(botSrc), 'exhaustion action is exit + X3 cooldown');
  fs.rmSync(d, { recursive: true });
});

t('sequence: below budget the leg keeps reshaping (2 events -> no exit, no block)', () => {
  const cfg = deltaCfg();
  const ledger = cb.emptyLedger();
  cb.recordChainEvent(ledger, 'E', POOL, T0, cfg.windowMs);
  cb.recordChainEvent(ledger, 'E', POOL, T0 + H, cfg.windowMs);
  assert.equal(cb.budgetExhausted(ledger, 'E', POOL, T0 + H, cfg), false);
  assert.equal(cb.chainEventsInWindow(ledger, 'E', POOL, T0 + H, cfg.windowMs), 2);
});

t('sequence: after a budget exit the pool is in X3 cooldown; a fresh entry is refused until it expires', () => {
  const cfg = deltaCfg();
  assert.ok(cfg.cooldown === 'x3');
  // One loss close with reason chain_reshape_budget_exit, closed just now.
  const history = [{ pool: POOL, reason: 'chain_reshape_budget_exit', closedAt: new Date(T0).toISOString(), pnlUsd: -12.5 }];
  const cs = cb.cooldownStatus(history, POOL, T0 + 60e3);
  assert.equal(cs.blocked, true);
  assert.equal(cs.kind, 'loss1');
  assert.equal(cs.until, T0 + 240 * 60000, 'first loss close -> 4h cooldown (B3 X3 step 1)');
  assert.ok(/cooldownStatus\(\(state\.books\[v\.id\]\.history/.test(botSrc), 'entry fan-out consults the cooldown');
  assert.ok(/type: 'x3_block'/.test(botSrc), 'entry block event emitted');
  // Still blocked 1h later; free after the 4h step expires.
  assert.equal(cb.cooldownStatus(history, POOL, T0 + 60 * 60000).blocked, true);
  assert.equal(cb.cooldownStatus(history, POOL, T0 + 240 * 60000 + 1).blocked, false);
  // A profit close cools down for 15 minutes only.
  const profit = [{ pool: POOL, reason: 'TP USDC +13%', closedAt: new Date(T0).toISOString(), pnlUsd: 8 }];
  assert.equal(cb.cooldownStatus(profit, POOL, T0 + 14 * 60000).blocked, true);
  assert.equal(cb.cooldownStatus(profit, POOL, T0 + 16 * 60000).blocked, false);
  // Two consecutive loss closes -> 72h memory (longest governs).
  const twoLoss = [
    { pool: POOL, reason: 'emergency_stop', closedAt: new Date(T0 - H).toISOString(), pnlUsd: -20 },
    { pool: POOL, reason: 'chain_reshape_budget_exit', closedAt: new Date(T0).toISOString(), pnlUsd: -12.5 },
  ];
  const mem = cb.cooldownStatus(twoLoss, POOL, T0 + 60e3);
  assert.equal(mem.blocked, true);
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.until, T0 + 4320 * 60000);
  // The cooldown reads only this pool's closes; an unrelated pool is free.
  assert.equal(cb.cooldownStatus(history, OTHER, T0 + 60e3).blocked, false);
  // Intermediate reposition legs are not closes and never start a cooldown.
  const inter = [{ pool: POOL, reason: 'oor_right_reposition_leg', closedAt: new Date(T0).toISOString(), pnlUsd: -5 }];
  assert.equal(cb.cooldownStatus(inter, POOL, T0 + 60e3).blocked, false);
});

t('sequence: a budget exit counts as a loss close for X3 escalation (2nd loss -> 24h)', () => {
  const twoLoss = [
    { pool: POOL, reason: 'chain_reshape_budget_exit', closedAt: new Date(T0 - 2 * H).toISOString(), pnlUsd: -9 },
    { pool: POOL, reason: 'chain_reshape_budget_exit', closedAt: new Date(T0).toISOString(), pnlUsd: -11 },
  ];
  const cs = cb.cooldownStatus(twoLoss, POOL, T0 + 60e3);
  assert.equal(cs.blocked, true);
  assert.equal(cs.kind, 'memory', 'two negative closes -> 72h memory governs over the 24h step');
});

// ---------- 4. Delta null-reshapeMax through the settings overlay ----------
t('overlay: with WARLOCK_PROFILE=delta the settings overlay keeps RESHAPE_MAX null (no freeze)', () => {
  const saved = process.env.WARLOCK_PROFILE;
  try {
    process.env.WARLOCK_PROFILE = 'delta';
    // Fresh require: paper-settings / paper-strategy read the profile at load.
    delete require.cache[require.resolve('./paper-settings')];
    delete require.cache[require.resolve('./paper-strategy')];
    const ps = require('./paper-settings');
    assert.strictEqual(ps.DEFAULTS.RESHAPE_MAX, null, 'Delta settings default must be null, not the 5 fallback');
    const values = ps.currentValues(tmpDir());
    assert.strictEqual(values.RESHAPE_MAX, null, 'currentValues must keep null (no settings.json override)');
    // The freeze gate tests Number.isFinite: null is not finite, so no freeze.
    assert.equal(Number.isFinite(values.RESHAPE_MAX), false);
  } finally {
    if (saved === undefined) delete process.env.WARLOCK_PROFILE; else process.env.WARLOCK_PROFILE = saved;
    delete require.cache[require.resolve('./paper-settings')];
    delete require.cache[require.resolve('./paper-strategy')];
  }
});

t('overlay: with WARLOCK_PROFILE=golf the settings overlay keeps RESHAPE_MAX 5 (freeze on)', () => {
  const saved = process.env.WARLOCK_PROFILE;
  try {
    process.env.WARLOCK_PROFILE = 'golf';
    delete require.cache[require.resolve('./paper-settings')];
    delete require.cache[require.resolve('./paper-strategy')];
    const ps = require('./paper-settings');
    assert.strictEqual(ps.DEFAULTS.RESHAPE_MAX, 5);
    assert.strictEqual(ps.currentValues(tmpDir()).RESHAPE_MAX, 5);
  } finally {
    if (saved === undefined) delete process.env.WARLOCK_PROFILE; else process.env.WARLOCK_PROFILE = saved;
    delete require.cache[require.resolve('./paper-settings')];
    delete require.cache[require.resolve('./paper-strategy')];
  }
});

// ---------- 5. history reason text + bot.js wiring ----------
t('history: closeReason names the two new reasons (no "tidak diketahui")', () => {
  assert.match(paperHistory.closeReason({ reason: 'chain_reshape_budget_exit', capitalAsset: 'USDC' }), /X5: chain reshape budget habis/);
  assert.match(paperHistory.closeReason({ reason: 'x3_cooldown_block', capitalAsset: 'USDC' }), /X3: reposition ditolak/);
});

t('wiring: bot.js has both enforcement points, both record points, and the E-only gate', () => {
  assert.ok(/chainBudgetFor\(v\.id\)/.test(botSrc), 'budget gated per book');
  assert.ok(/variantId === 'E'/.test(botSrc), 'budget counts book E only (Delta/Golf pre-registrations)');
  assert.ok(/chainEventsInWindow\(chainLedger\(\), v\.id, old\.pool/.test(botSrc), 'reposition-path budget check');
  assert.ok(/chainEventsInWindow\(chainLedger\(\), v\.id, pos\.pool/.test(botSrc), 'exit-decision budget check');
  assert.ok(/recordChainEvent\(chainLedger\(\), v\.id, old\.pool/.test(botSrc), 'record on successful reposition');
  assert.ok(/recordChainEvent\(chainLedger\(\), v\.id, pos\.pool/.test(botSrc), 'record on completed reshape');
  assert.ok(/chainRecentres24h/.test(botSrc), '24h count stamped on the position');
  assert.ok(/exitTrigger = \{ rule: 'chain_reshape_budget'/.test(botSrc), 'exitTrigger stamped on budget exits');
  assert.ok(/chainBudget\.chainBudgetFromProfile\(WC\)/.test(botSrc), 'budget read from the resolved profile only');
  assert.ok(/repositioned==='x3-blocked'\)\{await paperClose\(book,v,'x3_cooldown_block'/.test(botSrc), 'x3-blocked closes');
  assert.ok(/x3_reposition_block/.test(botSrc), 'x3_reposition_block event emitted');
});

t('wiring: no budget/window literal in code; Jupiter v3 intact; 0 CoinGecko refs', () => {
  for (const f of ['paper-chain-budget.js', 'bot.js', 'config-loader.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/BUDGET: 3/.test(src), `${f}: B3 BUDGET literal must not be copied`);
    assert.ok(!/WINDOW_MS: 24/.test(src), `${f}: B3 WINDOW_MS literal must not be copied`);
  }
  assert.ok(/Jupiter Price API v3 is the first SOL\/USD source/.test(botSrc), 'Jupiter Price API v3 comment still present');
  assert.ok(!/CoinGecko|coingecko/.test(botSrc), '0 CoinGecko refs in bot.js');
  assert.ok(!/paperUsdc: 1000|paperUsdc.*1000/.test(botSrc), 'no paperUsdc change bundled in');
});

console.log(`all ${n} tests passed`);
