"""Data collection layer for the MLB prediction pipeline.

This module only fetches or loads raw pre-game inputs. It does not score,
predict, compare markets, or explain outcomes.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime, timezone
from typing import Any

from .bullpen import get_bullpen_usage as find_bullpen_usage
from .bullpen import load_bullpen_usage
from .data_loader import (
    GameRow,
    PitcherStats,
    TeamStats,
    find_pitcher,
    find_team,
    load_pitcher_stats,
    load_sample_games,
    load_team_stats,
    read_csv,
)
from .data_sources.mlb_statsapi_client import MlbStatsApiClient
from .data_sources.retrosheet_loader import load_game_logs
from .lineup import get_lineup, load_lineups
from .park_factors import get_park_factor as find_park_factor
from .park_factors import load_park_factors
from .totals import GameTotalContext
from .utils import clean_name, data_path, safe_float
from .weather import get_weather_context as find_weather_context
from .weather import load_weather_contexts


def local_state() -> dict[str, Any]:
    """Load local CSV-backed state for the pipeline."""
    return {
        "games": load_sample_games(),
        "teams": load_team_stats(),
        "pitchers": load_pitcher_stats(),
        "parks": load_park_factors(),
        "weather": load_weather_contexts(),
        "bullpens": load_bullpen_usage(),
        "lineups": load_lineups(),
        "retrosheet": load_game_logs(),
    }


def fresh_timestamp() -> str:
    """Return an ISO timestamp for local sample data freshness checks."""
    return datetime.now(timezone.utc).isoformat()


def stamp(payload: dict[str, Any], timestamp: str) -> dict[str, Any]:
    """Attach a data timestamp when payload is available."""
    stamped = dict(payload)
    if stamped.get("available") is not False:
        stamped["data_timestamp"] = timestamp
    return stamped


def game_key(game: GameRow) -> str:
    """Return a stable matchup key."""
    return f"{clean_name(game.away_team)}@{clean_name(game.home_team)}"


def resolve_game(game_id: str | int, games: list[GameRow] | None = None) -> GameRow:
    """Resolve a local sample game by index, team, or matchup string."""
    all_games = games or load_sample_games()
    raw = str(game_id).strip()
    if raw.isdigit():
        index = int(raw)
        if 0 <= index < len(all_games):
            return all_games[index]

    normalized = clean_name(raw.replace(" vs ", "@").replace(" at ", "@"))
    for game in all_games:
        keys = {
            clean_name(game.home_team),
            clean_name(game.away_team),
            game_key(game),
            clean_name(f"{game.away_team} @ {game.home_team}"),
            clean_name(f"{game.home_team} vs {game.away_team}"),
        }
        if normalized in keys:
            return game

    available = ", ".join(
        f"{idx}: {game.away_team} @ {game.home_team}" for idx, game in enumerate(all_games)
    )
    raise ValueError(f'Game "{game_id}" not found. Available: {available}')


def pitcher_for_game(
    game: GameRow,
    side: str,
    pitchers: dict[str, PitcherStats],
) -> PitcherStats | None:
    """Return probable pitcher for home or away side."""
    return find_pitcher(pitchers, game.home_pitcher if side == "home" else game.away_pitcher)


def team(teams: dict[str, TeamStats], name: str) -> TeamStats:
    """Return team stats by name."""
    return find_team(teams, name)


def get_today_games(use_live: bool = False, date_ymd: str | None = None) -> list[dict[str, Any]]:
    """Return today's games from MLB Stats API or local sample games."""
    if use_live:
        target_date = date_ymd or date.today().isoformat()
        schedule = MlbStatsApiClient().schedule(target_date)
        return [
            {
                "game_id": game.get("gamePk"),
                "game_time": game.get("gameDate"),
                "status": game.get("status", {}).get("detailedState"),
                "away_team": game.get("teams", {}).get("away", {}).get("team", {}).get("name"),
                "home_team": game.get("teams", {}).get("home", {}).get("team", {}).get("name"),
                "ballpark": game.get("venue", {}).get("name"),
            }
            for day in schedule.get("dates", [])
            for game in day.get("games", [])
        ]

    return [
        {
            "game_id": index,
            "date": game.date,
            "away_team": game.away_team,
            "home_team": game.home_team,
            "away_pitcher": game.away_pitcher,
            "home_pitcher": game.home_pitcher,
            "final": game.home_score is not None and game.away_score is not None,
        }
        for index, game in enumerate(load_sample_games())
    ]


def get_bullpen_usage(team_id: str, last_n_days: int = 3) -> dict[str, Any]:
    """Return bullpen usage and fatigue sample fields."""
    usage = find_bullpen_usage(load_bullpen_usage(), team_id)
    if usage is None:
        return {"team": team_id, "last_n_days": last_n_days, "available": False}
    payload = asdict(usage)
    payload["last_n_days"] = last_n_days
    payload["available"] = True
    return payload


def get_park_factor(ballpark_id: str) -> dict[str, Any]:
    """Return park factor by home team or ballpark key."""
    park = find_park_factor(load_park_factors(), ballpark_id)
    if park is None:
        return {"ballpark_id": ballpark_id, "available": False}
    payload = asdict(park)
    payload["available"] = True
    return payload


def get_weather_context(
    ballpark_id: str,
    game_time: str | None = None,
    away_team: str | None = None,
) -> dict[str, Any]:
    """Return local weather context by home team and optional away team."""
    contexts = load_weather_contexts()
    if away_team:
        context = find_weather_context(contexts, ballpark_id, away_team)
    else:
        context = next(
            (item for item in contexts.values() if clean_name(item.home_team) == clean_name(ballpark_id)),
            None,
        )
    if context is None:
        return {"ballpark_id": ballpark_id, "game_time": game_time, "available": False}
    payload = asdict(context)
    payload["game_time"] = game_time
    payload["available"] = True
    return payload


def get_market_odds(game_id: str | int) -> dict[str, Any]:
    """Return local market total/odds row when present."""
    game = resolve_game(game_id)
    return market_odds_for_game(game)


def market_odds_for_game(game: GameRow) -> dict[str, Any]:
    """Return market row for a resolved game."""
    source = data_path("sample_market_totals.csv")
    if not source.exists():
        return {"available": False}

    for row in read_csv(source):
        if clean_name(row.get("home_team", "")) == clean_name(game.home_team) and clean_name(
            row.get("away_team", "")
        ) == clean_name(game.away_team):
            return {
                "available": True,
                "home_team": row.get("home_team"),
                "away_team": row.get("away_team"),
                "home_moneyline": row.get("home_moneyline"),
                "away_moneyline": row.get("away_moneyline"),
                "run_line": safe_float(row.get("run_line"), 0.0),
                "home_run_line_odds": row.get("home_run_line_odds"),
                "away_run_line_odds": row.get("away_run_line_odds"),
                "market_total": safe_float(row.get("market_total"), 0.0),
                "opening_total": safe_float(row.get("opening_total"), 0.0),
                "current_total": safe_float(row.get("current_total"), 0.0),
                "closing_total": safe_float(row.get("closing_total"), 0.0),
                "over_odds": row.get("over_odds"),
                "under_odds": row.get("under_odds"),
            }
    return {"available": False}


def collect_game_data(game_id: str | int) -> dict[str, Any]:
    """Collect raw data for one game without scoring or prediction."""
    state = local_state()
    game = resolve_game(game_id, state["games"])
    home_team = team(state["teams"], game.home_team)
    away_team = team(state["teams"], game.away_team)
    home_pitcher = pitcher_for_game(game, "home", state["pitchers"])
    away_pitcher = pitcher_for_game(game, "away", state["pitchers"])
    home_lineup = get_lineup(state["lineups"], game.home_team)
    away_lineup = get_lineup(state["lineups"], game.away_team)
    home_bullpen_raw = find_bullpen_usage(state["bullpens"], game.home_team)
    away_bullpen_raw = find_bullpen_usage(state["bullpens"], game.away_team)
    park_raw = find_park_factor(state["parks"], game.home_team)
    weather_raw = find_weather_context(state["weather"], game.home_team, game.away_team)
    market = market_odds_for_game(game)
    timestamp = fresh_timestamp()

    home_pitcher_payload = asdict(home_pitcher) if home_pitcher else None
    away_pitcher_payload = asdict(away_pitcher) if away_pitcher else None
    if home_pitcher_payload:
        home_pitcher_payload["confirmed"] = True
    if away_pitcher_payload:
        away_pitcher_payload["confirmed"] = True

    context = {
        "matchup": f"{game.away_team} @ {game.home_team}",
        "date": game.date,
        "home_team": asdict(home_team),
        "away_team": asdict(away_team),
        "probable_pitchers": {
            "home": home_pitcher_payload,
            "away": away_pitcher_payload,
        },
        "park": get_park_factor(game.home_team),
        "weather": stamp(get_weather_context(game.home_team, away_team=game.away_team), timestamp),
        "lineup": {
            "home": asdict(home_lineup) if home_lineup else None,
            "away": asdict(away_lineup) if away_lineup else None,
        },
        "bullpen": {
            "home": stamp(get_bullpen_usage(game.home_team), timestamp),
            "away": stamp(get_bullpen_usage(game.away_team), timestamp),
        },
        "market": stamp(market, timestamp),
        "injury_news": {
            "available": home_lineup is not None or away_lineup is not None,
            "source": "lineup injury fields",
        },
        "calibration": {
            "supports_high_confidence": False,
            "source": "no validated live calibration sample loaded",
        },
    }

    total_context = GameTotalContext(
        home_pitcher=home_pitcher,
        away_pitcher=away_pitcher,
        home_lineup=home_lineup,
        away_lineup=away_lineup,
        home_bullpen=home_bullpen_raw,
        away_bullpen=away_bullpen_raw,
        weather=weather_raw,
        park=park_raw,
    )

    return {
        "state": state,
        "game": game,
        "home_team": home_team,
        "away_team": away_team,
        "home_pitcher": home_pitcher,
        "away_pitcher": away_pitcher,
        "home_lineup": home_lineup,
        "away_lineup": away_lineup,
        "home_bullpen": home_bullpen_raw,
        "away_bullpen": away_bullpen_raw,
        "park": park_raw,
        "weather": weather_raw,
        "market": market,
        "context": context,
        "total_context": total_context,
    }
