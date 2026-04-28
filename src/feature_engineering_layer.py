"""Feature engineering layer for the MLB prediction pipeline.

This module converts raw collected data into clean deterministic features.
It does not make picks, compare markets, run quality control, or explain.
"""

from __future__ import annotations

from typing import Any

from .bullpen import bullpen_fatigue_adjustment
from .features import (
    bullpen_score,
    home_field_adjustment,
    log5_probability,
    offense_score,
    pitcher_score,
    pythagorean_win_pct,
    recent_form_score,
)
from .lineup import lineup_adjustment
from .odds import american_odds_to_implied_probability
from .park_factors import park_factor_adjustment
from .utils import clamp
from .weather import weather_adjustment


SIGNAL_PRIORITY = {
    "tier_1": [
        "probable_pitchers",
        "team_offense",
        "bullpen_usage",
        "park_factor",
        "market_odds",
    ],
    "tier_2": [
        "weather",
        "confirmed_lineup",
        "platoon_splits",
        "recent_form",
    ],
    "tier_3": [
        "umpire_tendency",
        "public_betting_percentage",
        "news_sentiment",
        "head_to_head_trends",
    ],
}


def _team_strength(team) -> float:
    pyth = pythagorean_win_pct(team.runs_scored, team.runs_allowed)
    return clamp(pyth * 0.65 + team.win_pct * 0.35, 0.05, 0.95)


def _pitcher_feature(pitcher) -> float:
    if pitcher is None:
        return 0.0
    return pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)


def _offense_feature(team) -> float:
    return offense_score(team.ops, team.wrc_plus, team.runs_per_game)


def _bullpen_feature(team) -> float:
    return bullpen_score(team.bullpen_era, team.bullpen_whip, team.bullpen_recent_usage)


def _recent_feature(team) -> float:
    return recent_form_score(team.wins_last_10, team.games_last_10, team.run_diff_last_10)


def _market_probability(odds: Any) -> float | None:
    if odds in (None, ""):
        return None
    return american_odds_to_implied_probability(str(odds))


def build_moneyline_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean moneyline model features from raw game data."""
    home_team = collected["home_team"]
    away_team = collected["away_team"]
    home_pitcher = collected["home_pitcher"]
    away_pitcher = collected["away_pitcher"]
    market = collected["market"]

    home_strength = _team_strength(home_team)
    away_strength = _team_strength(away_team)
    log5_home = log5_probability(home_strength, away_strength)

    components = {
        "team_strength": (log5_home - 0.5) * 5.0,
        "starting_pitcher": _pitcher_feature(home_pitcher) - _pitcher_feature(away_pitcher),
        "offense": _offense_feature(home_team) - _offense_feature(away_team),
        "bullpen": _bullpen_feature(home_team) - _bullpen_feature(away_team),
        "recent_form": _recent_feature(home_team) - _recent_feature(away_team),
        "home_field": home_field_adjustment(True),
    }

    return {
        "home_strength": home_strength,
        "away_strength": away_strength,
        "log5_home": log5_home,
        "components": components,
        "market_implied_probability": {
            "home": _market_probability(market.get("home_moneyline")),
            "away": _market_probability(market.get("away_moneyline")),
        },
        "signal_priority": SIGNAL_PRIORITY,
    }


def build_total_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean total-runs model features from raw game data."""
    context = collected["total_context"]
    home_team = collected["home_team"]
    away_team = collected["away_team"]

    return {
        "park_factor_adjustment": park_factor_adjustment(context.park),
        "weather_adjustment": weather_adjustment(context.weather),
        "home_lineup_adjustment": lineup_adjustment(context.home_lineup),
        "away_lineup_adjustment": lineup_adjustment(context.away_lineup),
        "home_bullpen_fatigue": bullpen_fatigue_adjustment(context.home_bullpen),
        "away_bullpen_fatigue": bullpen_fatigue_adjustment(context.away_bullpen),
        "home_recent_form_score": _recent_feature(home_team),
        "away_recent_form_score": _recent_feature(away_team),
        "market_total": collected["market"].get("market_total") if collected["market"].get("available") else None,
        "signal_priority": SIGNAL_PRIORITY,
    }


def build_game_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Build all deterministic features for one game."""
    return {
        "moneyline": build_moneyline_features(collected),
        "totals": build_total_features(collected),
        "signal_priority": SIGNAL_PRIORITY,
    }
