# MLB Analysis Improvements

## Observed Gaps
- Pipeline is solid but mostly league-average / recent-form driven; opponent-adjusted, pitcher-usage-aware, and in-game context features are thin.
- LLM agent mostly rephrases deterministic outputs; it currently adds limited reasoning utility because numeric authority is preserved but contextual authority (what can override qualitative framing) is not structured.
- Current quality control is freshness-centric, not model-risk-centric (e.g., it doesn't downgrade for volatile pitcher or lineup assumptions).

## Recommended Enhancements
### 1. Opponent-adjusted features
- Add park-adjusted, opponent-quality-adjusted pitcher and offense metrics.
- Weight starter matchup not only by ERA/WHIP/FIP but by Stuff+, CSW%, chase%, and handedness splits when available.
- Use rolling 30/60 PA or 5-start pitcher form with opponent strength weighting.

### 2. Bullpen model upgrade
- Fatigue + role-aware model: high-leverage reliever usage (8th/9th), back-to-back days, 3-of-4 usage, and travel days.
- Convert bullpen usage to expected bullpen quality for remaining innings, not just ERA.
- Differentiate between teams with long opener/bulk plans vs true SP.

### 3. Lineup strength model
- Replace "confirmed/projected" boolean with lineup quality score using wRC+, platoon advantage, lineup order weights, and missing-starter impact.
- Treat top-3 hitters and cleanup production separately, because lineup top has outsized run creation.

### 4. Totals modeling
- Convert run expectancy to per-inning expected runs and simulate with pitcher/bullpen/lineup changeovers.
- Add stadium-specific environment + umpire zone tendencies (optional) and weather + altitude adjustments as separate features.

### 5. Market-aware reasoning layer
- Keep deterministic probabilities, but add "why market is wrong" layer: model vs closing line movement, steam move detection, opener timing, and late lineup news.
- Add line value decomposition (edge from offense vs edge from pitching vs edge from bullpen).

### 6. Risk/uncertainty scoring
- Instead of only Low/Medium/High, add confidence interval width and source variance (pitcher uncertainty, lineup uncertainty, market uncertainty).
- Downgrade when variance sources conflict (e.g., strong pitcher edge but late scratch possibility).

### 7. Agent prompt restructuring
- Split prompt into:
  1) **Fact extraction** from model context (required fields)
  2) **Disagreement audit** (what could be missing or wrong)
  3) **Narrative recommendation** (lean/value/no-bet rationale)
- Allow LLM to propose overrides only when explicitly justified with data signals, and log override reason + confidence delta.

### 8. Memory usage upgrade
- Move from matchup memory as soft context to **weighted memory**: recency, similarity, sample size, and market regime (totals environment).
- Use memory to adjust risk framing, not raw probabilities.

### 9. Model evaluation loops
- Add segment-level Brier/log loss by:
  - Starter tier
  - Lineup confirmed vs projected
  - Market movement bucket
  - Totals environment
- Use this to calibrate confidence caps by segment.

### 10. Practical near-term changes
- Add feature `matchup_difficulty` for each team and pitcher.
- Add `expected_length_of_start` to model SP impact.
- Add `bullpen_expected_quality_remaining` instead of only usage flag.
- Add `lineup_impact_score` based on missing key bats.
- Add `late_news_penalty` when lineup/pitcher news arrives close to game time.