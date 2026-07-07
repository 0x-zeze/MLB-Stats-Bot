"""Backtest segment definitions and filtering."""

from __future__ import annotations

from typing import Any

from .utils import safe_float


SEGMENTS = {
    "venue": ["home", "away"],
    "role": ["favorite", "underdog"],
    "time": ["day", "night"],
    "division": [
        "AL_East", "AL_Central", "AL_West",
        "NL_East", "NL_Central", "NL_West",
    ],
    "total_range": ["low_6_7", "mid_8_9", "high_10_plus"],
    "confidence": ["low", "medium", "high"],
    "edge_size": ["small_2_4", "medium_4_7", "large_7_plus"],
    "pitcher_type": ["ace", "solid", "average", "weak", "opener"],
    "rest_days": ["short_rest", "normal_rest", "extra_rest"],
    "rivalry": ["divisional", "non_divisional"],
    "clv_bucket": ["strong_clv", "neutral_clv", "weak_clv"],
}

DIVISION_TEAMS = {
    "AL_East": {"NYY", "BOS", "TB", "TOR", "BAL"},
    "AL_Central": {"CLE", "MIN", "CWS", "DET", "KC"},
    "AL_West": {"HOU", "SEA", "TEX", "LAA", "OAK"},
    "NL_East": {"ATL", "PHI", "NYM", "MIA", "WSH"},
    "NL_Central": {"MIL", "CHC", "STL", "PIT", "CIN"},
    "NL_West": {"LAD", "SD", "SF", "ARI", "COL"},
}


def _get_division(team: str) -> str:
    team_upper = team.upper().strip()
    for division, teams in DIVISION_TEAMS.items():
        if team_upper in teams:
            return division
    return "unknown"


def tag_game_segments(game: dict[str, Any]) -> dict[str, str]:
    """Return segment tags for a single game prediction."""
    tags: dict[str, str] = {}

    pick = str(game.get("predicted_winner", game.get("pick", ""))).strip()
    home = str(game.get("home_team", "")).strip()
    away = str(game.get("away_team", "")).strip()

    if pick and home and pick.upper() == home.upper():
        tags["venue"] = "home"
    elif pick and away and pick.upper() == away.upper():
        tags["venue"] = "away"
    else:
        tags["venue"] = "unknown"

    prob = safe_float(game.get("win_probability", game.get("home_win_probability")), 0.5)
    market_implied = safe_float(game.get("market_implied_probability"), None)
    if market_implied is not None:
        tags["role"] = "favorite" if prob >= 0.5 else "underdog"
    else:
        tags["role"] = "favorite" if prob >= 0.55 else "underdog"

    game_time = str(game.get("game_time", game.get("start_time", ""))).strip()
    if game_time:
        try:
            hour = int(game_time.split("T")[1][:2]) if "T" in game_time else int(game_time.split(":")[0])
            tags["time"] = "day" if hour < 17 else "night"
        except (ValueError, IndexError):
            tags["time"] = "unknown"
    else:
        tags["time"] = "unknown"

    if home:
        tags["division"] = _get_division(home)

    market_total = safe_float(game.get("market_total"), None)
    if market_total is not None:
        if market_total <= 7.5:
            tags["total_range"] = "low_6_7"
        elif market_total <= 9.5:
            tags["total_range"] = "mid_8_9"
        else:
            tags["total_range"] = "high_10_plus"
    else:
        tags["total_range"] = "unknown"

    confidence = str(game.get("confidence", "")).lower()
    if confidence in ("low", "medium", "high"):
        tags["confidence"] = confidence
    else:
        tags["confidence"] = "unknown"

    edge = abs(safe_float(game.get("model_edge", 0), 0))
    if edge >= 0.07:
        tags["edge_size"] = "large_7_plus"
    elif edge >= 0.04:
        tags["edge_size"] = "medium_4_7"
    else:
        tags["edge_size"] = "small_2_4"

    # Pitcher type classification from ERA
    pick_era = safe_float(game.get("pick_pitcher_era"), None)
    if pick_era is not None:
        if pick_era <= 3.00:
            tags["pitcher_type"] = "ace"
        elif pick_era <= 3.75:
            tags["pitcher_type"] = "solid"
        elif pick_era <= 4.50:
            tags["pitcher_type"] = "average"
        elif pick_era <= 5.50:
            tags["pitcher_type"] = "weak"
        else:
            tags["pitcher_type"] = "opener"
    else:
        tags["pitcher_type"] = "unknown"

    # Rest days
    rest = safe_float(game.get("pitcher_rest_days"), None)
    if rest is not None:
        if rest <= 3:
            tags["rest_days"] = "short_rest"
        elif rest >= 6:
            tags["rest_days"] = "extra_rest"
        else:
            tags["rest_days"] = "normal_rest"
    else:
        tags["rest_days"] = "unknown"

    # Divisional rivalry
    if home and away:
        pick_team = pick if pick else home
        tags["rivalry"] = "divisional" if _get_division(pick_team) == _get_division(
            away if pick.upper() == home.upper() else home
        ) else "non_divisional"
    else:
        tags["rivalry"] = "unknown"

    # CLV bucket
    clv = safe_float(game.get("closing_line_value"), None)
    if clv is not None:
        if clv >= 2.0:
            tags["clv_bucket"] = "strong_clv"
        elif clv <= -2.0:
            tags["clv_bucket"] = "weak_clv"
        else:
            tags["clv_bucket"] = "neutral_clv"
    else:
        tags["clv_bucket"] = "unknown"

    return tags


def filter_by_segment(
    results: list[dict[str, Any]],
    segment_key: str,
    segment_value: str,
) -> list[dict[str, Any]]:
    """Filter backtest results by segment."""
    return [
        r for r in results
        if r.get("segments", {}).get(segment_key) == segment_value
    ]


def segment_summary(
    results: list[dict[str, Any]],
    segment_key: str,
) -> dict[str, dict[str, Any]]:
    """Compute summary stats per segment value."""
    values = SEGMENTS.get(segment_key, [])
    summary: dict[str, dict[str, Any]] = {}

    for value in values:
        filtered = filter_by_segment(results, segment_key, value)
        if not filtered:
            continue

        wins = sum(1 for r in filtered if r.get("result") == "win")
        losses = sum(1 for r in filtered if r.get("result") == "loss")
        total = wins + losses
        profit = sum(safe_float(r.get("profit_loss", 0), 0) for r in filtered)

        summary[value] = {
            "games": len(filtered),
            "wins": wins,
            "losses": losses,
            "win_rate": wins / max(total, 1),
            "total_profit_loss": round(profit, 2),
            "roi": round(profit / max(total, 1), 4),
        }

    return summary
