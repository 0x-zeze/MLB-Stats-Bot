"""Feature engineering layer for the MLB prediction pipeline.

This module converts raw collected data into clean deterministic features.
It does not make picks, compare markets, run quality control, or explain.
"""

from __future__ import annotations

from typing import Any

from .batter_vs_pitcher import aggregate_bvp_for_lineup, bvp_adjustment
from .bullpen import bullpen_fatigue_adjustment
from .features import (
    bullpen_score,
    detect_opener_situation,
    get_pitcher_rest_days,
    get_team_schedule_fatigue,
    home_field_adjustment,
    log5_probability,
    offense_score,
    pitcher_score,
    pythagorean_win_pct,
    recent_form_score,
)
from .lineup import lineup_adjustment
from .lineup_depth import LineupDepthContext, enhanced_lineup_impact
from .odds import american_odds_to_implied_probability
from .park_factors import park_factor_adjustment
from .pitcher_matchup import (
    PitcherMatchupContext,
    classify_lineup_handedness,
    enhanced_pitcher_score,
)
from .rolling_expected_stats import xstats_offense_adjustment
from .travel_fatigue import travel_fatigue_adjustment
from .umpire import umpire_adjustment
from .utils import clamp, safe_float
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
        "travel_fatigue",
        "batter_vs_pitcher",
        "day_after_night",
    ],
}


def _team_strength(team) -> float:
    pyth = pythagorean_win_pct(team.runs_scored, team.runs_allowed)
    return clamp(pyth * 0.65 + team.win_pct * 0.35, 0.05, 0.95)


def _pitcher_rest_multiplier(rest_days: int) -> float:
    if rest_days <= 3:
        return 0.85
    if rest_days >= 6:
        return 0.93
    return 1.0


def _team_fatigue_offense_adjustment(fatigue: dict[str, Any]) -> float:
    return -0.05 if fatigue.get("doubleheader_last_3_days") else 0.0


def _team_fatigue_overall_adjustment(fatigue: dict[str, Any]) -> float:
    return -0.03 if int(fatigue.get("road_streak") or 0) >= 7 else 0.0


def _pitcher_feature(
    pitcher,
    rest_days: int | None = None,
    opener_detection: dict[str, Any] | None = None,
) -> float:
    if pitcher is None:
        return 0.0
    if opener_detection and opener_detection.get("is_opener"):
        return 0.0
    score = pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)
    if rest_days is not None:
        score *= _pitcher_rest_multiplier(rest_days)
    return clamp(score, -1.0, 1.0)


def _enhanced_pitcher_feature(
    pitcher,
    opponent_lineup: Any,
    rest_days: int | None = None,
    opener_detection: dict[str, Any] | None = None,
) -> float:
    """Pitcher feature using enhanced matchup scoring when data is available."""
    if pitcher is None:
        return 0.0
    if opener_detection and opener_detection.get("is_opener"):
        return 0.0

    lineup_for_handedness = None
    if isinstance(opponent_lineup, (dict, list)):
        lineup_for_handedness = opponent_lineup
    handedness = classify_lineup_handedness(lineup_for_handedness)
    context = PitcherMatchupContext(
        pitcher=pitcher,
        opponent_lineup_handedness=handedness,
        tto_woba=getattr(pitcher, "tto_woba", None),
        pitch_count_trend=getattr(pitcher, "pitch_count_trend", None),
        whiff_rate=getattr(pitcher, "whiff_rate", None),
        chase_rate=getattr(pitcher, "chase_rate", None),
    )
    score = enhanced_pitcher_score(context)
    if rest_days is not None:
        score *= _pitcher_rest_multiplier(rest_days)
    return clamp(score, -1.0, 1.0)


def _offense_feature(team, fatigue: dict[str, Any] | None = None) -> float:
    score = offense_score(team.ops, team.wrc_plus, team.runs_per_game)
    if fatigue:
        score += _team_fatigue_offense_adjustment(fatigue)
    return clamp(score, -1.0, 1.0)


def _bullpen_feature(team) -> float:
    return bullpen_score(team.bullpen_era, team.bullpen_whip, team.bullpen_recent_usage)


def _recent_feature(team) -> float:
    return recent_form_score(team.wins_last_10, team.games_last_10, team.run_diff_last_10)


def _market_probability(odds: Any) -> float | None:
    if odds in (None, ""):
        return None
    return american_odds_to_implied_probability(str(odds))


def _build_lineup_depth(lineup_data: Any) -> dict[str, Any] | None:
    """Build lineup depth context from lineup data."""
    if lineup_data is None:
        return None

    wrc_plus_list = None
    total_war = 0.0
    missing_wars = None
    catcher_framing = 0.0

    if hasattr(lineup_data, "batting_order_wrc_plus"):
        wrc_plus_list = lineup_data.batting_order_wrc_plus
    elif isinstance(lineup_data, dict):
        wrc_plus_list = lineup_data.get("batting_order_wrc_plus")

    if hasattr(lineup_data, "total_lineup_war"):
        total_war = safe_float(lineup_data.total_lineup_war, 0.0)
    elif isinstance(lineup_data, dict):
        total_war = safe_float(lineup_data.get("total_lineup_war"), 0.0)

    if hasattr(lineup_data, "missing_player_wars"):
        missing_wars = lineup_data.missing_player_wars
    elif isinstance(lineup_data, dict):
        missing_wars = lineup_data.get("missing_player_wars")

    if hasattr(lineup_data, "catcher_framing_runs"):
        catcher_framing = safe_float(lineup_data.catcher_framing_runs, 0.0)
    elif isinstance(lineup_data, dict):
        catcher_framing = safe_float(lineup_data.get("catcher_framing_runs"), 0.0)

    context = LineupDepthContext(
        batting_order_wrc_plus=wrc_plus_list,
        total_lineup_war=total_war,
        missing_player_wars=missing_wars,
        catcher_framing_runs=catcher_framing,
    )
    return enhanced_lineup_impact(context)


def _attr(value: Any, *names: str) -> Any:
    for name in names:
        if isinstance(value, dict) and value.get(name) not in (None, ""):
            return value.get(name)
        if hasattr(value, name):
            attr = getattr(value, name)
            if attr not in (None, ""):
                return attr
    return None


def _game_pk(game: Any) -> Any:
    return _attr(game, "game_pk", "gamePk", "id", "game_id")


def _pitcher_payload(collected: dict[str, Any], side: str, pitcher: Any) -> dict[str, Any]:
    context = collected.get("context", {})
    probable = (context.get("probable_pitchers") or {}).get(side)
    payload = dict(probable) if isinstance(probable, dict) else {}
    game = collected.get("game")

    for key in ("game_note", "game_notes", "description", "notes"):
        value = _attr(game, key)
        if value not in (None, "") and key not in payload:
            payload[key] = value

    if pitcher is not None:
        payload.setdefault("pitcher", _attr(pitcher, "pitcher", "fullName", "name"))
        payload.setdefault("team", _attr(pitcher, "team"))

    return payload


def _opener_situation(collected: dict[str, Any], side: str, pitcher: Any) -> dict[str, Any]:
    return detect_opener_situation(
        _game_pk(collected.get("game")),
        _pitcher_payload(collected, side, pitcher),
    )


def build_moneyline_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean moneyline model features from raw game data."""
    home_team = collected["home_team"]
    away_team = collected["away_team"]
    home_pitcher = collected["home_pitcher"]
    away_pitcher = collected["away_pitcher"]
    market = collected["market"]
    game = collected.get("game")
    schedule_data = collected.get("state", {}).get("games", [])
    game_date = getattr(game, "date", collected.get("context", {}).get("date", ""))

    home_pitcher_rest_days = (
        get_pitcher_rest_days(home_pitcher.pitcher, game_date, schedule_data)
        if home_pitcher is not None
        else None
    )
    away_pitcher_rest_days = (
        get_pitcher_rest_days(away_pitcher.pitcher, game_date, schedule_data)
        if away_pitcher is not None
        else None
    )
    home_fatigue = get_team_schedule_fatigue(home_team.team, game_date, schedule_data)
    away_fatigue = get_team_schedule_fatigue(away_team.team, game_date, schedule_data)
    opener_situation = {
        "home": _opener_situation(collected, "home", home_pitcher),
        "away": _opener_situation(collected, "away", away_pitcher),
    }
    opener_flag = any(item.get("is_opener") for item in opener_situation.values())
    opener_notes = [
        f"{side}: SP role unclear — opener situation likely"
        for side, item in opener_situation.items()
        if item.get("is_opener")
    ]
    if isinstance(collected.get("context"), dict):
        collected["context"]["opener_situation"] = opener_situation

    home_team_adjustment = _team_fatigue_overall_adjustment(home_fatigue)
    away_team_adjustment = _team_fatigue_overall_adjustment(away_fatigue)
    home_strength = clamp(_team_strength(home_team) + home_team_adjustment, 0.05, 0.95)
    away_strength = clamp(_team_strength(away_team) + away_team_adjustment, 0.05, 0.95)
    log5_home = log5_probability(home_strength, away_strength)

    # New signals: umpire, travel, BvP, rolling xstats
    umpire_ctx = collected.get("umpire_context")
    umpire_adj = umpire_adjustment(umpire_ctx)

    home_travel_ctx = collected.get("home_travel_context")
    away_travel_ctx = collected.get("away_travel_context")
    home_travel_adj = travel_fatigue_adjustment(home_travel_ctx)
    away_travel_adj = travel_fatigue_adjustment(away_travel_ctx)

    home_bvp = collected.get("home_bvp")
    away_bvp = collected.get("away_bvp")
    home_bvp_adj = bvp_adjustment(home_bvp)
    away_bvp_adj = bvp_adjustment(away_bvp)

    home_xstats = collected.get("home_rolling_xstats")
    away_xstats = collected.get("away_rolling_xstats")
    home_xstats_adj = xstats_offense_adjustment(home_xstats)
    away_xstats_adj = xstats_offense_adjustment(away_xstats)

    # Lineup depth analysis
    home_lineup_data = collected.get("home_lineup")
    away_lineup_data = collected.get("away_lineup")
    home_lineup_depth = _build_lineup_depth(home_lineup_data)
    away_lineup_depth = _build_lineup_depth(away_lineup_data)

    components = {
        "team_strength": (log5_home - 0.5) * 5.0,
        "starting_pitcher": _enhanced_pitcher_feature(
            home_pitcher,
            away_lineup_data,
            home_pitcher_rest_days,
            opener_situation["home"],
        )
        - _enhanced_pitcher_feature(
            away_pitcher,
            home_lineup_data,
            away_pitcher_rest_days,
            opener_situation["away"],
        ),
        "offense": _offense_feature(home_team, home_fatigue) - _offense_feature(away_team, away_fatigue),
        "bullpen": _bullpen_feature(home_team) - _bullpen_feature(away_team),
        "recent_form": _recent_feature(home_team) - _recent_feature(away_team),
        "home_field": home_field_adjustment(True),
    }

    return {
        "home_strength": home_strength,
        "away_strength": away_strength,
        "log5_home": log5_home,
        "components": components,
        "pitcher_rest_adjustment": {
            "home": {
                "pitcher": home_pitcher.pitcher if home_pitcher else None,
                "rest_days": home_pitcher_rest_days,
                "multiplier": _pitcher_rest_multiplier(home_pitcher_rest_days)
                if home_pitcher_rest_days is not None
                else 1.0,
            },
            "away": {
                "pitcher": away_pitcher.pitcher if away_pitcher else None,
                "rest_days": away_pitcher_rest_days,
                "multiplier": _pitcher_rest_multiplier(away_pitcher_rest_days)
                if away_pitcher_rest_days is not None
                else 1.0,
            },
        },
        "team_fatigue_adjustment": {
            "home": {
                **home_fatigue,
                "team": home_team.team,
                "offense_adjustment": _team_fatigue_offense_adjustment(home_fatigue),
                "team_adjustment": home_team_adjustment,
            },
            "away": {
                **away_fatigue,
                "team": away_team.team,
                "offense_adjustment": _team_fatigue_offense_adjustment(away_fatigue),
                "team_adjustment": away_team_adjustment,
            },
        },
        "market_implied_probability": {
            "home": _market_probability(market.get("home_moneyline")),
            "away": _market_probability(market.get("away_moneyline")),
        },
        "opener_flag": opener_flag,
        "opener_situation": opener_situation,
        "notes": opener_notes,
        "signal_priority": SIGNAL_PRIORITY,
        "umpire_adjustment": umpire_adj,
        "travel_fatigue": {
            "home": home_travel_adj,
            "away": away_travel_adj,
        },
        "bvp_adjustment": {
            "home": home_bvp_adj,
            "away": away_bvp_adj,
        },
        "rolling_xstats_adjustment": {
            "home": home_xstats_adj,
            "away": away_xstats_adj,
        },
        "lineup_depth": {
            "home": home_lineup_depth,
            "away": away_lineup_depth,
        },
    }


def build_total_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean total-runs model features from raw game data."""
    context = collected["total_context"]
    home_team = collected["home_team"]
    away_team = collected["away_team"]

    umpire_ctx = collected.get("umpire_context")
    umpire_adj = umpire_adjustment(umpire_ctx)

    home_travel_ctx = collected.get("home_travel_context")
    away_travel_ctx = collected.get("away_travel_context")
    home_travel_adj = travel_fatigue_adjustment(home_travel_ctx)
    away_travel_adj = travel_fatigue_adjustment(away_travel_ctx)

    home_xstats = collected.get("home_rolling_xstats")
    away_xstats = collected.get("away_rolling_xstats")
    home_xstats_adj = xstats_offense_adjustment(home_xstats)
    away_xstats_adj = xstats_offense_adjustment(away_xstats)

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
        "umpire_adjustment": umpire_adj,
        "travel_fatigue": {
            "home": home_travel_adj,
            "away": away_travel_adj,
        },
        "rolling_xstats_adjustment": {
            "home": home_xstats_adj,
            "away": away_xstats_adj,
        },
    }


def build_game_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Build all deterministic features for one game."""
    return {
        "moneyline": build_moneyline_features(collected),
        "totals": build_total_features(collected),
        "signal_priority": SIGNAL_PRIORITY,
    }
