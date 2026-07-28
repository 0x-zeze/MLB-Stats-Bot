# Evaluation Method

**Status:** correctness metrics and same-period market baselines active; production-replay promotion remains gated
**Do not claim profitability** unless a report is labeled `production_replay` and leakage-safe.

## 1. Principles

1. Chronological evaluation only — no random train/test splits for time-dependent data.
2. ROI = `sum(profit_loss) / sum(units_staked)` (stake-weighted). Never profit / bet count when stakes vary.
3. Missing edge/CLV excluded from averages (not coerced to 0).
4. Empty samples → metrics are `null` / unavailable, not `0.0`.
5. CLV and P/L must use the same immutable value-bet side.
6. Walk-forward test windows are half-open `[start, end)` and disjoint.
7. Predictor failures must be visible (not silently empty folds).

## 2. Populations

| Label | Meaning | Usable for promotion? |
|-------|---------|------------------------|
| `unaudited` | Live SQLite dump without full provenance | No |
| `partial` | Some identity/cutoff missing | No |
| `sample_only` | Fixture CSV / Python sample model | No |
| `production_replay` | Immutable snapshot + JS core replay | Yes (with gates) |

## 3. Walk-forward

- Expanding train window up to day before test.
- Test interval half-open; no shared test days across folds.
- Minimum train size gate before scoring.
- Report per-fold and overall accuracy, stake-weighted ROI, Brier when available.

## 4. Calibration

- Fit chronological out-of-fold only.
- Bind runtime to artifact identity (hash, cutoff, method).
- **No automatic promotion** after settled bets — proposal/outbox only.
- Calibration is the final probability stage before market edge.

## 5. Required report fields

Sample size, period, qualified bets, accuracy, log loss, Brier, ECE/MCE (when available), ROI stake-weighted, average odds/edge (coverage), CLV (coverage), drawdown, profit factor, streaks, segment breakdowns, uncertainty, git/model/calibration versions, exclusions.

## 6. Baselines (blocked until replay)

Always home, market favorite, no-vig market, regularized logistic, current rule model, improved model, market residual — same chronological snapshots only.

## 7. Related docs

- `docs/TECHNICAL_AUDIT.md`
- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/MODEL_CARD.md`
- `reports/latest_evaluation.md` (currently `unaudited`)
