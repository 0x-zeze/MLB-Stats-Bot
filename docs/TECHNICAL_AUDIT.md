# Technical Audit — MLB Stats Bot

**Status:** historical Phase 0 inventory with 2026-07-28 remediation addendum
**Revision audited:** `31f0f8c` on `main` (original inventory)
**Collected:** 2026-07-27; remediation verified 2026-07-28
**Runtime baseline:** Node v24.18.0 (shell), Python 3.12.3
**Database:** `data/state.sqlite` (read-only inspection)

This document records **observed facts** from code and live SQLite state. It is
not a performance claim. Historical ROI/CLV must not be treated as valid
evidence until leakage, immutable settlement, and live/replay parity are fixed.

---

## 1. Architecture (current)

```text
MLB StatsAPI / Odds API / weather
  -> src/mlb.js feature fetch + rule-based prediction
  -> src/index.js market blend + value engine + optional LLM analyst
  -> src/storage.js mutable picks + bet_ledger
  -> Telegram / dashboard surfaces
  -> post-game: recordOutcome -> mark processed -> settleBet (non-atomic)
  -> optional calibration retrain / evolution cycle
```

Parallel (non-production) paths:

- Python `src/prediction_pipeline.py`, `src/model.py`, `src/backtest.py` — fixture/sample backtests, not live JS replay.
- FastAPI `src/dashboard_service.py` — can diverge from Telegram path and mask failures.

### Live call chain (Telegram)

1. `getMlbPredictions(dateYmd, modelMemory)` in `src/mlb.js`
2. `attachOddsContext` / line snapshots
3. `attachMarketContext` — pure model probs, market blend, `applyMoneylineValueMarket`
4. `attachAgentAnalyses` — LLM explanation layer (can influence **persisted** pick via `compactPrediction`)
5. `storage.savePredictions` — UPSERT on `picks.game_pk`
6. `/picks` path may call `storage.recordBet` for `VALUE` only

### Post-game call chain

1. `evaluatePostGames` loads finals
2. CLV computed from **`prediction.pick`** side (not ledger side)
3. `storage.recordOutcome` updates memory and **marks `post_game_processed=1`**
4. Separate try/catch `storage.settleBet` using **ledger side**
5. On settle success, may queue calibration retrain / evolution

---

## 2. Baseline validation suite (pre-change)

| Suite | Result |
|-------|--------|
| `npm run check` | pass (syntax) |
| `npm run test:js` | **112 pass, 0 fail, 5 skipped** |
| `npm run test:py` | **542 pass, 0 fail** |

No production code was modified for this baseline.

---

## 3. SQLite inventory (observed)

| Table | Rows (approx) |
|-------|----------------|
| picks | 1145 |
| bet_ledger | 81 |
| line_snapshots | 1406 |
| feature_snapshots | 958 |
| yrfi_results | 1145 (historical only; no longer written/read after YRFI removal) |
| line_alerts | 15 |
| chat_history | 20 |
| chat_settings | 1 |
| app_state | 6 |
| memory_summary | 1 |

**Picks date range:** 2026-04-28 → 2026-07-27  
**post_game_processed:** 1126 processed / 19 unprocessed

### Ledger

| Market | Status | Count |
|--------|--------|-------|
| moneyline | settled | 47 |
| totals | settled | 27 |
| totals | open | 7 |

Moneyline settled (descriptive only, **unaudited**):

- total_staked ≈ 169.0 units  
- total_pl ≈ −32.95  
- **stake-weighted ROI** ≈ −19.5% (`sum(pl)/sum(stake)`)  
- legacy bet-count ROI would be ≈ −0.70 units/bet (incorrect denominator in `evaluate.py`)  
- wins 21 / losses 26  
- CLV present on all 47 settled moneyline rows; avg_clv ≈ −0.60  

Totals settled (descriptive only):

- wins 11 / losses 16  
- pl ≈ −22.66  

**Open ledger rows (all totals, empty `date_ymd`):** 7 rows from 2026-06-29 era (`decision_id` like `-totals-*`). These are stranded relative to date-scoped queries.

**Fingerprint of non-atomic settlement:** 7 rows with `status='open'` while joined pick has `post_game_processed=1`.

### Identity divergence (facts)

- At least **1** moneyline row where `ledger.side != payload.valuePick.side` (game_pk `824335`: ledger away/Miami vs payload value home/Colorado; pick still Miami).
- At least **7** moneyline rows where `payload.pick.name != payload.valuePick.teamName` while ledger team matches value team — display/model pick and value bet side are not the same identity.

Example (CLV vs P/L identity risk):

| game_pk | ledger | pick_name | value_team | result | clv |
|---------|--------|-----------|------------|--------|-----|
| 824588 | home / White Sox | Dodgers | White Sox | win | 1.0 |
| 824652 | home / Cubs | Tigers | Cubs | win | −1.9 |

CLV in `evaluatePostGames` uses `prediction.pick`; P/L uses `bet_ledger.side`.

---

## 4. Schema defects (observed)

### `picks`

- `game_pk TEXT PRIMARY KEY` + `ON CONFLICT DO UPDATE` → **mutable prediction identity**.
- No `prediction_run_id`, model/feature/calibration/policy versions, or snapshot hash.
- `ON DELETE CASCADE` from picks can delete financial children (`bet_ledger`; historical `yrfi_results` rows if present).

### `bet_ledger`

- `UNIQUE(game_pk, market)` too narrow for revisions / multi-book / multi-execution.
- Stores team **name** + side, not immutable team ID / quote ID / bookmaker / quote timestamp.
- No decision payload hash, no bankroll basis, no version columns.
- No CHECK constraints for status/result/odds/probability/stake consistency.

### `line_snapshots`

- Mutable latest-value store keyed by `(game_pk, market)`, not append-only market observations.
- Opening freeze via `INSERT OR IGNORE` for opening_* markets is partial progress only.

### `feature_snapshots`

- Write-once optional, but **no first-pitch / as_of enforcement** at storage layer.

---

## 5. Code path defects (observed)

### 5.1 Persistence / settlement (`src/storage.js`, `src/index.js`)

| Issue | Evidence |
|-------|----------|
| Mutable compact pick prefers agent | `compactPrediction` uses `agentAnalysis.pickTeamId` over pure/value side |
| recordBet only VALUE + positive Kelly | Non-VALUE recommendations never enter ledger |
| settleBet re-derives team from prediction home/away by side | Side is ledger; team id still from mutable prediction object |
| Non-atomic postgame | `recordOutcome` → `markPostGameProcessedRow` then separate `settleBet` |
| CLV wrong identity | `evaluatePostGames` uses `prediction.pick` for opening/closing side |
| settleBet does not verify `changes === 1` | Concurrent settle can appear successful |
| Empty `date_ymd` on some ledger rows | Totals open rows show blank date; decision_id prefix `-totals-` |

### 5.2 Temporal leakage (`src/mlb.js`, freshness)

| Path | Issue |
|------|-------|
| `fetchTeamStats(season)` | Full-season aggregates, no target date cutoff |
| `fetchPitcherStats(personId, season)` | Full-season pitcher stats |
| `fetchPitcherRecentStarts` | `.slice(-limit)` on full season log, not filtered before as_of |
| `fetchGameLineupProfile` | Historical boxscore can be actual post-game lineup |
| `determinePredictionTier` | Already-started games get hoursToGame=0 via `Math.max`, treated as final tier not rejected |
| Odds age | Future `fetchedAt` → age 0 → appears fresh |
| `data_freshness.py` | Future timestamps yield negative age → `"fresh"` |

Safer date-aware paths exist (`fetchRollingTeamStats`, bullpen/fatigue/H2H/etc.) but date-only is still weaker than timestamp + first-pitch guards.

### 5.3 Market construction (`src/mlb.js`)

- `devigMoneylinePercent` on independently shopped best home/away can create **synthetic cross-book** pairs (negative overround historically possible).
- `moneylineValueOption` uses generic `moneylineBook`, not side-specific bookmaker.

### 5.4 Calibration

- Runtime maps present in data dir (`calibration_maps.json`, meta claims success).
- Maps are **sparse** (moneyline); YRFI maps retired with the market removal. Artifact hash bound per new prediction where supported.
- JS (`src/calibration.js`) and Python calibrators can diverge; silent identity fallback when maps missing.
- `maybeQueueCalibrationRetrain` can auto-retrain after settled multiples — promotion path not evidence-gated.

### 5.5 Evaluation (`src/evaluate.py`, `src/walk_forward_backtest.py`)

- ROI = `profit / len(bets)` instead of `sum(profit)/sum(stake)`.
- Missing edge/CLV coerced to 0.0.
- Empty metrics return 0.0 (looks perfect).
- `_ledger_row_to_prediction_log`: `final_lean` prefers mutable payload pick over ledger team; away/home probability mapping wrong for away side (home_prob stays model_prob).
- Walk-forward folds inclusive and can overlap; predictor exceptions swallowed.

### 5.6 Live vs backtest divergence

- Production Telegram: JS `predictGame` + market blend + JS value/calibration.
- Python backtest: separate model + sample CSVs — **not** a production replay.
- Dashboard may synthesize mock data on failure (must not look live).

### 5.7 LLM / evolution governance

- Intended: LLM explanation-only.
- Risk: `compactPrediction` persists agent pick as authoritative `pick`.
- Evolution post-game can apply/update production-adjacent state without explicit promotion gates.

---

## 6. Data dependencies

| Source | Used by | Temporal contract today |
|--------|---------|-------------------------|
| MLB StatsAPI schedule/stats/boxscore | `mlb.js` | Partial date filters; season aggregates unsafe |
| The Odds API | odds attach / line movement | Quota/rotation; not full quote history |
| Weather | features | Live fetch; fixture restamp risk in Python |
| SQLite state | ledger, picks, snapshots | Mutable identity |
| Calibration JSON | JS/Python calibrate | Weak artifact identity |
| Evolution/knowledge files | weights/rules | File writes, not immutable candidates |

---

## 7. Duplicated / divergent logic

- Probability calibration: JS vs Python.
- Rule engine: JS vs Python parity tests exist but production is JS.
- Evaluation metrics: Python evaluate vs walk_forward vs dashboard reporting.
- Prediction: live JS vs Python baseline model vs dashboard conversion.

---

## 8. Test coverage gaps (high priority)

- model pick ≠ value bet settlement / CLV side
- immutable recommendation on refresh
- transactional settlement failure + retry
- concurrent settlement
- strict historical as_of cutoffs (team/pitcher/lineup)
- future timestamp = invalid_future
- first-pitch guards for lineup/odds/features
- same-book de-vig vs cross-book best executable
- walk-forward disjoint folds
- live/replay parity fixtures
- stake-weighted ROI + null metrics
- LLM cannot mutate decision fields
- migration quarantine constraints

Existing reusable tests: `tests/test_bet_ledger.js`, moneyline value engine, feature snapshots, closing capture, data freshness, probability calibrator, evaluate sqlite, rule engine parity, odds key pool.

---

## 9. Risk register

### P0 — stop-ship for any performance claim

| ID | Summary | Fact? |
|----|---------|-------|
| P0-mutable-prediction-identity | picks UPSERT overwrites prediction | yes |
| P0-non-atomic-settlement | processed before durable settle; 7 open+processed | yes |
| P0-pick-vs-value-divergence | pick.name ≠ value team on multiple settled rows | yes |
| P0-clv-side-mismatch | CLV uses pick; P/L uses ledger side | yes (code + examples) |
| P0-historical-lookahead | season/boxscore paths without as_of | yes (code) |
| P0-live-backtest-divergence | Python backtest ≠ JS live | yes |

### P1

| ID | Summary |
|----|---------|
| P1-roi-denominator-bug | evaluate ROI / bet count |
| P1-empty-ledger-date | totals open rows date_ymd empty |
| P1-open-totals-stranded | 7 open totals without reliable settle path |
| P1-cross-book-devig | synthetic fair market |
| P1-auto-calibration-promotion | retrain without explicit gate |
| P1-cascade-delete-financials | FK ON DELETE CASCADE |

### P2

| ID | Summary |
|----|---------|
| P2-sparse-calibration-maps | few isotonic points |
| P2-feature-snapshot-no-pitch-guard | storage layer |
| P2-dashboard-mock-fallback | can look live |
| P2-missing-metric-as-zero | evaluation |

### P3

| ID | Summary |
|----|---------|
| P3-manual-check-file-list | package.json check enumerates files |
| P3-model-card-todos | incomplete performance docs |
| P3-yrfi-synthetic-pl | **Closed** — YRFI path removed from evaluate |

---

## 10. Honest limits on historical backfill

Existing rows **cannot reliably recover**:

- original prediction_timestamp / as_of feature state  
- bookmaker + quote ID for each side  
- raw vs calibrated probability stage  
- true pre-first-pitch close for all games  
- production replay snapshots  

**Policy:** import only unambiguous facts; quarantine ambiguous rows; label metrics `unaudited` / `partial` until Phases 1–4 complete.

---

## 11. Remediation order (strict gates)

0. **This audit + unaudited baseline reports**  
1. Immutable ledger + atomic settlement + migration/quarantine  
2. UTC temporal contract + leakage fixes  
3. Pure JS core + snapshot replay/parity  
4. Final-stage calibration + valid evaluation reports  
5. Baselines / model experiments (blocked until 1–4)  
6. Risk, LLM boundary, evolution promotion, monitoring, CI, docs  

No model expansion or profitability claim until gates pass.

---

## 12. Artifacts

- `scripts/run_technical_audit.js` — read-only inventory  
- `reports/audit_inventory.json` / `.md` — machine/human inventory  
- `reports/latest_metrics.json` / `latest_evaluation.md` — **status: unaudited**  

Re-run inventory:

```bash
node scripts/run_technical_audit.js --write --out reports/audit_inventory.json
```
