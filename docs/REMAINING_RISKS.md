# Remaining Risks

Updated 2026-07-28 after pure-core extraction, real recompute replay, temporal
data wall, and evaluator market baselines.

## Still P0 for any performance claim

| Risk | Status |
|------|--------|
| Live JS path ≠ Python backtest | **Mitigated for moneyline** — live and replay now share `src/core/prediction_core.js`; Python backtest remains fixture-only |
| Full-season team/pitcher stats without date reconstruction | **Mitigated in live path** (byDateRange as_of); still unsafe if called without asOf |
| Boxscore lineup as historical feature | **Mitigated** — validator marks it `historical_unverified`, never promotion-eligible |
| Mutable `picks` UPSERT still primary identity | Partial — decisions table added but live still UPSERTs picks |
| Historical rows lack prediction_timestamp / quote provenance | Cannot fully backfill; new live snapshots now freeze `coreInputs` + calibration artifact for recompute replay |
| **Model trails no-vig market** | **New finding (unaudited):** Brier improvement −0.021, accuracy 44.7% vs market 53.2% — no edge claim |

## P1

| Risk | Status |
|------|--------|
| 7 open totals with empty date_ymd | Open (stranded) |
| Cross-book de-vig as fair market | **Mitigated** — fair de-vig only same-book; executable uses side book |
| Sparse calibration maps | Open; replay now binds the exact frozen calibration artifact |
| Feature snapshots without first-pitch hard wall | Partial write-once only; temporal validator enforces as_of <= first_pitch |
| Evolution can still touch production-adjacent files | Open (promotion not fully sandboxed) |
| Live snapshots do not yet persist `coreInputs` | **Mitigated for new predictions** — `getMlbPredictions` freezes coreInputs and `storage.js` persists them; older rows remain projection-only |
| Totals not on pure core | **Open** — only moneyline extracted; totals still a separate path |
| YRFI/NRFI market | **Closed** — removed; no per-game edge, was advisory-only |
| `js.value_profile` empirical gate | **Disabled** (`enabled:false`) — claimed 127@64.6% not reproducible; holdout n=12 |
| Market-anchored residual weight | **Default 0** — raise only after `npm run model:validate` walk-forward supports it |
| Model-vs-market disagreement gate (model-away vs market-home) | **Live** (`js.disagreement_away`) — bypasses edge/conviction floors for this validated asymmetric edge (train 81% + test 97% WR, n=183). Re-check periodically with `npm run model:validate`. |
| Model-vs-market disagreement gate (model-home vs market-away) | **Not promoted** — n small, train WR 44%. No bypass applied. |

## P2

| Risk | Status |
|------|--------|
| Dashboard mock/live fallback | Live failures now explicit unavailable; explicit mock/sample remains available |
| Manual `npm run check` file list | Open |
| MODEL_CARD performance TODOs | Open |

## Mitigations already landed

- Pure canonical moneyline core (no network/fs/db/clock/env) shared by live + replay
- Real recompute replay with explicit tolerances + mutation tests
- Temporal data wall (future features rejected; unverified lineups quarantined)
- Stake-weighted ROI + separate units_per_bet + same-period no-vig market baselines
- Atomic-ish postgame process + stranded recovery
- CLV side from ledger/value
- invalid_future freshness
- as_of filter on pitcher recent starts
- Calibration proposal-only (no auto promote)
- Walk-forward half-open folds

## Honest backfill limit

Existing ledger/picks **cannot** recover original pregame feature state, true book/quote IDs, probability stage, or production snapshots. Label such metrics `unaudited`/`partial` and exclude from promotion.
