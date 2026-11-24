# System-readiness Phase 1 — review branch (v1)

Snapshot of the Warlock live system-readiness **Phase 1** code (2026-11-24) for
independent bug review by sole's Claude. Branched from `main`
@ `22a59b432ad8aa6c5e5913f38d91e1fc76093411`. `main` is untouched; nothing here
is merged, and this branch is a review snapshot — not a live build.

## Items in this branch

- **Item 1 — halt enforcement (DONE, pending Warlock Head decisions N7/N8/N9).**
  New modules at their natural paths: `sol-lp-bot/live-halt.js`,
  `sol-lp-bot/halt-params.json`. The wiring into `bot.js` and the other
  existing files is represented by the patch files only, under
  `live-readiness/item1-halt/patches/` — the Item 1 ↔ Item 4a `bot.js`
  hand-merge (N3) is **not** done; that is Phase 2's job.
- **Item 4a — alert call-site map + heartbeat (DONE, build scope).** New module
  `sol-lp-bot/feed-health.js`; all other changes as diffs under
  `live-readiness/item4a-alerts/diffs/`. Clone-proven criteria (alert latency
  ≤ 5 min, heartbeat observed, dropped-alert demo) are **not** proven here —
  they belong to Item 2.
- **Item 5 — patch-guard (DONE).** Script `sol-lp-bot/verify-patch.sh`
  (landed without the executable bit — `chmod +x` to run it); procedure and
  evidence under `live-readiness/item5-patchguard/`.
- **Item 6 — v2 settings-pin verification (DONE).** v2-only; it lives on the
  `review/system-readiness-phase1` branch of `baskarajati/sole-warlock-v2`,
  not here.

## What is NOT here

- The merged `bot.js` (N3) and any Phase 2 rehearsal-clone work.
- Any key, secret, token, `.env`, or runtime/paper state. Nothing in this
  branch can start a live instance.
- Any change to a live-mode flag or a running paper window.

## Pending decisions (may change this code later)

- **N7** — K8-mode restatement in the decision table.
- **N8** — K5 loss bar, confirm or restate.
- **N9** — v2 `DEFAULTS` null→5 paper scope (does not touch the running v2
  paper window).
- **N4** — `notifyHalt` caller: rewire `live-halt` to `notifyHalt` vs retire it.

Evidence for each item is its `REVIEW.md` under `live-readiness/<item>/`.
