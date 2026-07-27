# Latest Evaluation (Unaudited Baseline)

**Status:** `unaudited`  
**Generated:** 2026-07-27  
**Git:** `31f0f8c` on `main`  
**Source:** `data/state.sqlite` descriptive inventory only  

This report is a **Phase 0 baseline**. It does **not** prove model edge, calibration quality, or profitability. A lower but honest later OOS result is preferable to these numbers.

## Population

| Field | Value |
|-------|-------|
| Picks rows | 1145 |
| Date range | 2026-04-28 → 2026-07-27 |
| Moneyline settled bets | 47 |
| Totals settled bets | 27 |
| Totals open (stranded) | 7 |
| Processed pick + open ledger | 7 |
| pick.name ≠ valuePick.teamName (sample count) | 7 |
| ledger.side ≠ valuePick.side | ≥1 |

## Moneyline (descriptive ledger dump)

| Metric | Value | Notes |
|--------|-------|-------|
| N | 47 | settled only |
| Record | 21–26 | win rate secondary |
| Units staked | 169.0 | sum of units_staked |
| Units P/L | −32.95 | sum of units_pl |
| **ROI (stake-weighted)** | **−19.5%** | `sum(pl)/sum(stake)` — correct definition |
| ROI (legacy bet-count) | −0.70 u/bet | **incorrect** denominator used in current `evaluate.py` |
| CLV coverage | 47/47 | presence only; side identity questionable |
| Average CLV | −0.60 | may mix wrong side vs P/L |

## Totals (descriptive)

| Metric | Value |
|--------|-------|
| Settled N | 27 |
| Record | 11–16 |
| Units P/L | ≈ −22.66 |
| Open | 7 (empty date_ymd, 2026-06-29 era) |

## Scoring metrics

| Metric | Value |
|--------|-------|
| Brier | **unavailable** |
| Log loss | **unavailable** |
| ECE / MCE | **unavailable** |

Reason: no immutable calibrated probability series bound to leakage-safe outcomes yet.

## Baselines

All chronological baselines (home, market favorite, no-vig, logistic, residual) are **blocked** until Phases 1–4.

## Test suite baseline (pre-remediation)

- `npm run check`: pass  
- `npm run test:js`: 112 pass / 0 fail / 5 skipped  
- `npm run test:py`: 542 pass / 0 fail  

## Critical defects affecting these numbers

1. Mutable `picks` overwrite prediction identity.  
2. Non-atomic `recordOutcome` before `settleBet`.  
3. CLV uses `prediction.pick`; P/L uses `bet_ledger.side`.  
4. Live JS path ≠ Python backtest path.  
5. Historical feature fetch can look ahead of as_of.  
6. Evaluator ROI denominator wrong; missing values become zero.

## Labeling

```text
status: unaudited
population: live_sqlite_descriptive_only
usable_for_promotion: false
usable_for_public_performance_claims: false
```

See `docs/TECHNICAL_AUDIT.md` for full risk register and remediation order.
