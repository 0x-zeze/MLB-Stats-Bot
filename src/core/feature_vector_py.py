"""Python mirror of src/core/feature_vector.js (buildFeatureVector + flatten).

Canonical source of truth is the JavaScript module. This Python port exists so
offline training/parity tests can construct the SAME flattened feature vector
from frozen coreInputs without spawning a Node subprocess for every row. It is
kept in lock-step with the JS contract by the JS/Python parity tests; any
feature added to the JS module must be mirrored here or the parity test fails.

It does NOT run in production inference (JS is canonical there).
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import re
from typing import Any

FEATURE_VECTOR_SCHEMA_VERSION = "mlb-feature-vector-v1.0"
FEATURE_VECTOR_V2_SCHEMA_VERSION = "mlb-feature-vector-v2.0"
CONTROL_FEATURE_SCHEMA_VERSION = "mlb-control-features-v1.0"

FEATURE_VECTOR_V1_FEATURE_NAMES: list[str] = [
    "awayRpg", "awayOps", "homeRpg", "homeOps", "awayTeamGames", "homeTeamGames",
    "awayEra", "awayWhip", "homeEra", "homeWhip",
    "awayRollingRpg", "awayRollingOps", "homeRollingRpg", "homeRollingOps",
    "awayRollingGames", "homeRollingGames",
    "awayWinPct", "homeWinPct", "awayLastTenPct", "homeLastTenPct",
    "awayRunDiffPerGame", "homeRunDiffPerGame",
    "awayVsStarterHandPct", "homeVsStarterHandPct",
    "awayStarterEra", "awayStarterWhip", "homeStarterEra", "homeStarterWhip",
    "awayStarterKMinusBb", "homeStarterKMinusBb", "awayStarterHr9", "homeStarterHr9",
    "awayStarterRecentEra", "awayStarterRecentWhip", "awayStarterRecentInnings",
    "homeStarterRecentEra", "homeStarterRecentWhip", "homeStarterRecentInnings",
    "awayBullpenFatigue", "homeBullpenFatigue",
    "awayBullpenBackToBack", "homeBullpenBackToBack",
    "awayRestDays", "homeRestDays", "awayRoadStreak", "homeRoadStreak",
    "awayLineupConfirmed", "homeLineupConfirmed",
    "awayLineupQuality", "homeLineupQuality",
    "awayLineupCount", "homeLineupCount",
    "awayInjuryCount", "homeInjuryCount",
    "h2hGames", "h2hHomeWinPct",
    "temperature", "windSpeed", "windHittingOut", "windHittingIn",
    "awayStarterHandLeft", "homeStarterHandLeft",
]

FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES: list[str] = [
    "leadTimeMinutes",
    "gameParkRunFactor", "gameParkHrFactor",
    "awayHomeParkEffRunFactor", "homeHomeParkEffRunFactor",
    "awayParkAdjRpg", "homeParkAdjRpg",
    "awayParkAdjOps", "homeParkAdjOps",
    "awayParkAdjEra", "homeParkAdjEra",
    "awayParkAdjWhip", "homeParkAdjWhip",
    "awayLineupPlatoonOps", "homeLineupPlatoonOps",
    "awayLineupPlatoonWoba", "homeLineupPlatoonWoba",
    "awayLineupPlatoonOpsDelta", "homeLineupPlatoonOpsDelta",
    "awayLineupPlatoonWobaDelta", "homeLineupPlatoonWobaDelta",
    "awayLineupTopOrderOps", "homeLineupTopOrderOps",
    "awayStarterProjectedIp", "homeStarterProjectedIp",
    "awayStarterShare", "homeStarterShare",
    "awayBullpenReliefEra", "homeBullpenReliefEra",
    "awayBullpenReliefWhip", "homeBullpenReliefWhip",
    "awayTeamXwoba", "homeTeamXwoba",
    "awayTeamBarrelRate", "homeTeamBarrelRate",
    "awayStarterXera", "homeStarterXera",
    "awayTravelMiles", "homeTravelMiles",
    "awayTimezoneShift", "homeTimezoneShift",
    "awayTravelFatigueScore", "homeTravelFatigueScore",
    "platoonDeltaDiff", "flyballParkWindIndex",
]

FEATURE_VECTOR_V2_FEATURE_NAMES: list[str] = (
    FEATURE_VECTOR_V1_FEATURE_NAMES + FEATURE_VECTOR_V2_EXTRA_FEATURE_NAMES
)

_META_KEYS = {
    "schemaVersion", "featureSchemaVersion", "gamePk", "awayTeamId",
    "homeTeamId", "venueId", "officialDate", "featureVectorHash",
}


def _num(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return fallback
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return n


def _gp(stat: dict | None) -> float:
    if not isinstance(stat, dict):
        return 1.0
    hitting = stat.get("hitting") if isinstance(stat.get("hitting"), dict) else {}
    games = stat.get("gamesPlayed")
    if games is None:
        games = hitting.get("gamesPlayed")
    n = _num(games, 1.0)
    return max(1.0, n)


def _rpg(stat: dict | None) -> float | None:
    if not isinstance(stat, dict):
        return None
    hitting = stat.get("hitting") if isinstance(stat.get("hitting"), dict) else {}
    runs = stat.get("runs")
    if runs is None:
        runs = hitting.get("runs")
    runs = _num(runs, None)
    if runs is None:
        return None
    return runs / _gp(stat)


def _ops(stat: dict | None) -> float | None:
    if not isinstance(stat, dict):
        return None
    hitting = stat.get("hitting") if isinstance(stat.get("hitting"), dict) else {}
    val = stat.get("ops")
    if val is None:
        val = hitting.get("ops")
    return _num(val, None)


def _era(stat: dict | None) -> float | None:
    if not isinstance(stat, dict):
        return None
    pitching = stat.get("pitching") if isinstance(stat.get("pitching"), dict) else {}
    val = stat.get("era")
    if val is None:
        val = pitching.get("era")
    return _num(val, None)


def _whip(stat: dict | None) -> float | None:
    if not isinstance(stat, dict):
        return None
    pitching = stat.get("pitching") if isinstance(stat.get("pitching"), dict) else {}
    val = stat.get("whip")
    if val is None:
        val = pitching.get("whip")
    return _num(val, None)


def _record_pct(record: dict | None) -> float | None:
    if not isinstance(record, dict):
        return None
    if record.get("pct") is not None:
        return _num(record["pct"], None)
    w = _num(record.get("wins"), 0.0)
    l = _num(record.get("losses"), 0.0)
    t = w + l
    return (w / t) if t > 0 else None


def _split_pct(standing: dict | None, stype: str) -> float | None:
    if not isinstance(standing, dict):
        return None
    records = standing.get("records") if isinstance(standing.get("records"), dict) else {}
    splits = records.get("splitRecords")
    if not splits:
        return None
    rec = next((r for r in splits if isinstance(r, dict) and r.get("type") == stype), None)
    return _record_pct(rec) if rec else None


def _run_diff_per_game(standing: dict | None) -> float | None:
    if not standing:
        return None
    rd = _num(standing.get("runDifferential"), None)
    games = _num(standing.get("gamesPlayed"), None)
    if games is None and standing.get("leagueRecord"):
        games = _num(standing["leagueRecord"].get("wins"), 0.0) + _num(standing["leagueRecord"].get("losses"), 0.0)
    if rd is None or not games or games <= 0:
        return None
    return rd / games


def _games_played_record(standing: dict | None) -> float | None:
    if not standing:
        return None
    games = standing.get("gamesPlayed")
    if games is None and standing.get("leagueRecord"):
        games = _num(standing["leagueRecord"].get("wins"), 0.0) + _num(standing["leagueRecord"].get("losses"), 0.0)
    return _num(games, None)


def _with_missing(value: Any) -> dict:
    return {"value": value, "missing": 1 if value is None else 0}


def buildFeatureVector(coreInputs: dict) -> dict:
    raw = coreInputs or {}
    game = raw.get("game") or {}
    teams = game.get("teams") or {}
    away_team = (teams.get("away") or {}).get("team") or {}
    home_team = (teams.get("home") or {}).get("team") or {}
    away_id = away_team.get("id")
    home_id = home_team.get("id")

    def at(obj, idx):
        if not isinstance(obj, dict) or idx is None:
            return None
        if idx in obj:
            return obj[idx]
        return obj.get(str(idx))

    away_stats = at(raw.get("teamStats"), away_id)
    home_stats = at(raw.get("teamStats"), home_id)
    away_standing = at(raw.get("standings"), away_id)
    home_standing = at(raw.get("standings"), home_id)
    away_rolling = at(raw.get("rollingTeamStats"), away_id)
    home_rolling = at(raw.get("rollingTeamStats"), home_id)

    away_probable = (teams.get("away") or {}).get("probablePitcher") or {}
    home_probable = (teams.get("home") or {}).get("probablePitcher") or {}
    away_pitcher_id = away_probable.get("id")
    home_pitcher_id = home_probable.get("id")
    away_pitcher = at(raw.get("pitcherStats"), away_pitcher_id)
    home_pitcher = at(raw.get("pitcherStats"), home_pitcher_id)
    away_pitcher_recent = at(raw.get("pitcherRecentStarts"), away_pitcher_id)
    home_pitcher_recent = at(raw.get("pitcherRecentStarts"), home_pitcher_id)

    away_bullpen = at(raw.get("bullpenProfiles"), away_id)
    home_bullpen = at(raw.get("bullpenProfiles"), home_id)
    away_sched = at(raw.get("scheduleFatigueProfiles"), away_id)
    home_sched = at(raw.get("scheduleFatigueProfiles"), home_id)
    away_injuries = at(raw.get("injuryProfiles"), away_id)
    home_injuries = at(raw.get("injuryProfiles"), home_id)

    lineup = raw.get("lineupProfiles") or {}
    away_lineup = lineup.get("away")
    home_lineup = lineup.get("home")
    h2h = raw.get("headToHead")

    weather = game.get("weather") or {}
    temp_num = _num(weather.get("temp"), None)
    wind = weather.get("wind")
    wind_match = re.search(r"([\d.]+)\s*mph", wind, re.I) if isinstance(wind, str) else None
    wind_speed = _num(wind_match.group(1), None) if wind_match else None
    wind_out = bool(re.search(r"out|cf|lf|rf", wind, re.I)) if isinstance(wind, str) else None
    wind_in = bool(re.search(r"\bin\b", wind, re.I)) if isinstance(wind, str) else None

    away_starter_hand = (away_probable.get("pitchHand") or {}).get("code")
    home_starter_hand = (home_probable.get("pitchHand") or {}).get("code")
    h2h_games = _num(h2h.get("games"), None) if isinstance(h2h, dict) else None
    h2h_prob = _num(h2h.get("homeProbability"), None) if isinstance(h2h, dict) else None

    vector: dict[str, Any] = {
        "schemaVersion": FEATURE_VECTOR_SCHEMA_VERSION,
        "featureSchemaVersion": CONTROL_FEATURE_SCHEMA_VERSION,
        "gamePk": str(game.get("gamePk", "")),
        "awayTeamId": str(away_id) if away_id is not None else None,
        "homeTeamId": str(home_id) if home_id is not None else None,
        "venueId": _num((game.get("venue") or {}).get("id"), None) if isinstance(game.get("venue"), dict) else None,
        "officialDate": game.get("officialDate"),

        "awayRpg": _with_missing(_rpg(away_stats)),
        "awayOps": _with_missing(_ops(away_stats)),
        "homeRpg": _with_missing(_rpg(home_stats)),
        "homeOps": _with_missing(_ops(home_stats)),
        "awayTeamGames": _with_missing(_games_played_record(away_standing)),
        "homeTeamGames": _with_missing(_games_played_record(home_standing)),

        "awayEra": _with_missing(_era(away_stats)),
        "awayWhip": _with_missing(_whip(away_stats)),
        "homeEra": _with_missing(_era(home_stats)),
        "homeWhip": _with_missing(_whip(home_stats)),

        "awayRollingRpg": _with_missing(_rpg(away_rolling)),
        "awayRollingOps": _with_missing(_ops(away_rolling)),
        "homeRollingRpg": _with_missing(_rpg(home_rolling)),
        "homeRollingOps": _with_missing(_ops(home_rolling)),
        "awayRollingGames": _with_missing(_num(away_rolling.get("games"), None) if away_rolling else None),
        "homeRollingGames": _with_missing(_num(home_rolling.get("games"), None) if home_rolling else None),

        "awayWinPct": _with_missing(_record_pct(away_standing.get("leagueRecord") if away_standing else None)),
        "homeWinPct": _with_missing(_record_pct(home_standing.get("leagueRecord") if home_standing else None)),
        "awayLastTenPct": _with_missing(_split_pct(away_standing, "lastTen")),
        "homeLastTenPct": _with_missing(_split_pct(home_standing, "lastTen")),
        "awayRunDiffPerGame": _with_missing(_run_diff_per_game(away_standing)),
        "homeRunDiffPerGame": _with_missing(_run_diff_per_game(home_standing)),
        "awayVsStarterHandPct": _with_missing(
            _split_pct(away_standing, "left") if home_starter_hand == "L" else (_split_pct(away_standing, "right") if home_starter_hand == "R" else None)
        ),
        "homeVsStarterHandPct": _with_missing(
            _split_pct(home_standing, "left") if away_starter_hand == "L" else (_split_pct(home_standing, "right") if away_starter_hand == "R" else None)
        ),

        "awayStarterEra": _with_missing(_era(away_pitcher)),
        "awayStarterWhip": _with_missing(_whip(away_pitcher)),
        "homeStarterEra": _with_missing(_era(home_pitcher)),
        "homeStarterWhip": _with_missing(_whip(home_pitcher)),
        "awayStarterKMinusBb": _with_missing(_num(away_pitcher.get("strikeoutsMinusWalksPercentage"), None) if away_pitcher else None),
        "homeStarterKMinusBb": _with_missing(_num(home_pitcher.get("strikeoutsMinusWalksPercentage"), None) if home_pitcher else None),
        "awayStarterHr9": _with_missing(_num(away_pitcher.get("homeRunsPer9"), None) if away_pitcher else None),
        "homeStarterHr9": _with_missing(_num(home_pitcher.get("homeRunsPer9"), None) if home_pitcher else None),

        "awayStarterRecentEra": _with_missing(_era(away_pitcher_recent)),
        "awayStarterRecentWhip": _with_missing(_whip(away_pitcher_recent)),
        "awayStarterRecentInnings": _with_missing(_num(away_pitcher_recent.get("innings"), None) if away_pitcher_recent else None),
        "homeStarterRecentEra": _with_missing(_era(home_pitcher_recent)),
        "homeStarterRecentWhip": _with_missing(_whip(home_pitcher_recent)),
        "homeStarterRecentInnings": _with_missing(_num(home_pitcher_recent.get("innings"), None) if home_pitcher_recent else None),

        "awayBullpenFatigue": _with_missing(_num(away_bullpen.get("fatigueScore"), None) if away_bullpen else None),
        "homeBullpenFatigue": _with_missing(_num(home_bullpen.get("fatigueScore"), None) if home_bullpen else None),
        "awayBullpenBackToBack": _with_missing(_num(away_bullpen.get("backToBackRelievers"), None) if away_bullpen else None),
        "homeBullpenBackToBack": _with_missing(_num(home_bullpen.get("backToBackRelievers"), None) if home_bullpen else None),

        "awayRestDays": _with_missing(_num(away_sched.get("restDays"), None) if away_sched else None),
        "homeRestDays": _with_missing(_num(home_sched.get("restDays"), None) if home_sched else None),
        "awayRoadStreak": _with_missing(_num(away_sched.get("roadStreak"), None) if away_sched else None),
        "homeRoadStreak": _with_missing(_num(home_sched.get("roadStreak"), None) if home_sched else None),

        "awayLineupConfirmed": _with_missing(
            None if (away_lineup is None or away_lineup.get("confirmed") is None)
            else (1 if away_lineup.get("confirmed") else 0)
        ),
        "homeLineupConfirmed": _with_missing(
            None if (home_lineup is None or home_lineup.get("confirmed") is None)
            else (1 if home_lineup.get("confirmed") else 0)
        ),
        "awayLineupQuality": _with_missing(_num(away_lineup.get("qualityScore"), None) if away_lineup else None),
        "homeLineupQuality": _with_missing(_num(home_lineup.get("qualityScore"), None) if home_lineup else None),
        "awayLineupCount": _with_missing(_num(away_lineup.get("count"), None) if away_lineup else None),
        "homeLineupCount": _with_missing(_num(home_lineup.get("count"), None) if home_lineup else None),

        "awayInjuryCount": _with_missing(len(away_injuries) if isinstance(away_injuries, list) else None),
        "homeInjuryCount": _with_missing(len(home_injuries) if isinstance(home_injuries, list) else None),

        "h2hGames": _with_missing(h2h_games if (h2h_games is not None and h2h_games > 0) else None),
        "h2hHomeWinPct": _with_missing(
            (h2h_prob / 100.0)
            if (h2h_games is not None and h2h_games > 0 and h2h_prob is not None)
            else None
        ),

        "temperature": _with_missing(temp_num),
        "windSpeed": _with_missing(wind_speed),
        "windHittingOut": _with_missing(None if wind_out is None else (1 if wind_out else 0)),
        "windHittingIn": _with_missing(None if wind_in is None else (1 if wind_in else 0)),

        "awayStarterHandLeft": _with_missing(
            None if away_starter_hand is None else (1 if away_starter_hand == "L" else 0)
        ),
        "homeStarterHandLeft": _with_missing(
            None if home_starter_hand is None else (1 if home_starter_hand == "L" else 0)
        ),
    }

    vector["featureVectorHash"] = hashFeatureVector(vector)
    return vector


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _js_round(value: float) -> int:
    return int(math.floor(value + 0.5))


def _first_not_none(*vals: Any) -> Any:
    for v in vals:
        if v is not None:
            return v
    return None


_EXPLICIT_TZ_RE = re.compile(r"(?:Z|[+-]\d{2}:?\d{2})$", re.I)
_YMD_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_OPENER_KEYWORD_RE = re.compile(r"\b(opener|bulk|piggyback)\b|opener\s*/\s*bulk", re.I)
_NON_PITCHER_OPENER_RE = re.compile(
    r"\b(home|season|series|road|spring|exhibition|day)\s+opener\b", re.I
)
_OPENER_NOTE_KEYS = (
    "note", "notes", "description", "summary", "role", "type",
    "gameNote", "gameNotes", "probablePitcherNote", "probablePitcherNotes",
)


def _parse_iso_dt(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s or not _EXPLICIT_TZ_RE.search(s):
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return None
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _ymd_diff_days(target_ymd: Any, earlier_ymd: Any) -> int | None:
    if not isinstance(target_ymd, str) or not isinstance(earlier_ymd, str):
        return None
    m1 = _YMD_RE.match(target_ymd.strip())
    m2 = _YMD_RE.match(earlier_ymd.strip())
    if not m1 or not m2:
        return None
    try:
        d1 = datetime(int(m1.group(1)), int(m1.group(2)), int(m1.group(3)), tzinfo=timezone.utc)
        d2 = datetime(int(m2.group(1)), int(m2.group(2)), int(m2.group(3)), tzinfo=timezone.utc)
        return int((d1 - d2).days)
    except ValueError:
        return None


def _collect_opener_notes(obj: Any) -> list[str]:
    if not isinstance(obj, dict):
        return []
    lines: list[str] = []
    for key in _OPENER_NOTE_KEYS:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            lines.append(val.strip())
        elif isinstance(val, list):
            for item in val:
                if isinstance(item, str) and item.strip():
                    lines.append(item.strip())
    return lines


def _detect_opener_flag(
    team_entry: Any, probable_pitcher: Any, pitcher_stats: Any, explicit_opener: bool = False
) -> bool:
    if explicit_opener or (isinstance(pitcher_stats, dict) and pitcher_stats.get("isOpener") is True):
        return True
    notes = " ".join(
        line
        for line in (_collect_opener_notes(team_entry) + _collect_opener_notes(probable_pitcher))
        if not _NON_PITCHER_OPENER_RE.search(line)
    )
    if notes and _OPENER_KEYWORD_RE.search(notes):
        return True

    if isinstance(pitcher_stats, dict):
        gs = _num(_first_not_none(pitcher_stats.get("gamesStarted"), pitcher_stats.get("starts")), None)
        app = _num(
            _first_not_none(
                pitcher_stats.get("gamesPitched"),
                pitcher_stats.get("appearances"),
                pitcher_stats.get("games"),
            ),
            None,
        )
        if gs is not None and app is not None and app >= 10 and (gs / app) < 0.3:
            return True
    return False


def _lookup_park_entry(baselines: Any, venue_id: Any, team_id: Any) -> dict | None:
    if not baselines:
        return None

    def _lookup_key(key: Any) -> dict | None:
        if key is None or key == "" or key == 0:
            return None
        if isinstance(baselines, list):
            for entry in baselines:
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    eid, val = entry[0], entry[1]
                elif isinstance(entry, dict):
                    eid, val = entry.get("id"), entry.get("value")
                else:
                    continue
                if eid == key or str(eid) == str(key):
                    return val if isinstance(val, dict) else None
            return None
        if isinstance(baselines, dict):
            val = baselines.get(key)
            if val is None:
                val = baselines.get(str(key))
            return val if isinstance(val, dict) else None
        return None

    found = _lookup_key(venue_id)
    if found is not None:
        return found
    return _lookup_key(team_id)


def _normalize_park_factor(value: Any) -> float | None:
    n = _num(value, None)
    if n is None or not (n > 0):
        return None
    normalized = (n / 100.0) if n > 10 else n
    return _clamp(normalized, 0.75, 1.35)


def _parse_baseball_ip(value: Any) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return max(0.0, float(value)) if math.isfinite(float(value)) else None
    text = str(value).strip()
    if not text:
        return None
    parts = text.split(".")
    try:
        whole_num = int(parts[0])
    except ValueError:
        return None
    partial_num = 0
    if len(parts) > 1:
        try:
            p = int(parts[1])
            if 0 <= p <= 2:
                partial_num = p
        except ValueError:
            partial_num = 0
    return max(0.0, (whole_num * 3 + partial_num) / 3.0)


def _extract_season_ip_per_start(stats_obj: Any) -> tuple[float, float] | None:
    if not isinstance(stats_obj, dict):
        return None
    ip = _parse_baseball_ip(
        _first_not_none(stats_obj.get("inningsPitched"), stats_obj.get("ip"), stats_obj.get("innings"))
    )
    gs = _num(_first_not_none(stats_obj.get("gamesStarted"), stats_obj.get("starts")), 0.0)
    if ip is not None and ip > 0 and gs >= 2:
        return (_clamp(ip / gs, 2.5, 7.5), gs)
    return None


def _compute_projected_starter_ip(
    pitcher_stats: dict | None,
    pitcher_recent: dict | None,
    is_opener: bool = False,
    official_date: str | None = None,
) -> float | None:
    if is_opener:
        return 1.75
    season_data = _extract_season_ip_per_start(pitcher_stats)
    prior_data = _extract_season_ip_per_start(
        pitcher_stats.get("priorSeason") if isinstance(pitcher_stats, dict) else None
    )
    recent_games = _num(pitcher_recent.get("games") if isinstance(pitcher_recent, dict) else None, 0.0)
    recent_ip = _num(pitcher_recent.get("innings") if isinstance(pitcher_recent, dict) else None, 0.0)
    has_recent = recent_games > 0 and recent_ip > 0

    if not season_data and not prior_data and not has_recent:
        return None

    base_ip = 5.4
    if prior_data:
        avg_ip, gs = prior_data
        w_prior = _clamp(gs / (gs + 10.0), 0.0, 0.7)
        base_ip = w_prior * avg_ip + (1.0 - w_prior) * 5.4
    if season_data:
        avg_ip, gs = season_data
        w_season = _clamp(gs / (gs + 6.0), 0.0, 0.85)
        base_ip = w_season * avg_ip + (1.0 - w_season) * base_ip
    if has_recent:
        recent_avg = _clamp(recent_ip / recent_games, 2.0, 7.8)
        w_recent = _clamp(recent_games / (recent_games + 3.0), 0.0, 0.65)
        base_ip = w_recent * recent_avg + (1.0 - w_recent) * base_ip

    rest_raw = _first_not_none(
        pitcher_recent.get("restDays") if isinstance(pitcher_recent, dict) else None,
        pitcher_stats.get("restDays") if isinstance(pitcher_stats, dict) else None,
    )
    rest_days = _num(rest_raw, None)
    if rest_days is None and official_date and isinstance(pitcher_recent, dict) and pitcher_recent.get("lastStartDate"):
        diff = _ymd_diff_days(official_date, pitcher_recent.get("lastStartDate"))
        if diff is not None:
            derived = max(0, diff - 1)
            if derived <= 30:
                rest_days = float(derived)
    rest_ip_adj = 0.0
    if rest_days is not None:
        if rest_days <= 3:
            rest_ip_adj = -0.55
        elif rest_days >= 10:
            rest_ip_adj = -0.65

    return _js_round(_clamp(base_ip + rest_ip_adj, 1.5, 7.2) * 100.0) / 100.0


def buildFeatureVectorV2(coreInputs: dict, context: dict | None = None) -> dict:
    """Python lockstep mirror of buildFeatureVectorV2 in src/core/feature_vector.js."""
    raw = coreInputs or {}
    ctx = context or {}
    base_v1 = buildFeatureVector(raw)

    game = raw.get("game") or {}
    teams = game.get("teams") or {}
    away_team = (teams.get("away") or {}).get("team") or {}
    home_team = (teams.get("home") or {}).get("team") or {}
    away_id = away_team.get("id")
    home_id = home_team.get("id")

    def at(obj: Any, idx: Any) -> Any:
        if not isinstance(obj, dict) or idx is None:
            return None
        if idx in obj:
            return obj[idx]
        return obj.get(str(idx))

    away_stats = at(raw.get("teamStats"), away_id)
    home_stats = at(raw.get("teamStats"), home_id)
    away_probable = (teams.get("away") or {}).get("probablePitcher") or {}
    home_probable = (teams.get("home") or {}).get("probablePitcher") or {}
    away_pitcher_id = away_probable.get("id")
    home_pitcher_id = home_probable.get("id")
    away_pitcher = at(raw.get("pitcherStats"), away_pitcher_id)
    home_pitcher = at(raw.get("pitcherStats"), home_pitcher_id)
    away_pitcher_recent = at(raw.get("pitcherRecentStarts"), away_pitcher_id)
    home_pitcher_recent = at(raw.get("pitcherRecentStarts"), home_pitcher_id)
    away_bullpen = at(raw.get("bullpenProfiles"), away_id)
    home_bullpen = at(raw.get("bullpenProfiles"), home_id)
    away_sched = at(raw.get("scheduleFatigueProfiles"), away_id)
    home_sched = at(raw.get("scheduleFatigueProfiles"), home_id)
    lineup = raw.get("lineupProfiles") or {}
    away_lineup = lineup.get("away") if isinstance(lineup, dict) else None
    home_lineup = lineup.get("home") if isinstance(lineup, dict) else None

    weather = game.get("weather") or {}
    wind = weather.get("wind")
    wind_out_v2 = bool(re.search(r"\b(?:out|cf|lf|rf)\b", wind, re.I)) if isinstance(wind, str) else None
    wind_in_v2 = bool(re.search(r"\bin\b", wind, re.I)) if isinstance(wind, str) else None
    wind_speed_v2 = base_v1["windSpeed"]["value"]

    # 1. Lead-time before first pitch (minutes, pregame only).
    as_of_dt = _parse_iso_dt(_first_not_none(ctx.get("asOfUtc"), raw.get("asOfUtc")))
    first_pitch_dt = _parse_iso_dt(
        _first_not_none(ctx.get("firstPitchUtc"), raw.get("firstPitchUtc"), game.get("gameDate"))
    )
    lead_time_minutes = None
    if as_of_dt is not None and first_pitch_dt is not None:
        delta_ms = int(round((first_pitch_dt - as_of_dt).total_seconds() * 1000.0))
        if delta_ms > 0:
            lead_time_minutes = delta_ms / 60000.0

    # 2. Park factors & park-adjusted season stats.
    baselines = raw.get("parkFactorBaselines")
    venue_id = _num((game.get("venue") or {}).get("id"), None) if isinstance(game.get("venue"), dict) else None
    game_park_entry = _lookup_park_entry(baselines, venue_id, home_id)
    away_park_entry = _lookup_park_entry(baselines, None, away_id)
    home_park_entry = _lookup_park_entry(baselines, None, home_id)

    game_park_run_factor = _normalize_park_factor(game_park_entry.get("runFactor") if game_park_entry else None)
    game_park_hr_factor = _normalize_park_factor(
        _first_not_none(
            game_park_entry.get("homeRunFactor") if game_park_entry else None,
            game_park_entry.get("runFactor") if game_park_entry else None,
        )
    )

    away_home_run_factor = _normalize_park_factor(away_park_entry.get("runFactor") if away_park_entry else None)
    home_home_run_factor = _normalize_park_factor(home_park_entry.get("runFactor") if home_park_entry else None)
    away_eff_run = ((1.0 + away_home_run_factor) / 2.0) if away_home_run_factor is not None else None
    home_eff_run = ((1.0 + home_home_run_factor) / 2.0) if home_home_run_factor is not None else None
    away_ops_scale = (1.0 + (away_eff_run - 1.0) * 0.6) if away_eff_run is not None else None
    home_ops_scale = (1.0 + (home_eff_run - 1.0) * 0.6) if home_eff_run is not None else None
    away_whip_scale = (1.0 + (away_eff_run - 1.0) * 0.5) if away_eff_run is not None else None
    home_whip_scale = (1.0 + (home_eff_run - 1.0) * 0.5) if home_eff_run is not None else None

    away_rpg_val = base_v1["awayRpg"]["value"]
    home_rpg_val = base_v1["homeRpg"]["value"]
    away_ops_val = base_v1["awayOps"]["value"]
    home_ops_val = base_v1["homeOps"]["value"]
    away_era_val = base_v1["awayEra"]["value"]
    home_era_val = base_v1["homeEra"]["value"]
    away_whip_val = base_v1["awayWhip"]["value"]
    home_whip_val = base_v1["homeWhip"]["value"]

    away_park_adj_rpg = (away_rpg_val / away_eff_run) if (away_rpg_val is not None and away_eff_run is not None) else None
    home_park_adj_rpg = (home_rpg_val / home_eff_run) if (home_rpg_val is not None and home_eff_run is not None) else None
    away_park_adj_ops = (away_ops_val / away_ops_scale) if (away_ops_val is not None and away_ops_scale is not None) else None
    home_park_adj_ops = (home_ops_val / home_ops_scale) if (home_ops_val is not None and home_ops_scale is not None) else None
    away_park_adj_era = (away_era_val / away_eff_run) if (away_era_val is not None and away_eff_run is not None) else None
    home_park_adj_era = (home_era_val / home_eff_run) if (home_era_val is not None and home_eff_run is not None) else None
    away_park_adj_whip = (away_whip_val / away_whip_scale) if (away_whip_val is not None and away_whip_scale is not None) else None
    home_park_adj_whip = (home_whip_val / home_whip_scale) if (home_whip_val is not None and home_whip_scale is not None) else None

    # 3. Lineup-weighted platoon & top-of-order.
    away_lineup_platoon_ops = _num(away_lineup.get("platoonOps") if isinstance(away_lineup, dict) else None, None)
    home_lineup_platoon_ops = _num(home_lineup.get("platoonOps") if isinstance(home_lineup, dict) else None, None)
    away_lineup_platoon_woba = _num(away_lineup.get("platoonWoba") if isinstance(away_lineup, dict) else None, None)
    home_lineup_platoon_woba = _num(home_lineup.get("platoonWoba") if isinstance(home_lineup, dict) else None, None)
    away_lineup_platoon_ops_delta = _num(away_lineup.get("platoonOpsDelta") if isinstance(away_lineup, dict) else None, None)
    home_lineup_platoon_ops_delta = _num(home_lineup.get("platoonOpsDelta") if isinstance(home_lineup, dict) else None, None)
    away_lineup_platoon_woba_delta = _num(away_lineup.get("platoonWobaDelta") if isinstance(away_lineup, dict) else None, None)
    home_lineup_platoon_woba_delta = _num(home_lineup.get("platoonWobaDelta") if isinstance(home_lineup, dict) else None, None)
    away_lineup_top_order_ops = _num(away_lineup.get("topOrderOps") if isinstance(away_lineup, dict) else None, None)
    home_lineup_top_order_ops = _num(home_lineup.get("topOrderOps") if isinstance(home_lineup, dict) else None, None)

    # 4. Continuous projected starter IP & bullpen relief quality.
    openers = raw.get("openerSituations") if isinstance(raw.get("openerSituations"), dict) else {}
    away_is_opener = _detect_opener_flag(
        teams.get("away"),
        away_probable,
        away_pitcher,
        bool((openers.get("away") or {}).get("isOpener") if isinstance(openers.get("away"), dict) else False),
    )
    home_is_opener = _detect_opener_flag(
        teams.get("home"),
        home_probable,
        home_pitcher,
        bool((openers.get("home") or {}).get("isOpener") if isinstance(openers.get("home"), dict) else False),
    )
    official_date = game.get("officialDate")
    away_starter_projected_ip = _compute_projected_starter_ip(
        away_pitcher, away_pitcher_recent, away_is_opener, official_date
    )
    home_starter_projected_ip = _compute_projected_starter_ip(
        home_pitcher, home_pitcher_recent, home_is_opener, official_date
    )
    away_starter_share = (
        (_js_round((away_starter_projected_ip / 9.0) * 10000.0) / 10000.0)
        if away_starter_projected_ip is not None
        else None
    )
    home_starter_share = (
        (_js_round((home_starter_projected_ip / 9.0) * 10000.0) / 10000.0)
        if home_starter_projected_ip is not None
        else None
    )
    away_bullpen_relief_era = _num(away_bullpen.get("reliefEra") if isinstance(away_bullpen, dict) else None, None)
    home_bullpen_relief_era = _num(home_bullpen.get("reliefEra") if isinstance(home_bullpen, dict) else None, None)
    away_bullpen_relief_whip = _num(away_bullpen.get("reliefWhip") if isinstance(away_bullpen, dict) else None, None)
    home_bullpen_relief_whip = _num(home_bullpen.get("reliefWhip") if isinstance(home_bullpen, dict) else None, None)

    # 5. Statcast / expected metrics & travel/jet-lag fatigue.
    statcast = raw.get("statcast") if isinstance(raw.get("statcast"), dict) else {}
    away_sc_team = at(statcast.get("teams"), away_id)
    home_sc_team = at(statcast.get("teams"), home_id)
    away_sc_pitcher = at(statcast.get("pitchers"), away_pitcher_id)
    home_sc_pitcher = at(statcast.get("pitchers"), home_pitcher_id)

    away_hitting = away_stats.get("hitting") if isinstance(away_stats, dict) and isinstance(away_stats.get("hitting"), dict) else {}
    home_hitting = home_stats.get("hitting") if isinstance(home_stats, dict) and isinstance(home_stats.get("hitting"), dict) else {}

    away_team_xwoba = _num(
        _first_not_none(
            away_sc_team.get("xwoba") if isinstance(away_sc_team, dict) else None,
            away_stats.get("xwoba") if isinstance(away_stats, dict) else None,
            away_hitting.get("xwoba"),
        ),
        None,
    )
    home_team_xwoba = _num(
        _first_not_none(
            home_sc_team.get("xwoba") if isinstance(home_sc_team, dict) else None,
            home_stats.get("xwoba") if isinstance(home_stats, dict) else None,
            home_hitting.get("xwoba"),
        ),
        None,
    )
    away_team_barrel_rate = _num(
        _first_not_none(
            away_sc_team.get("barrelRate") if isinstance(away_sc_team, dict) else None,
            away_stats.get("barrelRate") if isinstance(away_stats, dict) else None,
            away_hitting.get("barrelRate"),
        ),
        None,
    )
    home_team_barrel_rate = _num(
        _first_not_none(
            home_sc_team.get("barrelRate") if isinstance(home_sc_team, dict) else None,
            home_stats.get("barrelRate") if isinstance(home_stats, dict) else None,
            home_hitting.get("barrelRate"),
        ),
        None,
    )
    away_starter_xera = _num(
        _first_not_none(
            away_sc_pitcher.get("xera") if isinstance(away_sc_pitcher, dict) else None,
            away_pitcher.get("xera") if isinstance(away_pitcher, dict) else None,
            away_pitcher.get("expectedEra") if isinstance(away_pitcher, dict) else None,
        ),
        None,
    )
    home_starter_xera = _num(
        _first_not_none(
            home_sc_pitcher.get("xera") if isinstance(home_sc_pitcher, dict) else None,
            home_pitcher.get("xera") if isinstance(home_pitcher, dict) else None,
            home_pitcher.get("expectedEra") if isinstance(home_pitcher, dict) else None,
        ),
        None,
    )

    away_travel_miles = _num(
        _first_not_none(
            away_sched.get("travelMiles") if isinstance(away_sched, dict) else None,
            away_sched.get("milesTraveled") if isinstance(away_sched, dict) else None,
        ),
        None,
    )
    home_travel_miles = _num(
        _first_not_none(
            home_sched.get("travelMiles") if isinstance(home_sched, dict) else None,
            home_sched.get("milesTraveled") if isinstance(home_sched, dict) else None,
        ),
        None,
    )
    away_timezone_shift = _num(
        _first_not_none(
            away_sched.get("timezoneShiftHours") if isinstance(away_sched, dict) else None,
            away_sched.get("timezoneShift") if isinstance(away_sched, dict) else None,
        ),
        None,
    )
    home_timezone_shift = _num(
        _first_not_none(
            home_sched.get("timezoneShiftHours") if isinstance(home_sched, dict) else None,
            home_sched.get("timezoneShift") if isinstance(home_sched, dict) else None,
        ),
        None,
    )
    away_travel_fatigue_score = _num(
        _first_not_none(
            away_sched.get("fatigueScore") if isinstance(away_sched, dict) else None,
            away_sched.get("travelFatigueScore") if isinstance(away_sched, dict) else None,
        ),
        None,
    )
    home_travel_fatigue_score = _num(
        _first_not_none(
            home_sched.get("fatigueScore") if isinstance(home_sched, dict) else None,
            home_sched.get("travelFatigueScore") if isinstance(home_sched, dict) else None,
        ),
        None,
    )

    # 6. Explicit domain interactions.
    platoon_delta_diff = None
    if home_lineup_platoon_woba_delta is not None and away_lineup_platoon_woba_delta is not None:
        platoon_delta_diff = home_lineup_platoon_woba_delta - away_lineup_platoon_woba_delta
    elif home_lineup_platoon_ops_delta is not None and away_lineup_platoon_ops_delta is not None:
        platoon_delta_diff = (home_lineup_platoon_ops_delta - away_lineup_platoon_ops_delta) * 0.43

    away_starter_hr9_val = base_v1["awayStarterHr9"]["value"]
    home_starter_hr9_val = base_v1["homeStarterHr9"]["value"]
    flyball_park_wind_index = None
    if (
        away_starter_hr9_val is not None
        and home_starter_hr9_val is not None
        and (game_park_hr_factor is not None or wind_out_v2 is not None or wind_in_v2 is not None)
    ):
        park_term = (game_park_hr_factor - 1.0) if game_park_hr_factor is not None else 0.0
        speed_eff = wind_speed_v2 if wind_speed_v2 is not None else 8.0
        wind_term = ((1 if wind_out_v2 else 0) - (1 if wind_in_v2 else 0)) * (speed_eff / 100.0)
        flyball_park_wind_index = (away_starter_hr9_val - home_starter_hr9_val) * (park_term + wind_term)

    vector_v2 = {k: v for k, v in base_v1.items() if k != "featureVectorHash"}
    vector_v2.update({
        "schemaVersion": FEATURE_VECTOR_V2_SCHEMA_VERSION,
        "windHittingOut": _with_missing(None if wind_out_v2 is None else (1 if wind_out_v2 else 0)),

        "leadTimeMinutes": _with_missing(lead_time_minutes),

        "gameParkRunFactor": _with_missing(game_park_run_factor),
        "gameParkHrFactor": _with_missing(game_park_hr_factor),
        "awayHomeParkEffRunFactor": _with_missing(away_eff_run),
        "homeHomeParkEffRunFactor": _with_missing(home_eff_run),
        "awayParkAdjRpg": _with_missing(away_park_adj_rpg),
        "homeParkAdjRpg": _with_missing(home_park_adj_rpg),
        "awayParkAdjOps": _with_missing(away_park_adj_ops),
        "homeParkAdjOps": _with_missing(home_park_adj_ops),
        "awayParkAdjEra": _with_missing(away_park_adj_era),
        "homeParkAdjEra": _with_missing(home_park_adj_era),
        "awayParkAdjWhip": _with_missing(away_park_adj_whip),
        "homeParkAdjWhip": _with_missing(home_park_adj_whip),

        "awayLineupPlatoonOps": _with_missing(away_lineup_platoon_ops),
        "homeLineupPlatoonOps": _with_missing(home_lineup_platoon_ops),
        "awayLineupPlatoonWoba": _with_missing(away_lineup_platoon_woba),
        "homeLineupPlatoonWoba": _with_missing(home_lineup_platoon_woba),
        "awayLineupPlatoonOpsDelta": _with_missing(away_lineup_platoon_ops_delta),
        "homeLineupPlatoonOpsDelta": _with_missing(home_lineup_platoon_ops_delta),
        "awayLineupPlatoonWobaDelta": _with_missing(away_lineup_platoon_woba_delta),
        "homeLineupPlatoonWobaDelta": _with_missing(home_lineup_platoon_woba_delta),
        "awayLineupTopOrderOps": _with_missing(away_lineup_top_order_ops),
        "homeLineupTopOrderOps": _with_missing(home_lineup_top_order_ops),

        "awayStarterProjectedIp": _with_missing(away_starter_projected_ip),
        "homeStarterProjectedIp": _with_missing(home_starter_projected_ip),
        "awayStarterShare": _with_missing(away_starter_share),
        "homeStarterShare": _with_missing(home_starter_share),
        "awayBullpenReliefEra": _with_missing(away_bullpen_relief_era),
        "homeBullpenReliefEra": _with_missing(home_bullpen_relief_era),
        "awayBullpenReliefWhip": _with_missing(away_bullpen_relief_whip),
        "homeBullpenReliefWhip": _with_missing(home_bullpen_relief_whip),

        "awayTeamXwoba": _with_missing(away_team_xwoba),
        "homeTeamXwoba": _with_missing(home_team_xwoba),
        "awayTeamBarrelRate": _with_missing(away_team_barrel_rate),
        "homeTeamBarrelRate": _with_missing(home_team_barrel_rate),
        "awayStarterXera": _with_missing(away_starter_xera),
        "homeStarterXera": _with_missing(home_starter_xera),
        "awayTravelMiles": _with_missing(away_travel_miles),
        "homeTravelMiles": _with_missing(home_travel_miles),
        "awayTimezoneShift": _with_missing(away_timezone_shift),
        "homeTimezoneShift": _with_missing(home_timezone_shift),
        "awayTravelFatigueScore": _with_missing(away_travel_fatigue_score),
        "homeTravelFatigueScore": _with_missing(home_travel_fatigue_score),

        "platoonDeltaDiff": _with_missing(platoon_delta_diff),
        "flyballParkWindIndex": _with_missing(flyball_park_wind_index),
    })

    vector_v2["featureVectorHash"] = hashFeatureVector(vector_v2)
    return vector_v2


def _js_number_to_string(value: int | float) -> str:
    """Format finite numbers identically to ECMA-262 Number::toString / JSON.stringify."""
    if isinstance(value, int) and not isinstance(value, bool):
        f = float(value)
        if abs(f) < 1e21:
            return str(value)
        value = f
    f = float(value)
    if f == 0.0:
        return "0"
    neg = f < 0.0
    af = -f if neg else f
    s = repr(af)
    if "e" in s or "E" in s:
        mant_s, exp_s = s.lower().split("e")
        exp = int(exp_s)
        if "." in mant_s:
            int_p, frac_p = mant_s.split(".")
            digits = int_p + frac_p
        else:
            digits = mant_s
        digits = digits.rstrip("0") or "0"
    else:
        if "." in s:
            int_p, frac_p = s.split(".")
            if int_p == "0":
                stripped = frac_p.lstrip("0")
                leading_zeros = len(frac_p) - len(stripped)
                exp = -(leading_zeros + 1)
                digits = stripped.rstrip("0") or "0"
            else:
                exp = len(int_p) - 1
                digits = (int_p + frac_p).rstrip("0") or "0"
        else:
            exp = len(s) - 1
            digits = s.rstrip("0") or "0"

    if -6 <= exp < 21:
        if exp >= len(digits) - 1:
            body = digits + ("0" * (exp - len(digits) + 1))
        elif exp >= 0:
            body = digits[: exp + 1] + "." + digits[exp + 1 :]
        else:
            body = "0." + ("0" * (-exp - 1)) + digits
    else:
        mant = digits[0] if len(digits) == 1 else f"{digits[0]}.{digits[1:]}"
        sign_e = "+" if exp >= 0 else "-"
        body = f"{mant}e{sign_e}{abs(exp)}"

    return f"-{body}" if neg else body


def _stable_stringify(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number_to_string(value)
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(f"{json.dumps(k)}:{_stable_stringify(value[k])}" for k in keys) + "}"


def hashFeatureVector(vector: dict) -> str:
    body = {k: v for k, v in vector.items() if k != "featureVectorHash"}
    return hashlib.sha256(_stable_stringify(body).encode()).hexdigest()


def flattenFeatureVector(vector: dict) -> dict:
    flat = {
        "schemaVersion": vector.get("schemaVersion"),
        "featureSchemaVersion": vector.get("featureSchemaVersion"),
        "gamePk": vector.get("gamePk"),
        "awayTeamId": vector.get("awayTeamId"),
        "homeTeamId": vector.get("homeTeamId"),
        "venueId": vector.get("venueId"),
        "officialDate": vector.get("officialDate"),
        "featureVectorHash": vector.get("featureVectorHash"),
    }
    for key, cell in vector.items():
        if key in _META_KEYS:
            continue
        if isinstance(cell, dict) and "value" in cell:
            flat[key] = cell["value"]
            flat[f"missing_{key}"] = cell["missing"]
        else:
            flat[key] = cell
    return flat
