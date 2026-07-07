"""Elo/TrueSkill-style rolling team strength rating.

Tracks team strength on a game-by-game basis using an Elo-like update rule.
Captures momentum and strength-of-schedule that static season aggregates miss.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from .utils import clamp, safe_float

DEFAULT_K = 32.0
DEFAULT_INIT_RATING = 1500.0
HOME_ADVANTAGE_ELO = 35.0
SEASON_REGRESSION = 0.35  # carryover weight for prior season rating


@dataclass
class EloRating:
    team: str
    rating: float = DEFAULT_INIT_RATING
    games: int = 0
    last_updated: str = ""


@dataclass
class EloHistory:
    ratings: dict[str, EloRating] = field(default_factory=dict)
    home_advantage: float = HOME_ADVANTAGE_ELO


def expected_probability(home_rating: float, away_rating: float, home_advantage: float = HOME_ADVANTAGE_ELO) -> float:
    """Standard Elo expected score for home team."""
    effective_home = home_rating + home_advantage
    exponent = (away_rating - effective_home) / 400.0
    return clamp(1.0 / (1.0 + 10.0 ** exponent), 0.01, 0.99)


def update_ratings(
    home_team: str,
    away_team: str,
    home_score: float,
    away_score: float,
    history: EloHistory,
    k: float = DEFAULT_K,
    game_date: str = "",
) -> None:
    """Update Elo ratings after a completed game."""
    home = history.ratings.setdefault(home_team, EloRating(team=home_team))
    away = history.ratings.setdefault(away_team, EloRating(team=away_team))

    expected_home = expected_probability(home.rating, away.rating, history.home_advantage)
    actual_home = 1.0 if home_score > away_score else (0.5 if home_score == away_score else 0.0)

    margin = abs(home_score - away_score)
    margin_multiplier = clamp(1.0 + margin * 0.06, 1.0, 2.5)

    delta = k * margin_multiplier * (actual_home - expected_home)
    home.rating = clamp(home.rating + delta, 800.0, 2400.0)
    away.rating = clamp(away.rating - delta, 800.0, 2400.0)
    home.games += 1
    away.games += 1
    home.last_updated = game_date
    away.last_updated = game_date


def carry_over_season(history: EloHistory, regression: float = SEASON_REGRESSION) -> None:
    """Regress ratings toward the mean at the start of a new season."""
    for rating in history.ratings.values():
        rating.rating = DEFAULT_INIT_RATING * (1.0 - regression) + rating.rating * regression
        rating.games = 0


def elo_to_win_probability(home_team: str, away_team: str, history: EloHistory) -> float | None:
    """Return home win probability from Elo, or None if either team unrated."""
    home = history.ratings.get(home_team)
    away = history.ratings.get(away_team)
    if home is None or away is None:
        return None
    if home.games < 5 or away.games < 5:
        return None
    return expected_probability(home.rating, away.rating, history.home_advantage)


def build_elo_from_schedule(
    games: list[dict[str, Any]],
    k: float = DEFAULT_K,
) -> EloHistory:
    """Build Elo history from a list of completed games.

    Each game dict must have: home_team, away_team, home_score, away_score, date.
    Games are processed in date order to avoid lookahead bias.
    """
    history = EloHistory()
    sorted_games = sorted(games, key=lambda g: str(g.get("date", "")))

    for game in sorted_games:
        home_team = str(game.get("home_team", "")).strip()
        away_team = str(game.get("away_team", "")).strip()
        home_score = safe_float(game.get("home_score"), None)
        away_score = safe_float(game.get("away_score"), None)
        game_date = str(game.get("date", ""))

        if not home_team or not away_team or home_score is None or away_score is None:
            continue

        update_ratings(home_team, away_team, home_score, away_score, history, k, game_date)

    return history


def elo_strength_adjustment(home_team: str, away_team: str, history: EloHistory | None) -> float:
    """Return a -1..1 adjustment from Elo rating differential.

    Positive = home team favored. Used as a feature in the prediction model.
    """
    if history is None:
        return 0.0
    home = history.ratings.get(home_team)
    away = history.ratings.get(away_team)
    if home is None or away is None:
        return 0.0
    if home.games < 5 or away.games < 5:
        return 0.0
    diff = home.rating - away.rating + history.home_advantage
    return clamp(diff / 400.0, -1.0, 1.0)
