# Model Card And Backtest Template

This document is a credibility template. Do not fill in performance numbers unless they come from a reproducible backtest or settled prediction log.

## Model Purpose

The project estimates MLB pre-game probabilities and leans for:

- Moneyline winner.
- Total runs / over-under lean.
- First inning YRFI/NRFI context.

The output is for analysis and education. It is not guaranteed betting advice.

## Data Sources

- MLB StatsAPI schedule, game, venue, probable pitcher, standings, and boxscore context.
- Optional odds provider through `ODDS_API_KEY` or `THE_ODDS_API_KEY`.
- Optional weather provider through `OPENWEATHER_API_KEY`.
- Local sample CSVs in `data/`.
- Persisted bot memory and settled outcomes in `data/state.sqlite` and `data/evolution/`.

## Features Used

- Team offensive and pitching context.
- Starting pitcher stats and recent form.
- Bullpen usage/fatigue.
- Home/away splits and recent form.
- Park factors.
- Weather context when available.
- Market implied probability and line movement when available.
- Lineup status and probable pitcher status.
- Historical memory and audit lessons when enabled.

## Prediction Output Contract

Every betting-facing output should separate:

- Prediction.
- Lean.
- Value.
- No Bet.
- Data Quality.
- Confidence.
- Risk warning.

## Known Limitations

- MLB lineups and pitcher roles can change close to first pitch.
- Odds, weather, injury, and lineup feeds may be missing or stale.
- Optional LLM analysis can summarize context but should not override hard no-bet guardrails.
- Small samples can make ROI, CLV, and confidence buckets misleading.
- Backtests on sample CSVs may not represent live-market performance.

## Calibration Method

TODO: Document the exact calibration method used for the reported period, including whether probabilities were raw, capped, isotonic/logistic calibrated, or adjusted by evolution rules.

## Backtest Report

- Backtest period: TODO.
- Markets included: TODO.
- Sample size: TODO.
- Bets taken: TODO.
- No-bet count: TODO.
- Brier score: TODO.
- Log loss: TODO.
- ROI: TODO.
- CLV: TODO.
- CLV hit rate: TODO.
- Out-of-sample validation: TODO.
- Data exclusions: TODO.

## Segment Checks

- Moneyline by confidence bucket: TODO.
- Totals by market total range: TODO.
- Picks by data quality bucket: TODO.
- Performance with stale/missing odds removed: TODO.
- Performance with projected lineups removed: TODO.
- Performance by month or season phase: TODO.

## Risk And Staking Policy

Default policy:

- Flat stake mode: 1 unit.
- Optional fractional Kelly mode: off by default unless explicitly configured.
- Max stake: 1 unit per pick by default.
- Max daily exposure: 3 units by default.
- Max pick confidence cap: 64% for staking context by default.
- No bet when data quality is below threshold.
- No bet when required lineup, pitcher, or odds data is stale.

## When Users Should Ignore A Prediction

Ignore or downgrade a prediction when:

- Probable pitchers are missing, projected, scratched, or stale.
- Lineups are not confirmed close to game time.
- Odds are unavailable or stale.
- Weather is stale for an outdoor game.
- The model edge is below the configured threshold.
- The dashboard marks data quality below the threshold.
- The pick conflicts with late injury/news or major line movement that the model has not absorbed.
- You cannot verify the current market price.

## Reproducibility

Record the following with every published report:

- Git commit SHA.
- Data snapshot date/time.
- Backtest command.
- Environment variables that affect behavior, excluding secrets.
- Active prompt/rule/weight versions from `data/evolution/`.
