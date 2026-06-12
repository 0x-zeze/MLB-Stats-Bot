# De-vig × Line-Shopping Finding — Bayesian Forecast

**Date:** 2026-06-12
**Context:** Code review of commit `8a766b0` flagged `mlb.js:475` (de-vig fair line computed from line-shopped best-of-different-book prices) as the top-severity finding. This forecast tests whether that finding is *materially* impactful or merely technically-real.

## Question

**H:** The de-vig × line-shopping interaction at `mlb.js:475` materially distorts moneyline edge in production — enough to flip the bet decision on ≥5% of a typical slate (true fix-worthy-now bug, not a negligible one).

- **Resolves when:** realized overround / cross-book asymmetry is measured on real slate data.
- **Matters because:** determines whether this jumps ahead of the three confirmed bugs (`index.js:1294`, `language_loss.py:53`, `llm.js:843`) in the fix queue.

## Prior

Base rate for "multi-angle-flagged + code-verified review finding turns out *materially* impactful (not just mechanically real)": ~50–60%. Verification establishes the mechanism, not the magnitude.

**Prior: 55%** (odds 1.22)

## Evidence & Likelihoods

| # | Evidence | P(E\|H) | P(E\|¬H) | LR | Direction |
|---|----------|--------|---------|-----|-----------|
| E1 | De-vig is a normalized ratio; symmetric line-shopping cancels in it (only cosmetic overround drops). Distortion needs *asymmetric* cross-book disagreement, which is observed to be modest in MLB ML. | 0.25 | 0.80 | 0.31 | against |
| E2 | Same commit independently loosened edge thresholds (2.0→1.0, 5.0→3.0, 0.08→0.05), so smaller fair-prob shifts can flip marginal picks. | 0.90 | 0.50 | 1.80 | for |
| E3 | Edge is one input among dominating guards (NO-BET filter, <3-factor agreement, lineup penalty); a distorted edge often doesn't survive to flip the final decision. | 0.40 | 0.70 | 0.57 | against |
| E4 | **Measured:** 51 real paired ML snapshots (post-commit, already shopped) show median overround 4.05% (p25–p75 = 3.90–4.15%), **0 negative/arb overrounds**, 84% in the healthy 3–6% band. The collapsed/meaningless-fair-line failure mode never occurred. | 0.15 | 0.92 | 0.16 | strong against |

## Posterior

```
odds = 1.22 × 0.31 × 1.80 × 0.57 × 0.16 = 0.064
P(H material) = 0.064 / 1.064 ≈ 6%
```

- After mechanism-only reasoning (E1–E3): **~28%**
- After measuring real overrounds (E4): **~6%**

## Calibration Notes

- **E4 is the decisive lever and it's empirical, not a guess.** The snapshots are post-commit, so they already reflect line-shopping — making them the ideal test. Shopped prices *still* show textbook ~4% two-sided vig, so the ratio is not collapsing.
- The 5 sub-2% overrounds are all extreme favorites (−10000/−20000) where implied probs floor-clamp — a separate, benign artifact, not shopping collapse.
- **Residual 6% (not 0%):** the snapshot store keeps only the selected best price per side, not per-bookmaker, so I measured the *symptom* (overround health), not the *cause* (per-book spread) directly. A pathological asymmetric slate remains possible but unobserved in this sample (n=51).
- **Motivated-reasoning check:** I had just defended this as top-severity in the review. The ratio-self-correction math (E1) and the overround data (E4) both push *against* my prior position — and I let them. Good sign for calibration.

## Conclusion

The mechanism is real but the **impact is very likely negligible** (~6%). This finding ranks **below** the three confirmed bugs, not above them. My original "highest-severity, fix-first" framing in the review was **overconfident** — corrected here.

**Recommended action:** downgrade to a known-limitation + cheap guard. De-vig each side against the *same book's* two prices (or a consensus book) and line-shop only for the *displayed* price. This removes the theoretical asymmetry artifact regardless, at low cost, without urgency.
