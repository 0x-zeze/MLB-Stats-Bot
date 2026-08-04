# Latest Evaluation

**Status:** `partial`  
**Generated:** 2026-08-04T08:14:13.520644+00:00  
**Git:** `cc14e16cda9ea49d464b68b3f1bb4af79998d67d`

This artifact is generated reproducibly from SQLite. It is not a profitability claim.

## Population

- **label:** mixed_legacy_live_ledger
- **ledger_rows:** 82
- **picks_rows:** 2118
- **prediction_runs:** 94
- **decision_snapshots:** 94
- **historically_complete_rows:** 0
- **usable_for_promotion:** False

## Markets

### moneyline

- Settled: 48
- Record: 22-26
- Win rate: 45.83%
- Units staked: 171.4000
- Units P/L: -30.3820
- ROI (stake-weighted): -17.73%
- Brier: 0.2647
- Log loss: 0.7230
- ECE / MCE: 0.1190 / 0.1255
- CLV: -0.6354 (coverage 48/48)

### totals

- Settled: 27
- Record: 11-16
- Win rate: 40.74%
- Units staked: 138.3000
- Units P/L: -22.6600
- ROI (stake-weighted): -16.38%
- Brier: 0.2828
- Log loss: 0.7615
- ECE / MCE: 0.2160 / 0.7540
- CLV: unavailable (coverage 0/27)

## Provenance gaps

- missing_date_ymd: 73
- missing_selected_team_id: 81
- missing_bookmaker: 81
- missing_quote_id: 82
- missing_calibration_version: 81
- open_unsettled: 7

## Limitations

- Legacy rows may lack prediction timestamp, book/quote identity, or calibration version.
- Snapshot replay currently projects frozen decisions; full pure-core replay remains incomplete.
- Metrics are descriptive ledger evaluation, not a new model-performance claim.
