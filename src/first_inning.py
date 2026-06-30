"""Deterministic first-inning run prediction (YRFI/NRFI) model."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .utils import clamp, data_path, safe_float


# Per-half-inning scoring prior. Empirically a run scores in the 1st in ~55% of
# games, which implies a per-half rate near 0.33 (1-(1-r)^2 = 0.55). The old
# 0.27 / 0.46 venue rate centered YRFI near 47% — below the true base rate —
# biasing the model toward NRFI on games that actually scored.
LEAGUE_AVG_FIRST_INNING_SCORING_RATE = 0.33
LEAGUE_AVG_FIRST_INNING_ERA = 4.50
LEAGUE_AVG_FIRST_INNING_WHIP = 1.40
LEAGUE_AVG_LEADOFF_OBP = 0.330
LEAGUE_AVG_FIRST_PITCH_STRIKE_RATE = 0.60
LEAGUE_AVG_VENUE_YRFI_RATE = 0.55
LEAGUE_AVG_K_RATE = 0.22
LEAGUE_AVG_GROUND_BALL_RATE = 0.44
LEAGUE_AVG_PITCHES_FIRST_INNING = 16.0

YRFI_MIN_EDGE = 0.06

# Cache for SP first inning stats
_sp_first_inning_cache: dict[str, dict[str, float]] | None = None


def load_sp_first_inning_stats() -> dict[str, dict[str, float]]:
    """Load pitcher-specific first-inning stats from JSON file.

    Data structure: {pitcher_name: {first_inning_era, first_pitch_strike_pct, avg_pitches_first_inning}}
    Falls back to pybaseball if installed, otherwise reads from data/sp_first_inning_stats.json.
    """
    global _sp_first_inning_cache
    if _sp_first_inning_cache is not None:
        return _sp_first_inning_cache

    _sp_first_inning_cache = {}
    json_path = Path(data_path("sp_first_inning_stats.json"))
    if json_path.exists():
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for pitcher_name, stats in raw.items():
                    if isinstance(stats, dict):
                        _sp_first_inning_cache[str(pitcher_name).strip()] = {
                            "first_inning_era": safe_float(stats.get("first_inning_era"), None),
                            "first_pitch_strike_pct": safe_float(stats.get("first_pitch_strike_pct"), None),
                            "avg_pitches_first_inning": safe_float(stats.get("avg_pitches_first_inning"), None),
                        }
        except Exception:
            _sp_first_inning_cache = {}

    return _sp_first_inning_cache


def get_sp_first_inning_stats(pitcher_name: str | None) -> dict[str, float | None]:
    """Get first-inning stats for a specific pitcher by name."""
    if not pitcher_name:
        return {}
    try:
        stats = load_sp_first_inning_stats()
        return stats.get(pitcher_name.strip(), {})
    except Exception:
        return {}


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
    away_pitcher_avg_pitches_first_inning: float = LEAGUE_AVG_PITCHES_FIRST_INNING
    home_pitcher_avg_pitches_first_inning: float = LEAGUE_AVG_PITCHES_FIRST_INNING
    weather_yrfi_adjustment: float = 0.0


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
    pitcher_avg_pitches_first_inning: float = LEAGUE_AVG_PITCHES_FIRST_INNING,
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

    # High pitch count in first inning = more traffic = higher scoring chance
    pitches_signal = (pitcher_avg_pitches_first_inning - LEAGUE_AVG_PITCHES_FIRST_INNING) * 0.01

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
        + pitches_signal
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
        pitcher_avg_pitches_first_inning=context.home_pitcher_avg_pitches_first_inning,
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
        pitcher_avg_pitches_first_inning=context.away_pitcher_avg_pitches_first_inning,
    )

    nrfi_prob = (1.0 - top_prob) * (1.0 - bottom_prob)

    venue_weight = 0.15
    model_yrfi = 1.0 - nrfi_prob
    blended_yrfi = model_yrfi * (1.0 - venue_weight) + context.venue_yrfi_rate * venue_weight

    # Apply weather adjustment for first inning
    blended_yrfi += context.weather_yrfi_adjustment

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
