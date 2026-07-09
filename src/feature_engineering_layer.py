"""Feature engineering layer for the MLB prediction pipeline.

This module converts raw collected data into clean deterministic features.
It does not make picks, compare markets, run quality control, or explain.
"""

from __future__ import annotations

import logging
from typing import Any

from .batter_vs_pitcher import aggregate_bvp_for_lineup, bvp_adjustment
from .bullpen import bullpen_fatigue_adjustment, bullpen_fatigue_score
from .features import (
    bullpen_score,
    detect_opener_situation,
    get_pitcher_rest_days,
    get_team_schedule_fatigue,
    home_field_adjustment,
    log5_probability,
    offense_score,
    pitcher_score,
    pitcher_score_with_xfip,
    pythagorean_win_pct,
    recent_form_score,
    rolling_pythagorean_win_pct,
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


logger = logging.getLogger("mlb.feature_engineering")


class FallbackTracker:
    """Records every feature that fell back to a generic/default value.

    The tracker does NOT change any default value. It only makes fallbacks
    visible so the data-quality layer and storage can record them and later
    analysis can compare clean picks vs. picks built on defaults.
    """

    def __init__(self, game_pk: Any = None) -> None:
        self.game_pk = game_pk
        # feature name -> list of {reason, default, exception}
        self.events: list[dict[str, Any]] = []

    def record(
        self,
        function: str,
        feature: str,
        default: Any,
        *,
        exception: BaseException | None = None,
        reason: str | None = None,
    ) -> None:
        exc_message = None
        if exception is not None:
            exc_message = f"{type(exception).__name__}: {exception}"
        event = {
            "function": function,
            "feature": feature,
            "default": default,
            "reason": reason or (exc_message if exc_message else "value_missing"),
            "exception": exc_message,
        }
        self.events.append(event)
        logger.warning(
            "[feature-fallback] game_pk=%s fn=%s feature=%s default=%s reason=%s",
            self.game_pk,
            function,
            feature,
            default,
            event["reason"],
        )

    @property
    def count(self) -> int:
        return len(self.events)

    def features_used(self) -> list[str]:
        # Preserve order, de-duplicated.
        seen: dict[str, None] = {}
        for event in self.events:
            seen.setdefault(event["feature"], None)
        return list(seen.keys())

    def summary(self) -> dict[str, Any]:
        return {
            "game_pk": self.game_pk,
            "count": self.count,
            "features": self.features_used(),
            "events": self.events,
        }


# No-op sentinel so callers that don't care about tracking can pass nothing.
class _NullTracker(FallbackTracker):
    def record(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover - trivial
        pass


def _tracker(tracker: FallbackTracker | None, game_pk: Any = None) -> FallbackTracker:
    if tracker is not None:
        if game_pk is not None and tracker.game_pk is None:
            tracker.game_pk = game_pk
        return tracker
    return _NullTracker(game_pk)


SIGNAL_PRIORITY = {
    "tier_1": [
        "probable_pitchers",
        "team_offense",
        "bullpen_usage",
        "park_factor",
        "market_odds",
        "platoon_splits",
    ],
    "tier_2": [
        "weather",
        "confirmed_lineup",
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


def _team_strength(team, tracker: FallbackTracker | None = None, side: str = "") -> float:
    # Use rolling 15-game Pythagorean when recent data available.
    try:
        recent_rs = safe_float(
            getattr(team, "runs_scored_last_15", None)
            if getattr(team, "runs_scored_last_15", None) is not None
            else getattr(team, "recent_runs_scored", None),
            None,
        )
        recent_ra = safe_float(
            getattr(team, "runs_allowed_last_15", None)
            if getattr(team, "runs_allowed_last_15", None) is not None
            else getattr(team, "recent_runs_allowed", None),
            None,
        )
        if (recent_rs is None or recent_ra is None) and getattr(team, "runs_last_5", 0) and getattr(team, "runs_allowed_last_5", 0):
            recent_rs = safe_float(getattr(team, "runs_last_5", 0), 0.0) * 3.0
            recent_ra = safe_float(getattr(team, "runs_allowed_last_5", 0), 0.0) * 3.0
        if recent_rs is not None and recent_ra is not None:
            pyth = rolling_pythagorean_win_pct(
                recent_rs, recent_ra,
                team.runs_scored, team.runs_allowed,
                rolling_weight=0.35,
            )
        else:
            pyth = pythagorean_win_pct(team.runs_scored, team.runs_allowed)
    except Exception as exc:
        _tracker(tracker).record(
            "_team_strength",
            f"team_strength_{side}" if side else "team_strength",
            "season_pythagorean",
            exception=exc,
        )
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
    tracker: FallbackTracker | None = None,
    side: str = "",
) -> float:
    if pitcher is None:
        return 0.0
    if opener_detection and opener_detection.get("is_opener"):
        return 0.0
    # Use xFIP-enhanced score when available
    try:
        xfip = safe_float(getattr(pitcher, "xfip", None), None)
        if xfip is not None:
            score = pitcher_score_with_xfip(
                pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio, xfip
            )
        else:
            score = pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)
    except Exception as exc:
        _tracker(tracker).record(
            "_pitcher_feature",
            f"pitcher_score_{side}" if side else "pitcher_score",
            "basic_pitcher_score",
            exception=exc,
        )
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


def build_moneyline_features(
    collected: dict[str, Any],
    tracker: FallbackTracker | None = None,
) -> dict[str, Any]:
    """Create clean moneyline model features from raw game data."""
    tracker = _tracker(tracker, _game_pk(collected.get("game")))
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
    home_strength = clamp(_team_strength(home_team, tracker, "home") + home_team_adjustment, 0.05, 0.95)
    away_strength = clamp(_team_strength(away_team, tracker, "away") + away_team_adjustment, 0.05, 0.95)
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

    # Platoon advantage — promoted to Tier 1
    try:
        home_platoon = safe_float(
            getattr(home_lineup_data, "platoon_advantage", None)
            if home_lineup_data and not isinstance(home_lineup_data, dict)
            else (home_lineup_data or {}).get("platoon_advantage"),
            0.0,
        )
        away_platoon = safe_float(
            getattr(away_lineup_data, "platoon_advantage", None)
            if away_lineup_data and not isinstance(away_lineup_data, dict)
            else (away_lineup_data or {}).get("platoon_advantage"),
            0.0,
        )
        platoon_diff = clamp(home_platoon - away_platoon, -1.0, 1.0)
    except Exception as exc:
        tracker.record("build_moneyline_features", "platoon_diff", 0.0, exception=exc)
        platoon_diff = 0.0

    try:
        home_bullpen_fatigue_score = bullpen_fatigue_score(collected.get("home_bullpen"))
        away_bullpen_fatigue_score = bullpen_fatigue_score(collected.get("away_bullpen"))
        # Higher fatigue hurts that team's bullpen; positive diff favors home.
        bullpen_fatigue_diff = clamp((away_bullpen_fatigue_score - home_bullpen_fatigue_score) / 100.0, -0.45, 0.45)
    except Exception as exc:
        tracker.record("build_moneyline_features", "bullpen_fatigue_score", 0, exception=exc)
        home_bullpen_fatigue_score = 0
        away_bullpen_fatigue_score = 0
        bullpen_fatigue_diff = 0.0

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
        "bullpen": _bullpen_feature(home_team) - _bullpen_feature(away_team) + bullpen_fatigue_diff,
        "recent_form": _recent_feature(home_team) - _recent_feature(away_team),
        "home_field": home_field_adjustment(True),
        "platoon_advantage": platoon_diff,
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
        "bullpen_fatigue_score": {
            "home": home_bullpen_fatigue_score,
            "away": away_bullpen_fatigue_score,
            "diff": bullpen_fatigue_diff,
        },
    }


def _lineup_leadoff_obp(
    lineup_data: Any,
    tracker: FallbackTracker | None = None,
    side: str = "",
) -> float:
    feature = f"leadoff_obp_{side}" if side else "leadoff_obp"
    try:
        value = _attr(lineup_data, "leadoff_obp", "leadoffObp", "leadoff_on_base_pct")
        if value is not None:
            return safe_float(value, 0.330)
        players = _attr(lineup_data, "players", "batters")
        if isinstance(players, list) and players:
            first = players[0]
            if isinstance(first, dict):
                obp = first.get("obp") or first.get("onBasePercentage")
                if obp not in (None, ""):
                    return safe_float(obp, 0.330)
    except Exception as exc:
        _tracker(tracker).record(
            "_lineup_leadoff_obp", feature, 0.330, exception=exc
        )
        return 0.330
    # Reached here => no leadoff OBP found in the data; default used.
    _tracker(tracker).record(
        "_lineup_leadoff_obp", feature, 0.330, reason="leadoff_obp_missing"
    )
    return 0.330


def _first_inning_rate(
    team: Any,
    attr: str,
    feature: str,
    tracker: FallbackTracker,
    default: float = 0.33,
) -> float:
    """Read a first-inning rate; record a fallback if it's missing/invalid."""
    raw = getattr(team, attr, None)
    if raw in (None, ""):
        tracker.record(
            "build_first_inning_features", feature, default, reason=f"{attr}_missing"
        )
        return default
    value = safe_float(raw, None)
    if value is None:
        tracker.record(
            "build_first_inning_features", feature, default, reason=f"{attr}_invalid"
        )
        return default
    return value


def build_first_inning_features(
    collected: dict[str, Any],
    tracker: FallbackTracker | None = None,
) -> dict[str, Any]:
    """Create clean YRFI/NRFI model features from raw game data."""
    tracker = _tracker(tracker, _game_pk(collected.get("game")))
    home_team = collected["home_team"]
    away_team = collected["away_team"]
    home_lineup = collected.get("home_lineup")
    away_lineup = collected.get("away_lineup")

    try:
        away_scoring = _first_inning_rate(away_team, "first_inning_scoring_rate", "away_first_inning_scoring_rate", tracker)
        home_scoring = _first_inning_rate(home_team, "first_inning_scoring_rate", "home_first_inning_scoring_rate", tracker)
        away_allowed = _first_inning_rate(away_team, "first_inning_allowed_rate", "away_first_inning_allowed_rate", tracker)
        home_allowed = _first_inning_rate(home_team, "first_inning_allowed_rate", "home_first_inning_allowed_rate", tracker)
    except Exception as exc:
        tracker.record(
            "build_first_inning_features", "first_inning_rates", 0.33, exception=exc
        )
        away_scoring = home_scoring = away_allowed = home_allowed = 0.33

    return {
        "away_first_inning_scoring_rate": away_scoring,
        "home_first_inning_scoring_rate": home_scoring,
        "away_first_inning_allowed_rate": away_allowed,
        "home_first_inning_allowed_rate": home_allowed,
        "away_leadoff_obp": _lineup_leadoff_obp(away_lineup, tracker, "away"),
        "home_leadoff_obp": _lineup_leadoff_obp(home_lineup, tracker, "home"),
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


def build_game_features(
    collected: dict[str, Any],
    tracker: FallbackTracker | None = None,
) -> dict[str, Any]:
    """Build all deterministic features for one game.

    A ``FallbackTracker`` is created (or reused) so the caller can see which
    features fell back to generic defaults. The summary is attached under the
    ``fallbacks`` key without changing any feature value.
    """
    tracker = _tracker(tracker, _game_pk(collected.get("game")))
    return {
        "moneyline": build_moneyline_features(collected, tracker),
        "first_inning": build_first_inning_features(collected, tracker),
        "signal_priority": SIGNAL_PRIORITY,
        "fallbacks": tracker.summary(),
    }
