"""Sabermetric feature functions for MLB game prediction."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
import re
from statistics import mean
from typing import Any

from .utils import clamp, safe_float, safe_int


OPENER_NOTE_RE = re.compile(r"\b(opener|bulk|piggyback)\b|opener\s*/\s*bulk", re.IGNORECASE)
OPENER_NOTE_KEYS = {
    "note",
    "notes",
    "description",
    "game_note",
    "game_notes",
    "gamenote",
    "gamenotes",
    "probable_pitcher_note",
    "probable_pitcher_notes",
    "probablepitchernote",
    "probablepitchernotes",
    "summary",
    "role",
    "pitcher_role",
    "pitcherrole",
    "type",
}
START_KEYS = {
    "gs",
    "starts",
    "gamesstarted",
    "games_started",
    "careerstarts",
    "career_starts",
    "careergamesstarted",
    "career_games_started",
}
APPEARANCE_KEYS = {
    "g",
    "games",
    "appearances",
    "gamespitched",
    "games_pitched",
    "careerappearances",
    "career_appearances",
    "careergames",
    "career_games",
    "careergamespitched",
    "career_games_pitched",
}


def pythagorean_win_pct(
    runs_scored: float | int | str | None,
    runs_allowed: float | int | str | None,
    exponent: float = 1.83,
) -> float:
    """Estimate team strength from runs scored and allowed.

    Formula: RS^exponent / (RS^exponent + RA^exponent).
    """
    rs = max(0.0, safe_float(runs_scored, 0.0))
    ra = max(0.0, safe_float(runs_allowed, 0.0))
    if rs == 0 and ra == 0:
        return 0.5

    rs_power = rs**exponent
    ra_power = ra**exponent
    denominator = rs_power + ra_power
    if denominator <= 0:
        return 0.5
    return clamp(rs_power / denominator, 0.0, 1.0)


def log5_probability(p_a: float, p_b: float) -> float:
    """Calculate Bill James Log5 probability for Team A beating Team B."""
    a = clamp(safe_float(p_a, 0.5), 0.001, 0.999)
    b = clamp(safe_float(p_b, 0.5), 0.001, 0.999)
    denominator = a + b - 2 * a * b
    if abs(denominator) < 1e-9:
        return 0.5
    return clamp((a - a * b) / denominator, 0.0, 1.0)


def normalize_stat(
    value: float | int | str | None,
    league_avg: float,
    higher_is_better: bool = True,
) -> float:
    """Normalize a stat around league average into an approximate -1..1 score."""
    parsed = safe_float(value, league_avg)
    average = max(abs(safe_float(league_avg, 1.0)), 1e-9)
    if parsed <= 0 and not higher_is_better:
        return 0.0

    ratio = parsed / average if higher_is_better else average / max(parsed, 1e-9)
    return clamp((ratio - 1.0) * 2.0, -1.0, 1.0)


def _average_available(values: list[float]) -> float:
    usable = [value for value in values if value is not None]
    return mean(usable) if usable else 0.0


def _as_mapping(item: Any) -> dict[str, Any]:
    if item is None:
        return {}
    if isinstance(item, dict):
        return item
    if is_dataclass(item):
        return asdict(item)
    return {
        key: getattr(item, key)
        for key in dir(item)
        if not key.startswith("_") and not callable(getattr(item, key, None))
    }


def _first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def _normalized_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _walk_values(value: Any) -> list[tuple[str, Any]]:
    if isinstance(value, dict):
        items: list[tuple[str, Any]] = []
        for key, nested in value.items():
            items.append((str(key), nested))
            items.extend(_walk_values(nested))
        return items
    if isinstance(value, (list, tuple, set)):
        items = []
        for nested in value:
            items.extend(_walk_values(nested))
        return items
    return []


def _note_text(probable_pitcher_data: dict[str, Any]) -> str:
    strings: list[str] = []
    for key, value in _walk_values(probable_pitcher_data):
        if _normalized_key(key) not in OPENER_NOTE_KEYS:
            continue
        if isinstance(value, str):
            strings.append(value)
        elif isinstance(value, (list, tuple, set)):
            strings.extend(str(item) for item in value if item not in (None, ""))

    return " ".join(strings)


def _first_numeric_by_key(probable_pitcher_data: dict[str, Any], keys: set[str]) -> float | None:
    for key, value in _walk_values(probable_pitcher_data):
        if _normalized_key(key) not in keys:
            continue
        parsed = safe_float(value, -1.0)
        if parsed >= 0:
            return parsed
    return None


def _career_start_ratio(probable_pitcher_data: dict[str, Any]) -> float | None:
    starts = _first_numeric_by_key(probable_pitcher_data, START_KEYS)
    appearances = _first_numeric_by_key(probable_pitcher_data, APPEARANCE_KEYS)
    if starts is None or appearances is None or appearances <= 0:
        return None
    return clamp(starts / appearances, 0.0, 1.0)


def _role_from_text(text: str) -> str:
    lowered = text.lower()
    if "bulk" in lowered and "opener" not in lowered:
        return "bulk"
    if "opener" in lowered or "piggyback" in lowered or "bulk" in lowered:
        return "opener"
    return "starter"


def detect_opener_situation(
    game_pk: str | int | None,
    probable_pitcher_data: Any,
) -> dict[str, Any]:
    """Detect opener/bulk uncertainty from StatsAPI notes and pitcher usage history.

    The detector is conservative: explicit notes or role labels are the strongest
    signal, while low career start share is a medium-confidence fallback.
    """
    data = _as_mapping(probable_pitcher_data)
    if not data:
        return {
            "is_opener": False,
            "pitcher_role": "starter",
            "confidence": "low",
            "game_pk": game_pk,
        }

    text = _note_text(data)
    note_match = OPENER_NOTE_RE.search(text or "")
    start_ratio = _career_start_ratio(data)
    low_start_share = start_ratio is not None and start_ratio < 0.30
    enough_history = safe_float(_first_numeric_by_key(data, APPEARANCE_KEYS), 0.0) >= 10
    explicit_role = _role_from_text(text)

    if note_match:
        confidence = "high" if low_start_share or explicit_role in {"opener", "bulk"} else "medium"
        return {
            "is_opener": True,
            "pitcher_role": explicit_role,
            "confidence": confidence,
            "game_pk": game_pk,
            "career_gs_pct": round(start_ratio, 3) if start_ratio is not None else None,
            "note": text.strip(),
        }

    if low_start_share and enough_history:
        return {
            "is_opener": True,
            "pitcher_role": "opener",
            "confidence": "medium",
            "game_pk": game_pk,
            "career_gs_pct": round(start_ratio, 3),
            "note": "Career GS% below opener threshold.",
        }

    return {
        "is_opener": False,
        "pitcher_role": "starter",
        "confidence": "low",
        "game_pk": game_pk,
        "career_gs_pct": round(start_ratio, 3) if start_ratio is not None else None,
    }


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value in (None, ""):
        return None

    text = str(value).strip()
    if not text:
        return None

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def _game_date(game: Any) -> date | None:
    row = _as_mapping(game)
    return _parse_date(
        _first_present(row, "date", "game_date", "gameDate", "officialDate", "start_date")
    )


def _normalize_id(value: Any) -> str:
    return str(value).strip().lower()


def _id_matches(left: Any, right: Any) -> bool:
    if left in (None, "") or right in (None, ""):
        return False
    return _normalize_id(left) == _normalize_id(right)


def _nested_team(game: dict[str, Any], side: str) -> dict[str, Any]:
    team_entry = (game.get("teams") or {}).get(side) or {}
    team = team_entry.get("team") if isinstance(team_entry, dict) else None
    return team or team_entry if isinstance(team_entry, dict) else {}


def _pitcher_appeared(game: Any, pitcher_id: Any) -> bool:
    row = _as_mapping(game)
    direct_fields = (
        "pitcher_id",
        "player_id",
        "person_id",
        "starter_id",
        "probable_pitcher_id",
        "home_pitcher",
        "away_pitcher",
        "pitcher",
    )
    if any(_id_matches(row.get(field), pitcher_id) for field in direct_fields):
        return True

    for field in ("pitcher_ids", "pitchers", "player_ids", "appearance_pitcher_ids"):
        values = row.get(field)
        if isinstance(values, (list, tuple, set)) and any(_id_matches(value, pitcher_id) for value in values):
            return True

    teams = row.get("teams") or {}
    if isinstance(teams, dict):
        for side in ("away", "home"):
            side_row = teams.get(side) or {}
            pitcher = side_row.get("probablePitcher") or side_row.get("probable_pitcher") or {}
            if isinstance(pitcher, dict) and (
                _id_matches(pitcher.get("id"), pitcher_id)
                or _id_matches(pitcher.get("fullName"), pitcher_id)
                or _id_matches(pitcher.get("name"), pitcher_id)
            ):
                return True
    return False


def _team_side(game: Any, team_id: Any) -> str | None:
    row = _as_mapping(game)
    home_id = _first_present(row, "home_team_id", "home_id", "home_team")
    away_id = _first_present(row, "away_team_id", "away_id", "away_team")

    if _id_matches(home_id, team_id):
        return "home"
    if _id_matches(away_id, team_id):
        return "away"

    teams = row.get("teams") or {}
    if isinstance(teams, dict):
        for side in ("home", "away"):
            team = _nested_team(row, side)
            if (
                _id_matches(team.get("id"), team_id)
                or _id_matches(team.get("name"), team_id)
                or _id_matches(team.get("abbreviation"), team_id)
            ):
                return side
    return None


def _pitcher_rest_multiplier(rest_days: int) -> float:
    if rest_days <= 3:
        return 0.85
    if rest_days >= 6:
        return 0.93
    return 1.0


def get_pitcher_rest_days(
    pitcher_id: str | int,
    game_date: str | date | datetime,
    schedule_data: list[Any] | tuple[Any, ...] | None,
) -> int:
    """Return days since a pitcher's last appearance before the target game.

    Missing schedule history returns 5, which represents normal rest and avoids
    applying an unsupported fatigue or rust penalty.
    """
    target_date = _parse_date(game_date)
    if target_date is None or not schedule_data:
        return 5

    prior_appearances = [
        previous_date
        for game in schedule_data
        if (previous_date := _game_date(game)) is not None
        and previous_date < target_date
        and _pitcher_appeared(game, pitcher_id)
    ]
    if not prior_appearances:
        return 5

    rest_days = max(0, (target_date - max(prior_appearances)).days - 1)
    return rest_days if rest_days <= 30 else 5


def get_team_schedule_fatigue(
    team_id: str | int,
    game_date: str | date | datetime,
    schedule_data: list[Any] | tuple[Any, ...] | None,
) -> dict[str, Any]:
    """Summarize team schedule fatigue from games before the target date."""
    target_date = _parse_date(game_date)
    if target_date is None or not schedule_data:
        return {
            "rest_days": 1,
            "road_streak": 0,
            "recent_game_count": 0,
            "fatigue_level": "low",
            "doubleheader_last_3_days": False,
        }

    team_games: list[tuple[date, str]] = []
    for game in schedule_data:
        played_date = _game_date(game)
        if played_date is None or played_date >= target_date:
            continue
        side = _team_side(game, team_id)
        if side:
            team_games.append((played_date, side))

    if not team_games:
        return {
            "rest_days": 1,
            "road_streak": 0,
            "recent_game_count": 0,
            "fatigue_level": "low",
            "doubleheader_last_3_days": False,
        }

    team_games.sort(key=lambda item: item[0], reverse=True)
    last_game_date = team_games[0][0]
    recent_games = [(played_date, side) for played_date, side in team_games if 0 < (target_date - played_date).days <= 10]
    rest_days = max(0, (target_date - last_game_date).days - 1)
    if not recent_games:
        rest_days = min(rest_days, 10)
    last_three_dates = [
        played_date
        for played_date, _ in team_games
        if 0 < (target_date - played_date).days <= 3
    ]
    doubleheader_last_3_days = any(count >= 2 for count in Counter(last_three_dates).values())

    road_streak = 0
    for _, side in recent_games:
        if side != "away":
            break
        road_streak += 1

    fatigue_points = 0
    if len(recent_games) >= 9:
        fatigue_points += 2
    elif len(recent_games) >= 7:
        fatigue_points += 1
    if doubleheader_last_3_days:
        fatigue_points += 1
    if road_streak >= 7:
        fatigue_points += 2
    elif road_streak >= 4:
        fatigue_points += 1
    if rest_days == 0:
        fatigue_points += 1

    fatigue_level = "high" if fatigue_points >= 3 else "medium" if fatigue_points >= 1 else "low"
    return {
        "rest_days": rest_days,
        "road_streak": road_streak,
        "recent_game_count": len(recent_games),
        "fatigue_level": fatigue_level,
        "doubleheader_last_3_days": doubleheader_last_3_days,
    }


def pitcher_score(
    era: float | int | str | None,
    whip: float | int | str | None,
    fip: float | int | str | None = None,
    k_bb_ratio: float | int | str | None = None,
) -> float:
    """Score starting pitcher strength using run prevention and command."""
    scores = [
        normalize_stat(era, 4.20, higher_is_better=False),
        normalize_stat(whip, 1.30, higher_is_better=False),
    ]
    if fip is not None:
        scores.append(normalize_stat(fip, 4.20, higher_is_better=False))
    if k_bb_ratio is not None:
        scores.append(normalize_stat(k_bb_ratio, 2.70, higher_is_better=True))
    return clamp(_average_available(scores), -1.0, 1.0)


def offense_score(
    ops: float | int | str | None = None,
    wrc_plus: float | int | str | None = None,
    runs_per_game: float | int | str | None = None,
) -> float:
    """Score offense with OPS, wRC+, and runs per game when available."""
    scores: list[float] = []
    if ops is not None:
        scores.append(normalize_stat(ops, 0.720, higher_is_better=True))
    if wrc_plus is not None:
        scores.append(normalize_stat(wrc_plus, 100.0, higher_is_better=True))
    if runs_per_game is not None:
        scores.append(normalize_stat(runs_per_game, 4.40, higher_is_better=True))
    return clamp(_average_available(scores), -1.0, 1.0)


def bullpen_score(
    bullpen_era: float | int | str | None = None,
    bullpen_whip: float | int | str | None = None,
    recent_usage: float | int | str | None = None,
) -> float:
    """Score bullpen quality, penalizing tired or heavily used bullpens."""
    scores: list[float] = []
    if bullpen_era is not None:
        scores.append(normalize_stat(bullpen_era, 4.10, higher_is_better=False))
    if bullpen_whip is not None:
        scores.append(normalize_stat(bullpen_whip, 1.30, higher_is_better=False))
    if recent_usage is not None:
        scores.append(normalize_stat(recent_usage, 0.50, higher_is_better=False))
    return clamp(_average_available(scores), -1.0, 1.0)


def recent_form_score(
    wins_last_n: int | str | None,
    games_n: int | str | None,
    run_diff_last_n: float | int | str | None,
) -> float:
    """Score recent form from recent win rate and run differential."""
    games = max(0, safe_int(games_n, 0))
    if games == 0:
        return 0.0

    wins = clamp(safe_int(wins_last_n, 0), 0, games)
    win_rate_score = (wins / games - 0.5) * 2.0
    run_diff_per_game = safe_float(run_diff_last_n, 0.0) / games
    run_diff_score = clamp(run_diff_per_game / 2.5, -1.0, 1.0)
    return clamp(win_rate_score * 0.6 + run_diff_score * 0.4, -1.0, 1.0)


def home_field_adjustment(home_team: bool = True) -> float:
    """Return a normalized home-field feature used by the weighted model."""
    return 1.0 if home_team else 0.0


def matchup_difficulty(
    opponent_win_pct: float,
    opponent_runs_per_game: float,
    opponent_ops: float,
    opponent_wrc_plus: float,
    opponent_pitcher_era: float,
    opponent_pitcher_fip: float,
) -> float:
    """Rate how tough the opponent is on a 0-1 scale (1 = hardest).

    Combines opponent overall strength, offensive firepower, and starting
    pitcher quality so downstream models can weight or flag difficult
    matchups before making predictions.
    """
    # Opponent overall strength: win% vs league .500
    strength_component = clamp((opponent_win_pct - 0.500) * 2.0, -1.0, 1.0)

    # Offense component: league-avg OPS ~.720, wRC+ ~100
    offense_component = clamp(
        (opponent_ops - 0.720) * 3.0 + (opponent_wrc_plus - 100.0) * 0.02,
        -1.0,
        1.0,
    )

    # Pitcher component: lower ERA/FIP = harder matchup for your offense
    # League avg ERA ~4.20 — lower means tougher
    pitcher_component = clamp(
        (4.20 - opponent_pitcher_era) * 0.25 + (4.20 - opponent_pitcher_fip) * 0.20,
        -1.0,
        1.0,
    )

    # Weighted composite mapped to 0-1 scale
    raw = (
        strength_component * 0.35
        + offense_component * 0.35
        + pitcher_component * 0.30
    )
    return clamp((raw + 1.0) / 2.0, 0.0, 1.0)


def expected_length_of_start(
    pitcher_era: float,
    innings_per_start: float,
    pitch_count_last_start: float,
    pitch_count_avg: float,
    days_rest: int,
    batters_faced_third_time_pct: float,
    season_ip: float,
) -> float:
    """Estimate how many innings the starter will pitch (4.0-7.5 range).

    Uses workload trends, pitch count patterns, rest days, and third-time-
    through-order penalty to project starter length — critical for
    estimating bullpen workload and total-runs projections.
    """
    # Base expectation from season average
    base_ip = clamp(innings_per_start, 3.0, 7.5)

    # Recent workload: high last-start pitch count → manager may pull earlier
    pitch_ratio = pitch_count_last_start / max(pitch_count_avg, 1.0)
    workload_adj = 0.0
    if pitch_ratio > 1.10:
        workload_adj = -0.3  # overworked last start
    elif pitch_ratio < 0.85:
        workload_adj = 0.1  # short outing last time, likely stretched

    # Rest day adjustment
    rest_adj = 0.0
    if days_rest <= 3:
        rest_adj = -0.3  # short rest, likely shorter outing
    elif days_rest >= 6:
        rest_adj = -0.1  # extra rest may mean slightly shorter

    # Third-time-through penalty: if pitcher gets hit hard 3rd time through
    tto_adj = 0.0
    if batters_faced_third_time_pct > 0.15:
        tto_adj = -0.2 * min(batters_faced_third_time_pct, 0.30)

    # ERA-based quality: better pitchers get longer leash
    era_adj = clamp((4.20 - pitcher_era) * 0.15, -0.3, 0.4)

    # Season workload: high-IP arms get longer leash
    workload_bonus = clamp((season_ip - 50.0) * 0.003, -0.2, 0.3)

    projected = base_ip + workload_adj + rest_adj + tto_adj + era_adj + workload_bonus
    return clamp(projected, 3.0, 7.5)


def lineup_impact_score(
    lineup_status: str,
    missing_star_hitters: int = 0,
    top5_wrc_plus: float = 100.0,
    platoon_advantage: float = 0.0,
    lineup_order_wrc_plus: list[float] | None = None,
) -> dict[str, Any]:
    """Quantify the offensive impact of a lineup's quality and missing bats.

    Replaces the simple confirmed/projected boolean with a continuous
    score that reflects how much lineup uncertainty affects run creation.

    Returns:
    - impact_score: 0-1 (1 = elite full-strength lineup)
    - missing_penalty: how many runs of impact from missing hitters
    - top_heavy_factor: how much the top of the order carries the offense
    - platoon_edge: handedness advantage value
    - lineup_confirmed: whether the lineup is officially posted
    """
    confirmed = lineup_status.lower() in {"confirmed", "available"}

    # Base quality from top-5 wRC+
    base_quality = clamp((top5_wrc_plus - 80.0) / 60.0, 0.0, 1.0)

    # Missing star penalty: each missing top bat hurts significantly
    # Scale: 0 = no missing, 1-2 = moderate, 3+ = severe
    missing_penalty = 0.0
    if missing_star_hitters > 0:
        missing_penalty = min(missing_star_hitters * 0.08, 0.30)

    # Top-heavy factor: if lineup_order_wrc_plus is provided,
    # calculate how much the top 3 spots carry the offense
    top_heavy_factor = 0.5  # default: balanced
    if lineup_order_wrc_plus and len(lineup_order_wrc_plus) >= 4:
        top3_avg = mean(lineup_order_wrc_plus[:3])
        bottom_avg = mean(lineup_order_wrc_plus[3:])
        if bottom_avg > 0:
            ratio = top3_avg / max(bottom_avg, 1.0)
            top_heavy_factor = clamp(ratio / 2.5, 0.2, 1.0)

    # Platoon advantage
    platoon_edge = clamp(platoon_advantage, -1.0, 1.0) * 0.12

    # Confirmation penalty
    confirmation_adj = 0.0 if confirmed else -0.05

    # Composite impact score
    raw = base_quality - missing_penalty + platoon_edge + confirmation_adj
    impact_score = clamp(raw, 0.1, 1.0)

    return {
        "impact_score": round(impact_score, 3),
        "missing_penalty": round(missing_penalty, 3),
        "top_heavy_factor": round(top_heavy_factor, 3),
        "platoon_edge": round(platoon_edge, 3),
        "lineup_confirmed": confirmed,
        "missing_star_hitters": missing_star_hitters,
    }
