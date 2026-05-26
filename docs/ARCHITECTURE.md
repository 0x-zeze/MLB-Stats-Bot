# Architecture

## System Flow

```text
MLB StatsAPI / odds / weather data
  -> data collection and feature engineering
  -> prediction engine
  -> market comparison and risk controls
  -> analyst / LLM layer when enabled
  -> Telegram bot output
  -> storage, memory, evaluation, backtesting, calibration
  -> FastAPI dashboard API
  -> React dashboard
```

## Major Modules

- `src/index.js`: Telegram bot entrypoint, command routing, alerts, post-game checks, and dashboard startup coordination.
- `src/mlb.js`: Live MLB schedule/context collection, probability formatting, moneyline value checks, totals output, and Telegram message formatting.
- `src/llm.js` and `src/analystSkill.js`: Optional analyst layer. If disabled or unavailable, deterministic/rule-based output remains available.
- `src/storage.js`: SQLite-backed Telegram state, predictions, memory, subscribers, and alert settings.
- `src/prediction_pipeline.py`: Python pipeline for sample/local predictions. It coordinates collection, features, predictions, market comparison, quality control, risk controls, and explanations.
- `src/data_collection.py`, `src/data_sources/`: MLB, odds, weather, Statcast/pybaseball, Retrosheet, and cache helpers.
- `src/feature_engineering_layer.py`, `src/features.py`: Feature construction for team, pitcher, lineup, bullpen, weather, park, and market context.
- `src/model.py`, `src/prediction_layer.py`, `src/totals.py`, `src/first_inning.py`: Deterministic prediction models for moneyline, totals, and first inning.
- `src/market_comparison.py`, `src/odds.py`, `src/lineMovement.js`: Implied probability, edge, odds freshness, and line movement.
- `src/quality_control.py`: Data quality, stale/missing data checks, confidence downgrades, and uncertainty scoring.
- `src/risk_management.py`: Flat stake and fractional Kelly guardrails, confidence caps, max exposure, and no-bet rules.
- `src/explanation_layer.py`: Conservative final explanation sections for Python pipeline output.
- `src/backtest.py`, `src/evaluate.py`, `src/backtest_report.py`, `src/backtest_automation.py`: Backtests, result logs, metrics, and reports.
- `src/calibration.py`, `src/probability_calibrator.py`, `src/evolution/`: Calibration, learning memory, audit trails, rule candidates, promotion gates, and language-loss summaries.
- `src/dashboard_api.py`, `src/dashboard_service.py`: FastAPI routes, token auth, CORS, rate limiting, health status, dashboard data shaping, exports, and settings.
- `dashboard-react/`: React control center UI.
- `data/`: Sample CSVs, dashboard mock data, persisted state, prediction logs, and evolution memory.
- `tests/`: Python and Node tests for model logic, API auth, dashboard services, Telegram formatting, storage, and evolution modules.

## Where Predictions Are Generated

Live Telegram predictions are generated through `src/mlb.js` and called from `src/index.js`. The React dashboard API can call the same live Node prediction layer through `src/dashboard_service.py`.

The local Python pipeline starts at `src/prediction_pipeline.py`. It is used by tests, sample dashboard mode, backtests, and explainable local modeling.

## Where Results Are Stored

- Telegram runtime state: `data/state.sqlite`.
- Legacy state fallback: `data/state.json`.
- Prediction logs and backtest rows: `data/predictions_log.csv` and sample CSVs.
- Evolution and learning artifacts: `data/evolution/*.json`, `*.jsonl`, and `prediction_outcomes.csv`.
- Dashboard settings: `data/dashboard_settings.json`.

## Backtesting And Calibration

Backtesting happens in `src/backtest.py` and dashboard wrappers in `src/dashboard_service.py`. Evaluation metrics are calculated in `src/evaluate.py`. Calibration and automated adjustment code lives in `src/calibration.py`, `src/probability_calibrator.py`, and `src/evolution/calibration_auto_adjust.py`.

Promotion of rule or weight changes should go through the evolution promotion gate and should not bypass no-bet, stale-data, or exposure controls.

## Security Boundary

The dashboard API validates `Authorization: Bearer <DASHBOARD_API_TOKEN>` when a token is configured. In production, the API refuses to start without that token. React should be served through Nginx or the provided Docker `dashboard-web` service, with API traffic proxied to the internal API service. Do not expose `.env`, raw state files, or API tokens publicly.
