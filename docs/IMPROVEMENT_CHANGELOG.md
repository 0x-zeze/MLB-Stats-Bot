# Improvement Changelog

Honest log of correctness/evaluation work. No fabricated performance gains.

## 2026-07-28 — Pure core + real replay + temporal wall + evaluator baselines

### Commits

| Commit | Summary |
|--------|---------|
| `892262d` | refactor: extract deterministic pure moneyline prediction core |
| `1f596fa` | feat: implement real snapshot-based prediction replay |
| `3c40302` | feat: enforce temporal provenance and historical data wall |
| `426db0c` | fix: correct ROI definition and add market baselines + report metadata |

### Correctness

- **Pure canonical core.** `src/core/prediction_core.js` (`predictGameMoneylineCore`)
  now owns the moneyline probability pipeline: no network, filesystem, database,
  clock, or env access; evolution controls / calibration function / park factors /
  `now` are injected. `predictGame` (src/mlb.js) is a thin behavior-preserving
  wrapper. Live and replay share the same core.
- **Real recompute replay.** Snapshots freeze raw `coreInputs` + the exact
  `calibrationArtifact`. Replay re-runs the pure core and compares full-precision
  raw stages (`PROBABILITY_TOLERANCE=1e-9`). Legacy snapshots fall back to
  `projection` mode, explicitly not promotion-eligible. Fixed `stableStringify`
  int/float hash drift. Mutation tests prove starter/lineup/calibration changes
  alter output; irrelevant metadata does not.
- **Temporal data wall.** `src/data/temporal_validator.js` adds
  `TemporalLeakageError` + `validateTemporalSnapshot`; future features are
  rejected, boxscore lineups without a pregame availability timestamp are
  `historical_unverified` and never promotion-eligible.
- **Evaluator.** ROI is strictly stake-weighted (`None` when no stake);
  `units_per_bet` reported separately. Same-period no-vig market baselines added
  (market favorite accuracy, market Brier/log loss, model-minus-market
  improvement). `--json` writes `reports/latest_metrics.json` with git SHA,
  dataset hash, row count, generation timestamp.

### Verification

- `npm test`: pass — JS 160 pass / 0 fail / 5 skipped; Python 555 pass.
- Recompute replay parity: `parity ok: true`, `promotionEligible: true`, twice-identical.

### Honest current evaluation (unaudited, NOT promotion-eligible)

47 comparable moneyline rows. The model **trails** the no-vig market:

| Metric | Market | Model | Improvement |
|--------|--------|-------|-------------|
| Accuracy (favorite) | 53.2% | 44.7% | — |
| Brier | 0.2444 | 0.2657 | −0.0213 |
| Log loss | 0.6815 | 0.7250 | −0.0435 |

### Explicit non-claims

- No prediction-skill, calibration, edge, or ROI improvement is claimed.
- The `unaudited` ledger population is not promotion-eligible.
- Historical rows still lack full pregame feature provenance.

## 2026-07-27 — Phase 0–2 + evaluation partial

### Commits

| Commit | Summary |
|--------|---------|
| `292d46d` | audit: technical inventory + unaudited baseline |
| `f43bc68` | ledger: immutable decisions, atomic settlement, stake-weighted ROI |
| `acf093f` | temporal: invalid-future freshness + as-of pitcher starts |
| `857ac5f` | evaluation: half-open walk-forward, proposal-only calibration, docs |
| `869f6af` | governance: LLM explanation-only + dashboard unavailable |
| `a55a972` | docs: prediction architecture |
| `da50a8f` | market: same-book fair de-vig + season-to-date stats |
| `c49614c` | docs: remaining-risk mitigations |
| `325274e` | prediction: snapshot serialize + replay projection |
| `d269c6d` | prediction: live snapshot capture + calibration artifact binding + quarantine report |
| `d436766` | evaluation: dashboard financial provenance + reproducible artifacts |

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

### Verification

- `npm test`: pass — JS 144 pass / 0 fail / 5 skipped; Python 552 pass.
- `npm run dashboard:build`: pass (Vite production build).
- Negative-overround fixture now correctly uses raw executable implied probability rather than synthetic de-vig.

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
