"""Dynamic variance calculation for the totals model."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


@dataclass(frozen=True)
class VarianceContext:
    """Inputs for dynamic variance calculation."""

    home_bullpen_fatigue: float = 0.0
    away_bullpen_fatigue: float = 0.0
    park_volatility: float = 1.0
    weather_uncertainty: float = 0.0
    home_pitcher_era_stddev: float = 0.0
    away_pitcher_era_stddev: float = 0.0
    projected_total: float = 8.8
    win_probability_edge: float = 0.0


def compute_dynamic_variance(context: VarianceContext) -> float:
    """Calculate game-specific variance for negative binomial model.

    Replaces the fixed formula: max(projected_total * 1.25, projected_total + 1.0)
    with a context-aware calculation that accounts for bullpen fatigue,
    park volatility, weather uncertainty, and pitcher consistency.
    """
    base_variance = context.projected_total * 1.15 + 0.8

    bullpen_factor = 1.0 + (context.home_bullpen_fatigue + context.away_bullpen_fatigue) * 0.12

    park_factor = 0.9 + context.park_volatility * 0.2

    weather_factor = 1.0 + context.weather_uncertainty * 0.15

    pitcher_consistency = (
        context.home_pitcher_era_stddev + context.away_pitcher_era_stddev
    ) * 0.08
    pitcher_factor = 1.0 + min(pitcher_consistency, 0.25)

    blowout_adj = blowout_correlation_adjustment(
        context.projected_total, context.win_probability_edge
    )

    dynamic = base_variance * bullpen_factor * park_factor * weather_factor * pitcher_factor + blowout_adj

    return clamp(dynamic, context.projected_total * 1.05, context.projected_total * 2.0)


def blowout_correlation_adjustment(
    projected_total: float,
    win_probability_edge: float,
) -> float:
    """Adjust variance for correlated scoring in lopsided matchups.

    When one team is a heavy favorite, scoring becomes correlated:
    the trailing team takes more risks, the leading team's bullpen
    gets more rest. This increases total variance.
    """
    edge = abs(safe_float(win_probability_edge, 0.0))

    if edge < 0.10:
        return 0.0

    correlation_boost = (edge - 0.10) * 2.5
    return clamp(correlation_boost, 0.0, 1.5)


def monte_carlo_total_probability(
    home_expected: float,
    away_expected: float,
    variance: float,
    line: float,
    side: str = "over",
    iterations: int = 1000,
    seed: int | None = None,
) -> float:
    """Monte Carlo simulation for total probability.

    Uses negative binomial sampling for each team's runs,
    then counts how often the total exceeds/falls below the line.
    Falls back gracefully if variance is invalid.
    """
    home_mean = max(0.5, safe_float(home_expected, 4.4))
    away_mean = max(0.5, safe_float(away_expected, 4.4))
    total_mean = home_mean + away_mean
    var = max(total_mean + 0.1, safe_float(variance, total_mean * 1.25))

    r_home = home_mean ** 2 / max(var / 2.0 - home_mean, 0.01)
    p_home = r_home / (r_home + home_mean)
    r_away = away_mean ** 2 / max(var / 2.0 - away_mean, 0.01)
    p_away = r_away / (r_away + away_mean)

    rng = random.Random(seed)
    over_count = 0
    cutoff = math.floor(safe_float(line))

    for _ in range(iterations):
        try:
            home_runs = _sample_negative_binomial(r_home, p_home, rng)
            away_runs = _sample_negative_binomial(r_away, p_away, rng)
        except (ValueError, OverflowError):
            home_runs = rng.randint(2, 7)
            away_runs = rng.randint(2, 7)

        total = home_runs + away_runs
        if total > cutoff:
            over_count += 1

    over_prob = over_count / iterations
    return over_prob if side.lower() == "over" else 1.0 - over_prob


def _sample_negative_binomial(r: float, p: float, rng: random.Random) -> int:
    """Sample from negative binomial using gamma-poisson mixture."""
    r_clamped = clamp(r, 0.5, 100.0)
    p_clamped = clamp(p, 0.01, 0.99)

    scale = (1.0 - p_clamped) / p_clamped
    gamma_sample = _sample_gamma(r_clamped, scale, rng)
    return _sample_poisson(gamma_sample, rng)


def _sample_gamma(shape: float, scale: float, rng: random.Random) -> float:
    """Sample from gamma distribution using Marsaglia and Tsang's method."""
    if shape < 1.0:
        u = rng.random()
        return _sample_gamma(shape + 1.0, scale, rng) * (u ** (1.0 / shape))

    d = shape - 1.0 / 3.0
    c = 1.0 / math.sqrt(9.0 * d)

    while True:
        x = rng.gauss(0, 1)
        v = (1.0 + c * x) ** 3
        if v <= 0:
            continue
        u = rng.random()
        if u < 1.0 - 0.0331 * (x ** 2) ** 2:
            return d * v * scale
        if math.log(u) < 0.5 * x ** 2 + d * (1.0 - v + math.log(v)):
            return d * v * scale


def _sample_poisson(lam: float, rng: random.Random) -> int:
    """Sample from Poisson distribution using Knuth's algorithm."""
    lam_clamped = min(lam, 50.0)
    if lam_clamped <= 0:
        return 0

    l_val = math.exp(-lam_clamped)
    k = 0
    p = 1.0

    while p > l_val:
        k += 1
        p *= rng.random()

    return k - 1
