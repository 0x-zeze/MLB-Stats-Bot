"""Agent-facing MLB tools backed by local CSVs and optional data clients."""

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
)
from .data_collection import (
    collect_game_data,
    get_bullpen_usage as collect_bullpen_usage,
    get_market_odds as collect_market_odds,
    get_park_factor as collect_park_factor,
    get_today_games as collect_today_games,
    get_weather_context as collect_weather_context,
)
from .data_sources.mlb_statsapi_client import MlbStatsApiClient
from .data_sources.retrosheet_loader import load_game_logs, team_recent_form
from .lineup import get_lineup, load_lineups
from .model import BaselinePredictionModel
from .odds import american_odds_to_implied_probability, calculate_edge
from .park_factors import get_park_factor as find_park_factor
from .park_factors import load_park_factors
from .quality_control import apply_confidence_downgrade, generate_quality_report
from .prediction_pipeline import run_prediction_pipeline
from .totals import COMMON_TOTAL_LINES, GameTotalContext
from .totals import predict_total_runs as predict_total_runs_model
from .utils import clean_name, data_path, format_probability, safe_float
from .weather import get_weather_context as find_weather_context
from .weather import load_weather_contexts


def _local_state() -> dict[str, Any]:
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


def _fresh_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stamp(payload: dict[str, Any], timestamp: str) -> dict[str, Any]:
    stamped = dict(payload)
    if stamped.get("available") is not False:
        stamped["data_timestamp"] = timestamp
    return stamped


def _game_key(game: GameRow) -> str:
    return f"{clean_name(game.away_team)}@{clean_name(game.home_team)}"


def _resolve_game(game_id: str | int, games: list[GameRow] | None = None) -> GameRow:
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
            _game_key(game),
            clean_name(f"{game.away_team} @ {game.home_team}"),
            clean_name(f"{game.home_team} vs {game.away_team}"),
        }
        if normalized in keys:
            return game
    available = ", ".join(f"{idx}: {game.away_team} @ {game.home_team}" for idx, game in enumerate(all_games))
    raise ValueError(f'Game "{game_id}" not found. Available: {available}')


def _pitcher_for_game(game: GameRow, side: str, pitchers: dict[str, PitcherStats]) -> PitcherStats | None:
    return find_pitcher(pitchers, game.home_pitcher if side == "home" else game.away_pitcher)


def _team(teams: dict[str, TeamStats], name: str) -> TeamStats:
    return find_team(teams, name)


def get_today_games(use_live: bool = False, date_ymd: str | None = None) -> list[dict[str, Any]]:
    """Return today's games from MLB Stats API or local sample games."""
    return collect_today_games(use_live=use_live, date_ymd=date_ymd)


def get_game_context(game_id: str | int) -> dict[str, Any]:
    """Return compact pre-game context for a local sample matchup."""
    return collect_game_data(game_id)["context"]


def get_probable_pitchers(game_id: str | int) -> dict[str, Any]:
    """Return probable starters for a matchup."""
    state = _local_state()
    game = _resolve_game(game_id, state["games"])
    home_pitcher = _pitcher_for_game(game, "home", state["pitchers"])
    away_pitcher = _pitcher_for_game(game, "away", state["pitchers"])
    return {
        "home": asdict(home_pitcher) if home_pitcher else None,
        "away": asdict(away_pitcher) if away_pitcher else None,
    }


def get_team_recent_form(team_id: str, last_n_games: int = 10) -> dict[str, Any]:
    """Return leakage-safe recent form from local Retrosheet-style game logs."""
    return team_recent_form(load_game_logs(), team_id, last_n_games=last_n_games)


def get_pitcher_recent_form(pitcher_id: str, last_n_starts: int = 3) -> dict[str, Any]:
    """Return sample pitcher recent form fields."""
    pitcher = find_pitcher(load_pitcher_stats(), pitcher_id)
    if pitcher is None:
        return {"pitcher": pitcher_id, "starts": 0}
    return {
        "pitcher": pitcher.pitcher,
        "starts": last_n_starts,
        "recent_era": pitcher.recent_3_start_era,
        "recent_whip": pitcher.recent_3_start_whip,
        "pitch_count_last_start": pitcher.pitch_count_last_start,
        "days_rest": pitcher.days_rest,
    }


def get_team_offense_splits(team_id: str, pitcher_hand: str) -> dict[str, Any]:
    """Return team offense split versus pitcher handedness."""
    team = find_team(load_team_stats(), team_id)
    hand = pitcher_hand.strip().lower()
    vs_lhp = hand.startswith("l")
    return {
        "team": team.team,
        "pitcher_hand": "LHP" if vs_lhp else "RHP",
        "ops": team.ops_vs_lhp if vs_lhp else team.ops_vs_rhp,
        "wrc_plus": team.wrc_plus_vs_lhp if vs_lhp else team.wrc_plus_vs_rhp,
        "season_ops": team.ops,
        "season_wrc_plus": team.wrc_plus,
    }


def get_bullpen_usage(team_id: str, last_n_days: int = 3) -> dict[str, Any]:
    """Return bullpen usage and fatigue sample fields."""
    return collect_bullpen_usage(team_id, last_n_days=last_n_days)


def get_park_factor(ballpark_id: str) -> dict[str, Any]:
    """Return park factor by home team or ballpark key."""
    return collect_park_factor(ballpark_id)


def get_weather_context(ballpark_id: str, game_time: str | None = None, away_team: str | None = None) -> dict[str, Any]:
    """Return local weather context by home team and optional away team."""
    return collect_weather_context(ballpark_id, game_time=game_time, away_team=away_team)


def get_market_odds(game_id: str | int) -> dict[str, Any]:
    """Return local market total/odds row when present."""
    return collect_market_odds(game_id)


def predict_moneyline(game_id: str | int) -> dict[str, Any]:
    """Predict moneyline with model probability and market edge when available."""
    return run_prediction_pipeline(game_id)["moneyline"]


def predict_total_runs(game_id: str | int) -> dict[str, Any]:
    """Predict total runs and common over/under probabilities."""
    return run_prediction_pipeline(game_id)["totals"]


def explain_prediction(game_id: str | int) -> str:
    """Render a full MLB Game Analysis output for the agent."""
    return run_prediction_pipeline(game_id)["explanation"]


def explain_market_value(model_probability: float, american_odds: str | int | float) -> dict[str, float]:
    """Explain why a favorite can be bad value when market price is too high."""
    implied = american_odds_to_implied_probability(str(american_odds))
    return {
        "model_probability": model_probability,
        "market_implied_probability": implied,
        "edge": calculate_edge(model_probability, implied),
    }
