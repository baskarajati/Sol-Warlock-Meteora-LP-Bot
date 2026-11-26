'use strict';
// config-loader.js — Warlock system-configurable v1.
//
// Loads sol-lp-bot/config/warlock-config.json at bot start, resolves one
// named profile (WARLOCK_PROFILE env, default = file's activeProfile),
// validates EVERY value, and fails fast: a bad value throws before the
// bot opens, scans, or touches any position — never a silent fallback to
// a number the operator did not choose. (The live halt module keeps its
// own per-key safe defaults for halt-params.json; this loader is stricter
// on purpose: a strategy config typo must stop the start, not arm a
// different strategy.)
//
// Precedence, highest first: explicit overrides passed to loadConfig()
// (tests / a future CLI) > WARLOCK_PROFILE selection > file's
// activeProfile. Env vars for individual strategy numbers are NOT read
// here — the config file is the single source of truth; bot.js keeps env
// overrides only for deployment facts (paths, RPC, PAPER/DRY_RUN gates).
// paper-settings.json (mini-app Settings tab) still overlays on top at
// runtime via applyPaperSettings, as before; this file is the default
// the bot starts from.
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config', 'warlock-config.json');

// kind: 'frac' = (0,1] (0 allowed where noted via min 0), 'pos' = >0,
// 'nonneg' = >=0, 'count' = integer >=1, 'int0' = integer >=0,
// 'pct' = number (percent points), 'bool', 'enum', 'str'.
// Each entry: [kind, min, max] or {kind:'enum', options:[...]}.
const SCHEMA = {
  'entrySync.enabled': ['bool'],
  'execution.depth': ['pos'],
  'execution.priorityMicrolamports': ['count'],
  'execution.slippagePct': ['pos'],
  'execution.txFeeSol': ['pos'],
  'exits.emergencyDrop': ['frac'],
  'exits.emergencyTpEnabled': ['bool'],
  'exits.emergencyTpPct': ['pos'],
  'exits.emergencyTpTriggerRangePct': ['pos', 1, 100],
  'exits.maxHours': ['pos', 1, 168],
  'exits.oorMaxMin': ['nonneg'],
  'exits.oorRightClose': ['bool'],
  'exits.oorRightConfirmPolls': ['count'],
  'exits.oorRightMaxRepositions': ['int0'],
  'exits.oorRightMinBins': ['int0'],
  'exits.oorRightMinProfitPct': ['nonneg'],
  'exits.oorRightRepositionMinPnlPct': ['pct', -100, 0],
  'exits.quoteFailurePolls': ['count'],
  'exits.slPlusArmPct': ['pos'],
  'exits.slPlusConfirmPolls': ['count'],
  'exits.slPlusEnabled': ['bool'],
  'exits.slPlusFloorPct': ['pct', -5, 50],
  'exits.slPlusFloorPolls': ['count'],
  'exits.slPlusLockPct': ['pct', -5, 50],
  'exits.staleCloseEnabled': ['bool'],
  'exits.staleExitMode': [{ kind: 'enum', options: ['ANY', 'MINUS', 'BEP', 'PROFIT'] }],
  'exits.staleExitPct': ['nonneg'],
  'exits.tpUsdPct': ['pos', 0.1, 200],
  'exits.trailArmPct': ['pos'],
  'exits.trailDropPct': ['pos'],
  'exits.trailEnabled': ['bool'],
  'filters.antiPvpMinLiqUsd': ['nonneg'],
  'filters.antiPvpMode': [{ kind: 'enum', options: ['KEEP_BIGGEST', 'SKIP_ALL', 'OFF'] }],
  'filters.checkInsiders': ['bool'],
  'filters.checkTopHolders': ['bool'],
  'filters.feeTurnoverMaxPct': ['nonneg'],
  'filters.feeTurnoverTvlBelowUsd': ['nonneg'],
  'filters.filtersEnabled': ['bool'],
  'filters.maxDevHold': ['frac'],
  'filters.maxInsiderPct': ['pct', 0, 100],
  'filters.maxRugcheckScoreNorm': ['pos', 1, 100],
  'filters.maxTop10Hold': ['frac'],
  'filters.oldDumpFilterEnabled': ['bool'],
  'filters.oldDumpMaxPump24h': ['pct', -100, 1000],
  'filters.oldDumpMinAgeH': ['nonneg'],
  'filters.oldTokenMode': [{ kind: 'enum', options: ['BLOCK_ALL', 'DUMP_ONLY'] }],
  'filters.pump1hFilterEnabled': ['bool'],
  'filters.pump24hFilterEnabled': ['bool'],
  'filters.rugcheckEnabled': ['bool'],
  'filters.rugcheckStickyDays': ['int0'],
  'filters.slBlacklistEnabled': ['bool'],
  'filters.tvlDropFilterEnabled': ['bool'],
  'filters.tvlDropMaxPct': ['pct', 1, 99],
  'geometry.compoundSpotPct': ['pct', 0, 100],
  'geometry.lowerBins': ['int0'],
  'geometry.maxPositionTvlPct': ['pos', 0.01, 100],
  'geometry.openShape': [{ kind: 'enum', options: ['MIXED', 'SPOT', 'BIDASK'] }],
  'geometry.openSpotPct': ['pct', 0, 100],
  'geometry.rangeDownPct': ['pct', 0.1, 99.9],
  'geometry.rangeUpPct': ['pct', 0, 1000],
  'geometry.reshapeShape': [{ kind: 'enum', options: ['BIDASK', 'SPOT'] }],
  'geometry.upperBufferBins': ['int0'],
  'h17.enabled': ['bool'],
  'h17.pump1hHigh': ['pct', -100, 100],
  'h17.pump1hLow': ['pct', -100, 100],
  'h17.pump24hMin': ['pos'],
  'halt.bookSol': ['pos'],
  'halt.dailyLossPct': ['frac'],
  'halt.feedDegradedPolls': ['count'],
  'halt.feedStalePolls': ['count'],
  'halt.k1LegLossPct': ['frac'],
  'halt.k2DrawdownPct': ['frac'],
  'halt.k3ConsecEmergency': ['count'],
  'halt.k4ConsecLosses': ['count'],
  'halt.k4LossSumPct': ['frac'],
  'halt.k5Worst3Pct': ['frac'],
  'halt.k6MinLegs': ['count'],
  'halt.k6NetPct': ['frac'],
  'halt.k6WindowDays': ['pos'],
  'halt.k7MaxBreaches': ['count'],
  'halt.k8GapConsec': ['count'],
  'halt.k8GapSol': ['pos'],
  'halt.legSol': ['pos'],
  'halt.maxFeeBps': ['int0'],
  'halt.pollSec': ['pos'],
  'halt.reshapeMax': ['count'],
  'management.paperDays': ['pos'],
  'management.paperUsdc': ['nonneg'],
  'management.paperVirtualSol': ['nonneg'],
  'management.pollSec': ['pos', 5, 3600],
  'management.quoteRefreshMs': ['pos'],
  'paperHalt.bookUsd': ['pos'],
  'paperHalt.consecEmergencyStops': ['count'],
  'paperHalt.consecLossSumUsd': ['pos'],
  'paperHalt.consecLosses': ['count'],
  'paperHalt.drawdownUsd': ['pos'],
  'paperHalt.enabled': ['bool'],
  'reshape.compoundEnabled': ['bool'],
  'reshape.reshapeEnabled': ['bool'],
  'reshape.reshapeMax': ['count'],
  'reshape.reshapeN': ['count'],
  'screening.ageGateEnabled': ['bool'],
  'screening.feeTvlGate20Enabled': ['bool'],
  'screening.ftWindow': [{ kind: 'enum', options: ['30m', '1h', '2h', '4h', '12h', '24h'] }],
  'screening.maxBinStep': ['count'],
  'screening.maxLiqUsd': ['nonneg'],
  'screening.maxNonrefundSol': ['nonneg'],
  'screening.maxPump1h': ['pos'],
  'screening.maxPump24h': ['pos'],
  'screening.maxPump24hPct': ['pos'],
  'screening.minAgeH': ['nonneg'],
  'screening.minBinStep': ['count'],
  'screening.minFt': ['nonneg'],
  'screening.minLiqUsd': ['nonneg'],
  'screening.minVol1h': ['nonneg'],
  'screening.reopenCooldownMin': ['nonneg'],
  'screening.volSpike1hOf24h': ['frac'],
  'sizing.bookSol': ['pos'],
  'sizing.bookUsdc': ['pos'],
  'sizing.gasBufferSol': ['pos'],
  'sizing.legSol': ['pos'],
  'sizing.maxPosTvlFrac': ['frac'],
  'sizing.maxPositions': ['count', 1, 10],
  'sizing.positionSol': ['pos'],
  'sizing.positionUsdc': ['nonneg'],
  'sizing.reserveSol': ['nonneg'],
  'sizing.usdcBuffer': ['nonneg'],
};

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}
function checkValue(dotted, spec, value, problems) {
  const [kind, min, max] = Array.isArray(spec) ? spec : [spec];
  if (kind === 'bool') {
    if (typeof value !== 'boolean') problems.push(`${dotted}=${JSON.stringify(value)} must be boolean`);
    return;
  }
  if (kind && kind.kind === 'enum') {
    if (!kind.options.includes(value)) problems.push(`${dotted}=${JSON.stringify(value)} must be one of ${kind.options.join(', ')}`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${dotted}=${JSON.stringify(value)} must be a finite number`);
    return;
  }
  if (kind === 'frac' && !(value > 0 && value <= 1)) problems.push(`${dotted}=${value} must be a fraction in (0, 1]`);
  if (kind === 'pos' && !(value > 0)) problems.push(`${dotted}=${value} must be > 0`);
  if (kind === 'nonneg' && !(value >= 0)) problems.push(`${dotted}=${value} must be >= 0`);
  if (kind === 'count' && !(Number.isInteger(value) && value >= 1)) problems.push(`${dotted}=${value} must be an integer >= 1`);
  if (kind === 'int0' && !(Number.isInteger(value) && value >= 0)) problems.push(`${dotted}=${value} must be an integer >= 0`);
  if (min !== undefined && value < min) problems.push(`${dotted}=${value} is below minimum ${min}`);
  if (max !== undefined && value > max) problems.push(`${dotted}=${value} is above maximum ${max}`);
}

// Cross-field rules the schema cannot express. Returns problem strings.
function crossChecks(profile, problems) {
  const s = profile.exits || {};
  if (s.slPlusEnabled && Number.isFinite(s.slPlusLockPct) && Number.isFinite(s.slPlusArmPct) && !(s.slPlusLockPct < s.slPlusArmPct)) {
    problems.push('exits.slPlusLockPct must be < exits.slPlusArmPct (lock below arm)');
  }
  if (s.slPlusEnabled && Number.isFinite(s.slPlusFloorPct) && Number.isFinite(s.slPlusLockPct) && !(s.slPlusFloorPct < s.slPlusLockPct)) {
    problems.push('exits.slPlusFloorPct must be < exits.slPlusLockPct (BEP floor below lock)');
  }
  if (Number.isFinite(profile.screening?.minBinStep) && Number.isFinite(profile.screening?.maxBinStep) && profile.screening.minBinStep > profile.screening.maxBinStep) {
    problems.push('screening.minBinStep must be <= screening.maxBinStep');
  }
  if (profile.h17?.enabled) {
    const h = profile.h17;
    if (!(h.pump1hLow < h.pump1hHigh)) problems.push('h17.pump1hLow must be < h17.pump1hHigh');
    if (!(h.pump1hHigh <= 0)) problems.push('h17.pump1hHigh must be <= 0 (the H17 band is a dip band)');
  }
  if (profile.screening?.feeTvlGate20Enabled) {
    problems.push('screening.feeTvlGate20Enabled=true is REFUTED (deep-analysis §5.1/§5.8) — the 20% fee/TVL gate must not be enabled');
  }
  if (profile.screening?.ageGateEnabled) {
    problems.push('screening.ageGateEnabled=true is REFUTED (deep-analysis §5.1/§5.8) — age gates hurt in both batches; keep the 0.5h minimum only');
  }
  if (Number.isFinite(profile.halt?.legSol) && Number.isFinite(profile.sizing?.legSol) && profile.halt.legSol !== profile.sizing.legSol) {
    problems.push('halt.legSol must equal sizing.legSol (one leg size for halt arithmetic and sizing)');
  }
  if (Number.isFinite(profile.halt?.bookSol) && Number.isFinite(profile.sizing?.bookSol) && profile.halt.bookSol !== profile.sizing.bookSol) {
    problems.push('halt.bookSol must equal sizing.bookSol (one book size for halt arithmetic and sizing)');
  }
  if (Number.isFinite(profile.halt?.pollSec) && Number.isFinite(profile.management?.pollSec) && profile.halt.pollSec !== profile.management.pollSec) {
    problems.push('halt.pollSec must equal management.pollSec (one poll interval)');
  }
  if (Number.isFinite(profile.reshape?.reshapeMax) && Number.isFinite(profile.halt?.reshapeMax) && profile.reshape.reshapeMax !== profile.halt.reshapeMax) {
    problems.push('reshape.reshapeMax must equal halt.reshapeMax (one per-leg reshape cap)');
  }
}

function validateProfile(profile, name) {
  const problems = [];
  for (const [dotted, spec] of Object.entries(SCHEMA)) {
    const v = getPath(profile, dotted);
    if (v === undefined) { problems.push(`${dotted} is missing`); continue; }
    checkValue(dotted, spec, v, problems);
  }
  // Unknown keys are a fail, not a warning: a typo'd key would silently do nothing.
  // Documentation-only keys are allowlisted (they never reach the bot).
  const known = new Set(Object.keys(SCHEMA));
  const ignored = new Set(['description', 'entrySync.note']);
  const walk = (obj, prefix) => {
    for (const k of Object.keys(obj || {})) {
      const d = prefix ? `${prefix}.${k}` : k;
      if (ignored.has(d)) continue;
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) walk(obj[k], d);
      else if (!known.has(d)) problems.push(`${d} is not a known config key (typo?)`);
    }
  };
  walk(profile, '');
  crossChecks(profile, problems);
  if (problems.length) {
    const err = new Error(`warlock-config profile '${name}' is INVALID (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n- ${problems.join('\n- ')}`);
    err.code = 'WARLOCK_CONFIG_INVALID';
    err.problems = problems;
    throw err;
  }
  return profile;
}

function resolveProfile(doc, name) {
  const profiles = doc.profiles || {};
  if (!profiles[name]) {
    const err = new Error(`warlock-config: unknown profile '${name}' (available: ${Object.keys(profiles).join(', ') || 'none'})`);
    err.code = 'WARLOCK_CONFIG_UNKNOWN_PROFILE';
    throw err;
  }
  let profile = profiles[name];
  const seen = new Set([name]);
  while (profile.extends) {
    const parent = profile.extends;
    if (seen.has(parent)) throw new Error(`warlock-config: profile extends cycle at '${parent}'`);
    seen.add(parent);
    if (!profiles[parent]) throw new Error(`warlock-config: profile '${name}' extends unknown profile '${parent}'`);
    profile = deepMerge(profiles[parent], { ...profile, extends: undefined });
    delete profile.extends;
  }
  return profile;
}

function loadConfig({ configPath = DEFAULT_CONFIG_PATH, profile: profileName, overrides = {} } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    const err = new Error(`warlock-config: cannot read ${configPath}: ${e.message}`);
    err.code = 'WARLOCK_CONFIG_UNREADABLE';
    throw err;
  }
  const name = profileName || process.env.WARLOCK_PROFILE || doc.activeProfile || 'e-baseline';
  let profile = resolveProfile(doc, name);
  if (overrides && Object.keys(overrides).length) {
    profile = deepMerge(profile, overrides);
  }
  validateProfile(profile, name);
  // Derived, single-source values the bot used to compute inline.
  const exits = profile.exits;
  const derived = {
    tpFraction: exits.tpUsdPct / 100,
    emergencyDropPct: exits.emergencyDrop * 100,
    maxPump24hFraction: profile.screening.maxPump24h,
  };
  return { profileName: name, configPath, profile, derived };
}

module.exports = { loadConfig, validateProfile, resolveProfile, SCHEMA, DEFAULT_CONFIG_PATH, getPath, setPath };
