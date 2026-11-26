'use strict';
// h17-reject.js — H17 pump-cliff reject (deep-analysis §5.7 test #1).
//
// Rule, on top of the E baseline: reject entries with pump24h >= +40%
// AND pump1h in [-20%, -5%]. Pooled B1+B2: 25 legs, -$793.58, 8 stops.
// Two-batch directional, NOT confirmed — this is a forward-test rule,
// not an adoption. It lives in config (h17.*) and is OFF in the
// e-baseline profile, ON in the h17 profile.
//
// Pure: fractions in (0.40 = +40%), null (unknown) in, verdict out.
// A missing pump figure means the rule cannot be evaluated — the entry
// is KEPT and the reason recorded (fail-open with a log line, not a
// silent reject: H17 must never starve the screen on missing data).
function isH17Reject({ pump1h, pump24h } = {}, rule = {}) {
  const min24 = Number(rule.pump24hMin ?? 0.4);
  const low = Number(rule.pump1hLow ?? -0.2);
  const high = Number(rule.pump1hHigh ?? -0.05);
  if (!rule.enabled) return { reject: false, reason: null };
  if (!Number.isFinite(pump1h) || !Number.isFinite(pump24h)) {
    return { reject: false, reason: 'h17 unevaluated (missing pump1h/pump24h)' };
  }
  if (pump24h >= min24 && pump1h >= low && pump1h <= high) {
    return {
      reject: true,
      reason: `h17 pump-cliff reject: pump24h=${(pump24h * 100).toFixed(1)}% >= ${(min24 * 100).toFixed(0)}% and pump1h=${(pump1h * 100).toFixed(1)}% in [${(low * 100).toFixed(0)}%, ${(high * 100).toFixed(0)}%]`,
    };
  }
  return { reject: false, reason: null };
}

module.exports = { isH17Reject };
