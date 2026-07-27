# Improvement Changelog

Honest log of correctness/evaluation work. No fabricated performance gains.

## 2026-07-27 — Phase 0–2 + evaluation partial

### Commits

| Commit | Summary |
|--------|---------|
| `292d46d` | audit: technical inventory + unaudited baseline |
| `f43bc68` | ledger: immutable decisions, atomic settlement, stake-weighted ROI |
| `acf093f` | temporal: invalid-future freshness + as-of pitcher starts |
| `857ac5f` | evaluation: half-open walk-forward, proposal-only calibration, docs |
| `869f6af` | governance: LLM explanation-only + dashboard unavailable |

### Correctness

- Documented mutable pick identity, non-atomic settlement, pick≠value divergence, CLV side mismatch, lookahead paths, live≠backtest.
- Migration runner + tables: `prediction_runs`, `prediction_decisions`, `market_observations`, `game_outcomes`, `settlements`, `reconciliation_issues`, `outbox`.
- `bet_ledger` stores `selected_team_id`, book, quote, decision_hash; settle uses value side not display pick.
- `processPostGameOutcome` settles before processed mark; recovers stranded open+processed.
- CLV side from ledger/valuePick.
- Evaluator: ledger team as lean, correct away/home probs, stake-weighted ROI, null empty metrics.
- Temporal contract: `invalid_future`; odds age not 0 for future stamps; pitcher recent starts filtered by as_of date; in-play tier reject.
- Calibration auto-retrain → proposal/outbox only (no promote).
- Walk-forward: half-open disjoint folds, stake-weighted ROI, visible predictor errors.
- LLM probability/bet overrides rejected; compactPrediction keeps model pick.
- Live dashboard failures return `status=unavailable` (no mock BET synthesis).

### Explicit non-claims

- Ledger ROI dump remains **unaudited**.
- No model accuracy improvement claimed.
- Full-season team/pitcher aggregates and boxscore lineups still leakage risks for historical use.
- Python backtest still not JS production replay.

## Next (strict gates)

1. Snapshot/replay pure JS core + parity tests  
2. Chronological OOF calibration artifact binding  
3. Full historical feature cutoff on remaining fetchers  
4. Dashboard no synthetic live fallback  
5. LLM adversarial boundary tests  
