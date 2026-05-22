"""Situational weight engine for dynamic model weight adjustment."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from .utils import clamp, safe_float


@dataclass(frozen=True)
class GameSituation:
    """Context that drives weight adjustments."""

    park_type: str = "neutral"  # "pitcher_park", "hitter_park", "neutral"
    opener_detected: bool = False
    short_start_projected: bool = False
    seasonal_phase: str = "mid"  # "early" (Apr), "mid" (May-Jul), "late" (Aug-Sep)
    game_date: date | None = None


BASE_WEIGHTS = {
    "team_strength": 0.30,
    "starting_pitcher": 0.25,
    "offense": 0.20,
    "bullpen": 0.10,
    "recent_form": 0.10,
    "home_field": 0.05,
}

MAX_SHIFT = 0.05


def _normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    """Normalize weights to sum to 1.0."""
    total = sum(weights.values())
    if total <= 0:
        return BASE_WEIGHTS.copy()
    return {k: v / total for k, v in weights.items()}


def _apply_shift(
    weights: dict[str, float],
    adjustments: dict[str, float],
) -> dict[str, float]:
    """Apply bounded shifts to weights."""
    result = dict(weights)
    for key, shift in adjustments.items():
        if key in result:
            bounded_shift = clamp(shift, -MAX_SHIFT, MAX_SHIFT)
            result[key] = max(0.01, result[key] + bounded_shift)
    return _normalize_weights(result)


def _park_adjustment(park_type: str) -> dict[str, float]:
    """Pitcher park: boost starting_pitcher. Hitter park: boost offense."""
    if park_type == "pitcher_park":
        return {"starting_pitcher": 0.03, "offense": -0.02, "home_field": -0.01}
    elif park_type == "hitter_park":
        return {"offense": 0.03, "starting_pitcher": -0.02, "bullpen": 0.01, "home_field": -0.02}
    return {}


def _opener_adjustment(opener: bool, short_start: bool) -> dict[str, float]:
    """Opener detected: reduce starting_pitcher, boost bullpen."""
    if opener:
        return {"starting_pitcher": -0.05, "bullpen": 0.04, "offense": 0.01}
    if short_start:
        return {"starting_pitcher": -0.03, "bullpen": 0.03}
    return {}


def _seasonal_adjustment(phase: str) -> dict[str, float]:
    """Early season: reduce recent_form (small sample). Late: boost recent_form."""
    if phase == "early":
        return {"recent_form": -0.04, "team_strength": 0.03, "starting_pitcher": 0.01}
    elif phase == "late":
        return {"recent_form": 0.03, "bullpen": 0.02, "team_strength": -0.03, "home_field": -0.02}
    return {}


def determine_seasonal_phase(game_date: date | None) -> str:
    """Classify the seasonal phase from game date."""
    if game_date is None:
        return "mid"

    month = game_date.month
    if month <= 4:
        return "early"
    elif month >= 8:
        return "late"
    return "mid"


def classify_park_type(park_run_factor: float | None) -> str:
    """Classify park as pitcher_park, hitter_park, or neutral."""
    if park_run_factor is None:
        return "neutral"

    factor = safe_float(park_run_factor, 100.0)
    if factor >= 105:
        return "hitter_park"
    elif factor <= 95:
        return "pitcher_park"
    return "neutral"


class SituationalWeightEngine:
    """Computes game-specific weight adjustments from context."""

    def __init__(self, base_weights: dict[str, float] | None = None) -> None:
        self.base_weights = base_weights or BASE_WEIGHTS.copy()

    def compute_weights(self, situation: GameSituation) -> dict[str, float]:
        """Return adjusted weights for the given game situation."""
        weights = self.base_weights.copy()

        park_adj = _park_adjustment(situation.park_type)
        opener_adj = _opener_adjustment(situation.opener_detected, situation.short_start_projected)
        season_adj = _seasonal_adjustment(situation.seasonal_phase)

        combined: dict[str, float] = {}
        for adj in (park_adj, opener_adj, season_adj):
            for key, value in adj.items():
                combined[key] = combined.get(key, 0.0) + value

        for key in combined:
            combined[key] = clamp(combined[key], -MAX_SHIFT, MAX_SHIFT)

        return _apply_shift(weights, combined)

    def compute_weights_from_context(
        self,
        park_run_factor: float | None = None,
        opener_detected: bool = False,
        short_start_projected: bool = False,
        game_date: date | str | datetime | None = None,
    ) -> dict[str, float]:
        """Convenience method that builds GameSituation from raw inputs."""
        if isinstance(game_date, str):
            try:
                parsed_date = datetime.fromisoformat(game_date.replace("Z", "+00:00")).date()
            except (ValueError, TypeError):
                parsed_date = None
        elif isinstance(game_date, datetime):
            parsed_date = game_date.date()
        elif isinstance(game_date, date):
            parsed_date = game_date
        else:
            parsed_date = None

        situation = GameSituation(
            park_type=classify_park_type(park_run_factor),
            opener_detected=opener_detected,
            short_start_projected=short_start_projected,
            seasonal_phase=determine_seasonal_phase(parsed_date),
            game_date=parsed_date,
        )
        return self.compute_weights(situation)
