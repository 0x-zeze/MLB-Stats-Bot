"""Markov chain run expectancy matrix for live in-game adjustment.

Uses base-out states (8 states: 3 bases × 3 outs minus 3-out absorbing)
to estimate expected runs for the remainder of an inning.

States are encoded as (first, second, third, outs) tuples.
This module provides:
- RE matrix: expected runs from each base-out state to end of inning
- Live win probability update given current inning state
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float

# Approximate run expectancy matrix ( empirical MLB averages 2010-2019)
# Indexed by (outs, base_state) where base_state is 0-7:
#   0=empty, 1=1B, 2=2B, 3=3B, 4=1B+2B, 5=1B+3B, 6=2B+3B, 7=loaded
RUN_EXPECTANCY = [
    # 0 outs
    [0.461, 0.831, 1.068, 1.426, 1.373, 1.738, 1.964, 2.284],
    # 1 out
    [0.243, 0.489, 0.650, 0.879, 0.882, 1.064, 1.197, 1.514],
    # 2 outs
    [0.095, 0.214, 0.292, 0.357, 0.357, 0.422, 0.470, 0.582],
]


def base_state_index(first: bool, second: bool, third: bool) -> int:
    return (1 if first else 0) + (2 if second else 0) + (4 if third else 0)


def run_expectancy(first: bool, second: bool, third: bool, outs: int) -> float:
    """Expected runs from current base-out state to end of inning."""
    outs_clamped = clamp(outs, 0, 2)
    state = base_state_index(first, second, third)
    return RUN_EXPECTANCY[outs_clamped][state]


@dataclass
class LiveGameState:
    """Current state of a live game for win probability update."""

    inning: int = 1
    is_top: bool = True
    outs: int = 0
    first: bool = False
    second: bool = False
    third: bool = False
    home_score: int = 0
    away_score: int = 0
    home_pitcher_advantage: float = 0.0  # -1..1, positive = home pitching better


def inning_run_expectancy(state: LiveGameState) -> float:
    """Expected runs for the batting team in the current half-inning."""
    return run_expectancy(state.first, state.second, state.third, state.outs)


def remaining_innings_expected_runs(
    state: LiveGameState,
    avg_runs_per_inning: float = 0.52,
) -> tuple[float, float]:
    """Estimate expected runs for each team for the rest of the game.

    Returns (away_remaining, home_remaining).
    """
    total_innings = 9
    current_inning = clamp(state.inning, 1, 20)

    if state.is_top:
        away_half_remaining = 1.0 - state.outs / 3.0
        home_innings_remaining = max(0, total_innings - current_inning)
        away_innings_remaining = max(0, total_innings - current_inning) + away_half_remaining
    else:
        home_half_remaining = 1.0 - state.outs / 3.0
        away_innings_remaining = max(0, total_innings - current_inning)
        home_innings_remaining = max(0, total_innings - current_inning - 1) + home_half_remaining

    current_half_runs = inning_run_expectancy(state)

    if state.is_top:
        away_expected = away_innings_remaining * avg_runs_per_inning + current_half_runs
        home_expected = home_innings_remaining * avg_runs_per_inning
    else:
        away_expected = away_innings_remaining * avg_runs_per_inning
        home_expected = home_innings_remaining * avg_runs_per_inning + current_half_runs

    return away_expected, home_expected


def live_win_probability(
    state: LiveGameState,
    pre_game_home_prob: float = 0.5,
    avg_runs_per_inning: float = 0.52,
) -> float:
    """Estimate home win probability from a live game state.

    Combines current score with expected remaining runs and the pre-game
    probability as a Bayesian prior.
    """
    away_remaining, home_remaining = remaining_innings_expected_runs(state, avg_runs_per_inning)

    projected_away_final = state.away_score + away_remaining
    projected_home_final = state.home_score + home_remaining

    run_diff = projected_home_final - projected_away_final
    # Convert run differential to win probability via logistic
    # ~0.15 probability change per run in late innings
    innings_elapsed = clamp(state.inning - 1, 0, 8)
    leverage = 1.0 + innings_elapsed * 0.12
    live_prob = 1.0 / (1.0 + 2.71828 ** (-run_diff * 0.35 * leverage))

    # Blend with pre-game probability (Bayesian shrinkage)
    # More weight to live data as game progresses
    live_weight = clamp(innings_elapsed / 8.0, 0.1, 0.85)
    blended = pre_game_home_prob * (1.0 - live_weight) + live_prob * live_weight

    return clamp(blended, 0.01, 0.99)


def parse_boxscore_state(
    inning: int,
    is_top: bool,
    outs: int,
    bases: list[bool] | None,
    home_score: int,
    away_score: int,
) -> LiveGameState:
    """Build a LiveGameState from API boxscore fields."""
    bases = bases or []
    return LiveGameState(
        inning=clamp(inning, 1, 20),
        is_top=is_top,
        outs=clamp(outs, 0, 3),
        first=bool(bases[0]) if len(bases) > 0 else False,
        second=bool(bases[1]) if len(bases) > 1 else False,
        third=bool(bases[2]) if len(bases) > 2 else False,
        home_score=home_score,
        away_score=away_score,
    )
