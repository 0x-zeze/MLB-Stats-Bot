# Calibration Governance

**Status:** proposal-only promotion (no auto-promote) as of Phase 2; governance thresholds documented here.

Calibration is the **final** probability transform before market comparison and
edge calculation. No probability is modified after calibration.

## 1. Pipeline position

```text
raw model score
  -> baseball / context adjustments
  -> data-quality shrinkage
  -> optional market-prior integration
  -> FINAL CALIBRATION        <- this stage
  -> market comparison / edge
  -> bet qualification / stake
```

## 2. Training discipline

- Fit calibrators on **chronological out-of-fold** predictions only.
- Never train and evaluate a calibrator on the same predictions.
- Calibration operates on the final pre-calibration probability (after all
  baseball/context/quality/market-prior adjustments).

## 3. Methods compared

- no calibration (identity);
- Platt / logistic calibration;
- temperature scaling;
- beta calibration (when practical);
- isotonic regression only with sufficient sample size.

Sparse isotonic maps are not silently promoted: low-sample moneyline metadata
falls back to shrink-toward-50 (`shrink_toward_50` / `map_low_sample_shrink`).

## 4. Artifact identity

Every calibration artifact carries:

```text
artifact id (hash)
market type
method
map points / parameters
training sample count
model version / feature version
calibration version (cal-<market>-<hash>)
status
```

Runtime binds the artifact hash per prediction (`getCalibrationArtifact`,
`freezeCalibrationArtifact`) so replay uses the exact historical map.

## 5. Runtime modes (`src/calibration.js`)

| Mode | Behavior |
|------|----------|
| `map` | interpolate the trusted isotonic map |
| `map_low_sample_shrink` | interpolate, then shrink residual toward 50 |
| `shrink_toward_50` | no trusted map; conservative shrinkage |
| `identity` | no calibration; explicit, never silent success |

## 6. Minimum promotion requirements (moneyline)

A calibrator is promoted only after explicit gates (not hardcoded auto-triggers):

1. minimum out-of-sample predictions (starting policy: 500);
2. minimum sample count per important confidence region;
3. Brier score no worse than the uncalibrated baseline;
4. log loss no worse than baseline;
5. ECE improvement;
6. no severe monthly degradation;
7. no severe favorite/underdog degradation.

Current state: `maybeQueueCalibrationRetrain` only writes a **proposal/outbox**
entry — it never promotes directly.

## 7. Calibration report contents

bucket range, sample count, mean prediction, actual frequency, calibration gap,
confidence interval. Also monthly calibration, calibration by odds range, by
favorite/underdog, by data-quality tier, and drift monitoring.

## 8. Insufficient data

When calibration data is insufficient:

```text
calibrationStatus = insufficient_sample
-> conservative fallback (shrink toward 50 / identity), never a sparse isotonic map
```

## 9. Per-market separation

Moneyline (and totals if active) each have their own calibration artifact. YRFI/NRFI
calibration was retired with the market. One
map is never shared across markets.

## 10. Related

- `docs/EVALUATION_METHOD.md`
- `docs/MODEL_GOVERNANCE.md`
- `docs/DATA_PROVENANCE_SCHEMA.md`
