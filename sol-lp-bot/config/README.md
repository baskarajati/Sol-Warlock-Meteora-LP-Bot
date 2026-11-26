# Warlock config — system-configurable v1

All strategy numbers live in `warlock-config.json`. The bot loads it once
at start (`config-loader.js`) and refuses to start on any invalid value
— there is no silent fallback to a number nobody chose.

## Profiles

| Profile | What it is |
|---|---|
| `e-baseline` (default) | Batch 1 arm E, the only book clearing the frozen adoption bar: 0.6% FT floor, no age gates, no 20% gate, reshape-freeze-5, TP 13%, emergency TP 10%, SL+ 3%/0.1%, emergency stop −20%, $500/leg, max 2 concurrent on the 5 SOL pilot scale at 1.25 SOL/leg. |
| `h17` | E baseline + the H17 pump-cliff reject (reject pump24h ≥ +40% AND pump1h in [−20%, −5%]). A forward-test rule — two-batch directional, NOT confirmed. |
| `paper-safety` | E baseline at Batch 1/2 paper-book scale (max 10 positions/book, $1,000 book) with the frozen paper-book safety rule as the enforced halt. |

Select a profile with `WARLOCK_PROFILE=h17` (env), else the file's
`activeProfile` (`e-baseline`). Changing a profile is a restart, never a
rebuild — but it IS a config change: any forward book or config change
needs sole's go-ahead.

## What is NOT in any profile (refuted — do not re-add)

- The 20% fee/TVL gate (`screening.feeTvlGate20Enabled` — the loader
  REFUSES `true`; deep-analysis §5.1/§5.8).
- Age gates (`screening.ageGateEnabled` — the loader REFUSES `true`).
- Flat TP 7% as the adopted TP (adopted TP is 13%; the B7 arm exists only
  as a frozen Batch 1 variant definition in `bot.js`, not as a profile).
- The FP centred buffer as adopted; ft ≥ 1.5% as a confirmed raise.

## Precedence (highest first)

1. `paper/settings.json` + env, via `paper-settings.currentValues()`
   (the mini-app Settings tab) — applied at runtime by
   `applyPaperSettings()`.
2. This file (start defaults) — `bot.js` CFG, `paper-settings` DEFAULTS,
   and `paper-strategy` DEFAULTS all derive from the active profile.

## Halt — two executors, one table

- **Live path (K1–K9):** `live-halt.js`, thresholds from
  `halt-params.json` (D-0c Rev 2 / Pilot Spec Rev 1, 5 SOL / 1.25 SOL).
  `config.halt` mirrors that table; `test-configurable-v1.js` fails if
  the two disagree.
- **Paper books (frozen safety rule):** `paper-halt.js`, thresholds from
  `config.paperHalt` — P1: 3 consecutive emergency stops; P2: drawdown
  > $150; P3: 5 consecutive losing closes totalling < −$100. A trip
  latches the book (`HALT-<book>` + `halt-<book>.json` in the paper dir),
  refuses new opens, and never auto-clears. Open positions unwind through
  their normal exits. Manual reset only: delete BOTH files after review.

## Stop enforcement

The −20% emergency stop is judged on the worst net PnL% seen since entry
(`pos.worstPnlPct`, tracked by `paper-exit-policy.decide()`), not only on
the poll-end price — see `stop-enforcement.js` and deep-analysis §5.3
(one Batch 1 leg went −0.89% → −27.86% inside a single 39-second poll
interval). A dip below −20% that recovers before the next poll still
stops.

## Stamps (§5.6)

`shadow-stamps.js` stamps items 1–12 (fields that have no source are
stamped `null` with a `*Status` field saying so — never fabricated).
Item 13 (the 19–22 Nov reject universe) is unrecoverable. Entry
synchronisation (#12) is NOT implemented: `entrySync.enabled` is `false`
and `syncGroup` stamps `null` until it is.

## Tests

`node test-configurable-v1.js` (30 tests) — profiles, validation,
H17, paper halt (all three prongs + latch + restart), stop enforcement
(incl. the gap-leg replay), stamps, history CSV, and bot.js wiring.
Full suite: `npm test` (94 tests).
