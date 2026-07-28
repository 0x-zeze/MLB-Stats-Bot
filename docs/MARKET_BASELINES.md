# Market Baselines

**Status:** same-period no-vig baselines in `src/evaluate.py` (2026-07-28)

A model is never called "improved" only because its raw win rate is higher. It
must beat the same-period no-vig market on proper scoring rules.

## 1. Same-book two-sided market construction

For each same-book two-sided market:

1. Convert American odds to implied probabilities.
2. Remove the vig (normalize to sum to 1).
3. Store both original and no-vig probabilities.
4. Keep bookmaker identity and quote timestamp.
5. Do **not** combine opposite sides from different bookmakers into one no-vig pair.

Required fields:

```text
bookmaker
quoteTimestamp
awayOdds / homeOdds
awayImpliedProbability / homeImpliedProbability
awayNoVigProbability / homeNoVigProbability
marketOverround
```

## 2. Fair vs executable

- **Fair market** construction uses same-book paired lines (`devigMoneylinePercent`
  with `sameBook`). A negative-overround same-book pair is not a coherent market
  (`usableAsFair: false`).
- **Executable price** is the side-specific best odds + bookmaker id.
- Cross-book synthetic pairs are labeled `synthetic` and never used as fair.

## 3. Baselines reported

For the same leakage-safe period:

- market favorite accuracy;
- market (no-vig) Brier score;
- market (no-vig) log loss;
- model-minus-market Brier improvement (positive = model beats market);
- model-minus-market log-loss improvement.

## 4. Current honest result (unaudited)

From `reports/latest_metrics.json` (population `unaudited`, 47 comparable
moneyline rows):

| Metric | Market | Model | Improvement |
|--------|--------|-------|-------------|
| Accuracy (favorite) | 53.2% | 44.7% | — |
| Brier | 0.2444 | 0.2657 | −0.0213 |
| Log loss | 0.6815 | 0.7250 | −0.0435 |

The current deterministic model **trails** the no-vig market. No profitability
or market-beating claim is made.

## 5. Market-residual candidate (future)

A clearly-separated market-residual model keeps these distinct:

```text
logit(final_probability) = logit(no_vig_market_probability) + learned_baseball_adjustment

pure_baseball_probability   (unchanged when only odds change)
market_probability
residual_adjustment
final_probability
```

## 6. `MARKET_BLEND_WEIGHT`

The display-time market blend in `src/index.js` uses a Bayesian weight
(`0.22 * market_odds multiplier`, capped at 0.35) to produce
`marketInformedProbability`. The exported `MARKET_BLEND_WEIGHT` constant in
`src/mlb.js` documents the base weight; the live blend uses the config/multiplier
path in `attachMarketContext`. Pure baseball probability and VALUE grading always
use the calibrated pure model — never the blended display value.

## 7. Related

- `docs/EVALUATION_METHOD.md`
- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/PREDICTION_ARCHITECTURE.md`
