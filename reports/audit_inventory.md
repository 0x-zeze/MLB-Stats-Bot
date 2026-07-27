# Audit Inventory

Phase 0 read-only inventory (2026-07-27). Source: live `data/state.sqlite` queries + code inspection.

```
=== MLB Stats Bot Technical Audit (read-only) ===
git: 31f0f8c branch=main node=v24.18.0

-- Summary --
  picks: 1145
  ledgerOpen: 7
  ledgerSettledMoneyline: 47
  stakeWeightedRoiMoneyline: -0.19497
  sideMismatches: 1
  pickVsValueDivergences: 7
  processedButOpen: 7
  p0Risks: 6

-- Tables --
  picks: 1145
  bet_ledger: 81
  line_snapshots: 1406
  feature_snapshots: 958
  yrfi_results: 1145

-- Ledger --
  moneyline settled: 47 stake=169.0 pl=-32.95 stakeWeightedRoi=-0.19497
  totals settled: 27 pl≈-22.66
  open: 7 (all totals, empty date_ymd)

-- Calibration --
  runtimeMapsPresent: true
  mapPointCounts: moneyline=4, yrfi=3

-- Baseline tests --
  check: pass
  test:js 112 pass / 0 fail / 5 skipped
  test:py 542 pass / 0 fail

status: unaudited inventory only — not a performance claim
```

See `docs/TECHNICAL_AUDIT.md` and `reports/latest_evaluation.md`.
