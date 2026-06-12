# Confirmed Findings — Bayesian Calibration Rerun

**Date:** 2026-06-12
**Context:** After downgrading the de-vig finding (`mlb.js:475`) from ~top-severity to ~6% material (see `devig-finding-forecast.md`), this reruns the same calibration discipline on the four findings I called "confirmed" in the review. For each, **H = the finding is materially impactful (worth fixing now), not technically-real-but-negligible.** Same prior logic: code-verification proves the mechanism, not the magnitude.

Where possible I grounded priors in real data (`prediction_outcomes.csv`, n=998; `line_snapshots`, n=51).

---

## 1. `index.js:1294` — empty-cache gate skips regeneration

`predictionsHaveRawProbabilities([])` returns `true` (vacuous `.every`), so a cached `[]` makes `/picks` skip regeneration for the 30-min TTL.

| | |
|---|---|
| **Prior** | 45% (verified bug, but feels edge-triggered) |
| E1: requires a `[]` to get cached — only happens on a genuinely empty fetch (transient API failure or no-games-yet). Not the common path. P(E\|H)=0.4, P(E\|¬H)=0.7 → **LR 0.57** | against |
| E2: self-heals after 30-min TTL; user can also wait or re-trigger. Bounded blast radius. P=0.3/0.65 → **LR 0.46** | against |
| E3: when it *does* fire, the failure is silent and user-facing (empty `/picks` while games exist) — exactly the kind of bug that erodes trust. P=0.8/0.45 → **LR 1.78** | for |
| **Posterior** | **odds 0.82 × 0.57 × 0.46 × 1.78 = 0.38 → ~28%** |

**Read:** Real but low-frequency. The fix is trivial (`predictions.length > 0 && predictions.every(...)`), so cost-to-fix is near-zero even at 28% — **fix it because it's cheap, not because it's likely.**

---

## 2. `language_loss.py:53` — contradicts evaluator's new overconfidence definition

Same commit narrowed evaluator overconfidence to `prob > 0.65` but broadened language_loss to `overconfidence OR (loss AND confidence in {medium,high})`.

| | |
|---|---|
| **Prior** | 50% (clear logical contradiction introduced in one commit) |
| E1: **measured** — the disagreement population (med/high-confidence losses) is 147 rows = 14.7% of data, and **all are totals/yrfi** (moneyline uses `model`/`low` labels, never triggers). So the contradiction is real but confined to two markets. P=0.6/0.5 → **LR 1.20** | weak for |
| E2: this is a *learning-signal* contamination, not a user-facing or bet-affecting bug. It biases which losses get tagged "overconfidence" for lesson/gradient generation — a slow, second-order effect. P=0.45/0.6 → **LR 0.75** | against |
| E3: the contradiction defeats the *stated intent* of the evaluator change in the same commit (a coherence bug — the author clearly wanted one definition). P=0.85/0.5 → **LR 1.70** | for |
| **Posterior** | **odds 1.0 × 1.20 × 0.75 × 1.70 = 1.53 → ~60%** |

**Read:** Highest material-probability of the four. It's a genuine self-contradiction the author would want to know about, affecting ~15% of training rows. **This is the one to fix first** — and it's a one-line decision (pick threshold-based or label-based, not both).

---

## 3. `llm.js:843` — NO BET picks mislabeled as "thin lean" on mixed slates

`isAcceptablePick` dropped the `status !== 'NO BET'` check; the all-NO-BET warning only fires when `qualityCount === 0`.

| | |
|---|---|
| **Prior** | 50% (verified; frequency depends on slate composition) |
| E1: project memory + the whole `/picks` rework premise is that **most picks are NO BET** on typical slates. Mixed slates (1–4 quality picks + NO BET fill) are common, so the mislabel fires often. P=0.8/0.5 → **LR 1.60** | for |
| E2: severity is UX/labeling, not a wrong bet — the per-pick tier still shows "⛔ No Bet Risk", so an attentive user sees the truth; only the header lies. P=0.35/0.65 → **LR 0.54** | against |
| E3: this directly undercuts the feature's purpose (honestly ranking picks); a user trusting the "lean" header bets a NO-BET pick. P=0.75/0.5 → **LR 1.50** | for |
| **Posterior** | **odds 1.0 × 1.60 × 0.54 × 1.50 = 1.30 → ~56%** |

**Read:** Likely material *and* frequent, but low-stakes per occurrence (mislabel, not misbet). Fix is small — broaden the all-NO-BET warning to fire whenever any displayed pick is NO BET, or relabel the header honestly. **Fix second.**

---

## 4. `prediction_evaluator.py:393` — underconfidence fires on default 0.5 probability

`_predicted_probability` defaults to 0.5 when the probability field is missing; `status=='win' and 0 < 0.5 < 0.55` → false-positive underconfidence.

| | |
|---|---|
| **Prior** | 40% (real mechanism; hinges on how often probability is actually missing) |
| E1: the `> 0` clause is provably dead (value clamped to ≥0.001), confirming the author didn't fully trace the default path — raises odds the 0.5 case was also unconsidered. P=0.7/0.5 → **LR 1.40** | for |
| E2: well-formed predictions from `predictGame` populate `moneyline_probability`, so missing-probability wins are likely rare in normal operation (mostly legacy/malformed rows). P=0.35/0.65 → **LR 0.54** | against |
| E3: even when it fires, effect is the same class as #2 — training-signal contamination of the `underconfidence` segment, second-order. P=0.45/0.6 → **LR 0.75** | against |
| **Posterior** | **odds 0.67 × 1.40 × 0.54 × 0.75 = 0.38 → ~28%** |

**Read:** Lowest-priority confirmed item. Real, but likely rare and second-order. Worth a guard (`probability_value not in {default}`) bundled with the #2 fix since both touch the same calibration-signal path.

---

## Revised Fix Queue (was: de-vig first)

| Rank | Finding | P(material) | Stakes | Fix cost |
|------|---------|-------------|--------|----------|
| 1 | `language_loss.py:53` contradiction | **60%** | learning coherence, ~15% of rows | 1 line |
| 2 | `llm.js:843` NO-BET mislabel | **56%** | user trust, frequent | small |
| 3 | `index.js:1294` empty-cache gate | 28% | silent UX failure | trivial |
| 3 | `prediction_evaluator.py:393` underconf default | 28% | training signal | small |
| 5 | `mlb.js:475` de-vig × shopping | **6%** | measured negligible | medium |

## Calibration Meta-Note

My review ranked `mlb.js:475` **#1** and treated all four above as a flat "confirmed" tier. Measurement + explicit priors **reordered the entire queue**: the headline finding fell to last (6%), and a one-line logical contradiction I listed third rose to first (60%). The lesson holds across both forecasts — **multi-angle agreement and code-verification calibrate *existence*, not *magnitude*.** Severity ranking without magnitude estimation was the systematic error.
