# Prediction Architecture

**Status:** Transition document (Phases 0–2 partial + governance)

## Current production path (Telegram)

```text
getMlbPredictions (src/mlb.js)
  -> attachOdds / line snapshots
  -> attachMarketContext (pure model, market blend, value engine)
  -> applyMoneylineValueMarket
  -> attachAgentAnalyses (explanation-only; cannot change pick/prob/edge/status)
  -> storage.savePredictions (compact model pick + valuePick + betDecision)
  -> recordBet for VALUE only
```

Post-game:

```text
evaluatePostGames
  -> CLV from ledger/value side
  -> processPostGameOutcome (outcome -> settle -> mark processed)
  -> calibration proposal only (no auto-promote)
```

## Target path

```text
source observation
  -> point-in-time feature snapshot
  -> pure deterministic JS core (network/wall-clock free)
  -> immutable prediction_run + prediction_decision
  -> optional execution
  -> outcome + idempotent settlement
  -> outbox / evaluation
```

## Probability stages (intended)

```text
raw model
  -> deterministic baseball/context adjustments
  -> final calibration (artifact-bound)
  -> market comparison / edge
  -> bet qualification / stake
```

LLM may only add supporting/counter factors, data-quality warnings, market disagreement, and explanation text.

## Live vs backtest

| Path | Role |
|------|------|
| `src/mlb.js` + `src/index.js` | Production Telegram |
| Python `backtest.py` / sample pipeline | Fixture/regression only — **not** production replay |
| Future `prediction_core` + snapshots | Canonical live/replay parity |

Until snapshot replay exists, do not treat Python backtest ROI as live performance.

## Related

- `docs/TECHNICAL_AUDIT.md`
- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/BETTING_LEDGER.md`
- `docs/EVALUATION_METHOD.md`
