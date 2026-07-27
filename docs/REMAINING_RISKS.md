# Remaining Risks

Updated 2026-07-27 after Phases 0–2 and partial evaluation fixes.

## Still P0 for any performance claim

| Risk | Status |
|------|--------|
| Live JS path ≠ Python backtest | Open — no production_replay yet |
| Full-season team/pitcher stats without date reconstruction | **Mitigated in live path** (byDateRange as_of); still unsafe if called without asOf |
| Boxscore lineup as historical feature | Open without pregame snapshot proof |
| Mutable `picks` UPSERT still primary identity | Partial — decisions table added but live still UPSERTs picks |
| Historical rows lack prediction_timestamp / quote provenance | Cannot fully backfill; new live predictions now capture snapshot/as_of/hash |

## P1

| Risk | Status |
|------|--------|
| 7 open totals with empty date_ymd | Open (stranded) |
| Cross-book de-vig as fair market | **Mitigated** — fair de-vig only same-book; executable uses side book |
| Sparse calibration maps | Open; new live snapshots bind explicit calibration artifact hash/version |
| Feature snapshots without first-pitch hard wall | Partial write-once only |
| Evolution can still touch production-adjacent files | Open (promotion not fully sandboxed) |

## P2

| Risk | Status |
|------|--------|
| Dashboard mock/live fallback | Live failures now explicit unavailable; explicit mock/sample remains available |
| Manual `npm run check` file list | Open |
| MODEL_CARD performance TODOs | Open |

## Mitigations already landed

- Atomic-ish postgame process + stranded recovery  
- CLV side from ledger/value  
- Stake-weighted ROI + null empty metrics  
- invalid_future freshness  
- as_of filter on pitcher recent starts  
- Calibration proposal-only (no auto promote)  
- Walk-forward half-open folds  

## Honest backfill limit

Existing ledger/picks **cannot** recover original pregame feature state, true book/quote IDs, probability stage, or production snapshots. Label such metrics `unaudited`/`partial` and exclude from promotion.
