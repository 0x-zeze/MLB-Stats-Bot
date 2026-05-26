"""Deterministic first-inning run prediction (YRFI/NRFI) model."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .utils import clamp, safe_float


LEAGUE_AVG_FIRST_INNING_SCORING_RATE = 0.27
LEAGUE_AVG_FIRST_INNING_ERA = 4.50
LEAGUE_AVG_FIRST_INNING_WHIP = 1.40
LEAGUE_AVG_LEADOFF_OBP = 0.330
LEAGUE_AVG_FIRST_PITCH_STRIKE_RATE = 0.60
LEAGUE_AVG_VENUE_YRFI_RATE = 0.46
LEAGUE_AVG_K_RATE = 0.22
LEAGUE_AVG_GROUND_BALL_RATE = 0.44

YRFI_MIN_EDGE = 0.06


@dataclass(frozen=True)
class FirstInningContext:
    """Context inputs for first-inning run prediction."""

    away_first_inning_scoring_rate: float = LEAGUE_AVG_FIRST_INNING_SCORING_RATE
    home_first_inning_scoring_rate: float = LEAGUE_AVG_FIRST_INNING_SCORING_RATE
    away_first_inning_allowed_rate: float = LEAGUE_AVG_FIRST_INNING_SCORING_RATE
    home_first_inning_allowed_rate: float = LEAGUE_AVG_FIRST_INNING_SCORING_RATE
    away_pitcher_first_inning_era: float = LEAGUE_AVG_FIRST_INNING_ERA
    home_pitcher_first_inning_era: float = LEAGUE_AVG_FIRST_INNING_ERA
    away_pitcher_first_inning_whip: float = LEAGUE_AVG_FIRST_INNING_WHIP
    home_pitcher_first_inning_whip: float = LEAGUE_AVG_FIRST_INNING_WHIP
    away_leadoff_obp: float = LEAGUE_AVG_LEADOFF_OBP
    home_leadoff_obp: float = LEAGUE_AVG_LEADOFF_OBP
    away_pitcher_first_pitch_strike_rate: float = LEAGUE_AVG_FIRST_PITCH_STRIKE_RATE
    home_pitcher_first_pitch_strike_rate: float = LEAGUE_AVG_FIRST_PITCH_STRIKE_RATE
    venue_yrfi_rate: float = LEAGUE_AVG_VENUE_YRFI_RATE
    park_run_factor: float = 100.0
    away_pitcher_k_rate: float = LEAGUE_AVG_K_RATE
    home_pitcher_k_rate: float = LEAGUE_AVG_K_RATE
    away_pitcher_ground_ball_rate: float = LEAGUE_AVG_GROUND_BALL_RATE
    home_pitcher_ground_ball_rate: float = LEAGUE_AVG_GROUND_BALL_RATE


@dataclass(frozen=True)
class FirstInningPrediction:
    """Deterministic first-inning prediction result."""

    yrfi_probability: float
    nrfi_probability: float
    top_first_run_probability: float
    bottom_first_run_probability: float
    confidence: str
    main_factors: list[str] = field(default_factory=list)
    lean: str = "No lean"


def _half_inning_run_probability(
    team_scoring_rate: float,
    team_allowed_rate: float,
    pitcher_first_inning_era: float,
    pitcher_first_inning_whip: float,
    leadoff_obp: float,
    pitcher_first_pitch_strike_rate: float,
    park_factor: float,
    pitcher_k_rate: float = LEAGUE_AVG_K_RATE,
    pitcher_ground_ball_rate: float = LEAGUE_AVG_GROUND_BALL_RATE,
) -> float:
    """Estimate probability of at least one run in a half-inning."""
    scoring_signal = (team_scoring_rate - LEAGUE_AVG_FIRST_INNING_SCORING_RATE) * 1.2
    allowed_signal = (team_allowed_rate - LEAGUE_AVG_FIRST_INNING_SCORING_RATE) * 0.6

    era_signal = (pitcher_first_inning_era - LEAGUE_AVG_FIRST_INNING_ERA) * 0.025
    whip_signal = (pitcher_first_inning_whip - LEAGUE_AVG_FIRST_INNING_WHIP) * 0.15

    leadoff_signal = (leadoff_obp - LEAGUE_AVG_LEADOFF_OBP) * 0.8
    strike_signal = (LEAGUE_AVG_FIRST_PITCH_STRIKE_RATE - pitcher_first_pitch_strike_rate) * 0.4

    park_signal = (park_factor - 100.0) * 0.002

    k_rate_signal = (LEAGUE_AVG_K_RATE - pitcher_k_rate) * 0.5
    gb_rate_signal = (LEAGUE_AVG_GROUND_BALL_RATE - pitcher_ground_ball_rate) * 0.3

    raw = (
        LEAGUE_AVG_FIRST_INNING_SCORING_RATE
        + scoring_signal
        + allowed_signal
        + era_signal
        + whip_signal
        + leadoff_signal
        + strike_signal
        + park_signal
        + k_rate_signal
        + gb_rate_signal
    )

    return clamp(raw, 0.08, 0.55)


def predict_first_inning(context: FirstInningContext) -> FirstInningPrediction:
    """Produce deterministic YRFI/NRFI probability from context."""
    top_prob = _half_inning_run_probability(
        team_scoring_rate=context.away_first_inning_scoring_rate,
        team_allowed_rate=context.home_first_inning_allowed_rate,
        pitcher_first_inning_era=context.home_pitcher_first_inning_era,
        pitcher_first_inning_whip=context.home_pitcher_first_inning_whip,
        leadoff_obp=context.away_leadoff_obp,
        pitcher_first_pitch_strike_rate=context.home_pitcher_first_pitch_strike_rate,
        park_factor=context.park_run_factor,
        pitcher_k_rate=context.home_pitcher_k_rate,
        pitcher_ground_ball_rate=context.home_pitcher_ground_ball_rate,
    )

    bottom_prob = _half_inning_run_probability(
        team_scoring_rate=context.home_first_inning_scoring_rate,
        team_allowed_rate=context.away_first_inning_allowed_rate,
        pitcher_first_inning_era=context.away_pitcher_first_inning_era,
        pitcher_first_inning_whip=context.away_pitcher_first_inning_whip,
        leadoff_obp=context.home_leadoff_obp,
        pitcher_first_pitch_strike_rate=context.away_pitcher_first_pitch_strike_rate,
        park_factor=context.park_run_factor,
        pitcher_k_rate=context.away_pitcher_k_rate,
        pitcher_ground_ball_rate=context.away_pitcher_ground_ball_rate,
    )

    nrfi_prob = (1.0 - top_prob) * (1.0 - bottom_prob)

    venue_weight = 0.15
    model_yrfi = 1.0 - nrfi_prob
    blended_yrfi = model_yrfi * (1.0 - venue_weight) + context.venue_yrfi_rate * venue_weight
    blended_yrfi = clamp(blended_yrfi, 0.15, 0.75)
    blended_nrfi = 1.0 - blended_yrfi

    edge = abs(blended_yrfi - 0.50)

    if edge < YRFI_MIN_EDGE:
        return FirstInningPrediction(
            yrfi_probability=round(blended_yrfi, 4),
            nrfi_probability=round(blended_nrfi, 4),
            top_first_run_probability=round(top_prob, 4),
            bottom_first_run_probability=round(bottom_prob, 4),
            confidence="Low",
            main_factors=["Insufficient edge for first-inning lean"],
            lean="NO BET",
        )

    if edge >= 0.10:
        confidence = "High"
    elif edge >= 0.05:
        confidence = "Medium"
    else:
        confidence = "Low"

    if blended_yrfi >= 0.55:
        lean = "YRFI"
    elif blended_nrfi >= 0.55:
        lean = "NRFI"
    else:
        lean = "No lean"

    factors = _build_factors(context, top_prob, bottom_prob, blended_yrfi)

    return FirstInningPrediction(
        yrfi_probability=round(blended_yrfi, 4),
        nrfi_probability=round(blended_nrfi, 4),
        top_first_run_probability=round(top_prob, 4),
        bottom_first_run_probability=round(bottom_prob, 4),
        confidence=confidence,
        main_factors=factors,
        lean=lean,
    )


def _build_factors(
    context: FirstInningContext,
    top_prob: float,
    bottom_prob: float,
    yrfi_prob: float,
) -> list[str]:
    """Build human-readable explanation factors."""
    factors: list[str] = []

    if context.away_first_inning_scoring_rate > 0.32:
        factors.append("Away team scores frequently in 1st inning")
    if context.home_first_inning_scoring_rate > 0.32:
        factors.append("Home team scores frequently in 1st inning")

    if context.home_pitcher_first_inning_era > 5.5:
        factors.append("Home pitcher vulnerable in 1st inning (high ERA)")
    elif context.home_pitcher_first_inning_era < 3.0:
        factors.append("Home pitcher strong in 1st inning (low ERA)")

    if context.away_pitcher_first_inning_era > 5.5:
        factors.append("Away pitcher vulnerable in 1st inning (high ERA)")
    elif context.away_pitcher_first_inning_era < 3.0:
        factors.append("Away pitcher strong in 1st inning (low ERA)")

    if context.away_leadoff_obp > 0.380:
        factors.append("Away leadoff hitter has elite OBP")
    if context.home_leadoff_obp > 0.380:
        factors.append("Home leadoff hitter has elite OBP")

    if context.venue_yrfi_rate > 0.52:
        factors.append("Venue historically favors YRFI")
    elif context.venue_yrfi_rate < 0.40:
        factors.append("Venue historically favors NRFI")

    if context.park_run_factor >= 108:
        factors.append("Hitter-friendly park boosts 1st inning scoring")

    return factors[:4] or ["Balanced first-inning profile"]
