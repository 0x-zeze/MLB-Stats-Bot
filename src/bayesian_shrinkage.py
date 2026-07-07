"""Bayesian shrinkage for small-sample pitcher and umpire stats.

When a pitcher has only 3 starts, their raw ERA is a noisy estimate of true
talent. We shrink the observed stat toward a league-average prior, with the
shrinkage weight determined by sample size.

Formula (empirical Bayes):
    estimate = (prior_strength * prior + observed_strength * observed)
               / (prior_strength + observed_strength)

where observed_strength ~ n (number of innings/batters faced).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float

# League average priors
LEAGUE_ERA = 4.20
LEAGUE_WHIP = 1.30
LEAGUE_FIP = 4.20
LEAGUE_K_RATE = 0.22  # per batter faced
LEAGUE_BB_RATE = 0.085
LEAGUE_HR9 = 1.1
LEAGUE_UMPIRE_K_ADJ = 0.0
LEAGUE_UMPIRE_BB_ADJ = 0.0

# Prior strengths (equivalent sample sizes)
# A prior strength of 30 IP means: at 30 IP observed, the estimate is 50/50
# prior/observed. At 150 IP, it's 83% observed.
PITCHER_PRIOR_IP = 30.0
PITCHER_PRIOR_BF = 100.0
UMPIRE_PRIOR_GAMES = 20.0


@dataclass
class PitcherBayesianPrior:
    """League-average prior for pitcher stats."""

    era: float = LEAGUE_ERA
    whip: float = LEAGUE_WHIP
    fip: float = LEAGUE_FIP
    k_rate: float = LEAGUE_K_RATE
    bb_rate: float = LEAGUE_BB_RATE
    hr9: float = LEAGUE_HR9
    prior_ip: float = PITCHER_PRIOR_IP
    prior_bf: float = PITCHER_PRIOR_BF


def shrink_era(observed_era: float, innings: float, prior: PitcherBayesianPrior | None = None) -> float:
    """Shrink observed ERA toward league average based on sample size."""
    if prior is None:
        prior = PitcherBayesianPrior()
    if innings <= 0:
        return prior.era
    weight = prior.prior_ip / (prior.prior_ip + innings)
    return prior.era * weight + observed_era * (1.0 - weight)


def shrink_whip(observed_whip: float, innings: float, prior: PitcherBayesianPrior | None = None) -> float:
    if prior is None:
        prior = PitcherBayesianPrior()
    if innings <= 0:
        return prior.whip
    weight = prior.prior_ip / (prior.prior_ip + innings)
    return prior.whip * weight + observed_whip * (1.0 - weight)


def shrink_k_rate(observed_k_rate: float, batters_faced: float, prior: PitcherBayesianPrior | None = None) -> float:
    if prior is None:
        prior = PitcherBayesianPrior()
    if batters_faced <= 0:
        return prior.k_rate
    weight = prior.prior_bf / (prior.prior_bf + batters_faced)
    return prior.k_rate * weight + observed_k_rate * (1.0 - weight)


def shrink_bb_rate(observed_bb_rate: float, batters_faced: float, prior: PitcherBayesianPrior | None = None) -> float:
    if prior is None:
        prior = PitcherBayesianPrior()
    if batters_faced <= 0:
        return prior.bb_rate
    weight = prior.prior_bf / (prior.prior_bf + batters_faced)
    return prior.bb_rate * weight + observed_bb_rate * (1.0 - weight)


def shrink_pitcher_stats(
    era: float,
    whip: float,
    fip: float | None = None,
    k_rate: float | None = None,
    bb_rate: float | None = None,
    innings: float = 0.0,
    batters_faced: float = 0.0,
    prior: PitcherBayesianPrior | None = None,
) -> dict[str, float]:
    """Apply Bayesian shrinkage to all pitcher stats at once."""
    if prior is None:
        prior = PitcherBayesianPrior()

    return {
        "era": shrink_era(era, innings, prior),
        "whip": shrink_whip(whip, innings, prior),
        "fip": shrink_era(fip or prior.fip, innings, prior) if fip is not None else prior.fip,
        "k_rate": shrink_k_rate(k_rate or prior.k_rate, batters_faced, prior) if k_rate is not None else prior.k_rate,
        "bb_rate": shrink_bb_rate(bb_rate or prior.bb_rate, batters_faced, prior) if bb_rate is not None else prior.bb_rate,
        "innings_pitched": innings,
        "batters_faced": batters_faced,
    }


def shrink_umpire_adjustment(
    observed_k_adj: float,
    observed_bb_adj: float,
    games: int,
) -> tuple[float, float]:
    """Shrink umpire K/BB adjustments toward league average (0.0).

    Umpires with <10 games behind the plate are very noisy.
    """
    if games <= 0:
        return 0.0, 0.0
    weight = UMPIRE_PRIOR_GAMES / (UMPIRE_PRIOR_GAMES + games)
    k_adj = LEAGUE_UMPIRE_K_ADJ * weight + observed_k_adj * (1.0 - weight)
    bb_adj = LEAGUE_UMPIRE_BB_ADJ * weight + observed_bb_adj * (1.0 - weight)
    return k_adj, bb_adj


def pitcher_variance_from_sample(
    era_values: list[float],
    innings: float,
    prior: PitcherBayesianPrior | None = None,
) -> float:
    """Estimate a pitcher's start-to-start ERA variance.

    High variance pitchers (e.g. effectively wild power arms) contribute
    more to total-runs variance. Returns ERA stddev on the 0.5-3.0 scale.
    """
    if prior is None:
        prior = PitcherBayesianPrior()
    if len(era_values) < 3:
        # Default variance for small samples
        return 1.5

    from statistics import pstdev
    raw_stddev = pstdev(era_values)

    # Shrink toward a league-average stddev (~1.5)
    weight = prior.prior_ip / (prior.prior_ip + innings)
    shrunk = 1.5 * weight + raw_stddev * (1.0 - weight)
    return clamp(shrunk, 0.5, 3.0)
