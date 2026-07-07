"""Lineup order optimization via Markov chain run expectancy.

The order in which batters hit affects run expectancy. A lineup that
maximizes OBP at the top and power in the middle scores more runs
than a random arrangement. This module estimates the run expectancy
of a given lineup order using a simplified Markov chain.

Base-out states transition based on batter outcome probabilities
(walk, single, double, triple, HR, out). We simulate the expected
runs for a full game (27 outs) given a 9-batter lineup.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float

# Base state: 8 combinations (0-7)
# 0=empty, 1=1B, 2=2B, 3=3B, 4=1B+2B, 5=1B+3B, 6=2B+3B, 7=loaded


@dataclass
class BatterProfile:
    """Simplified batter outcome probabilities."""

    name: str = ""
    obp: float = 0.320  # on-base probability (non-out)
    single_rate: float = 0.15  # P(single | PA)
    double_rate: float = 0.05
    triple_rate: float = 0.005
    hr_rate: float = 0.03
    walk_rate: float = 0.08
    k_rate: float = 0.22
    avg: float = 0.250
    slg: float = 0.400
    wrc_plus: float = 100.0


def _outcome_probabilities(batter: BatterProfile) -> dict[str, float]:
    """Return outcome probabilities for a plate appearance."""
    out_rate = clamp(1.0 - batter.obp, 0.3, 0.8)
    # Normalize non-out outcomes to their relative rates
    total_non_out = batter.single_rate + batter.double_rate + batter.triple_rate + batter.hr_rate + batter.walk_rate
    if total_non_out <= 0:
        return {"out": 1.0}

    scale = (1.0 - out_rate) / total_non_out
    return {
        "out": out_rate,
        "walk": batter.walk_rate * scale,
        "single": batter.single_rate * scale,
        "double": batter.double_rate * scale,
        "triple": batter.triple_rate * scale,
        "hr": batter.hr_rate * scale,
    }


# Transition table: (base_state, outcome) -> (new_base_state, runs_scored)
# base_state is 0-7, outcome is one of the keys above
def _transition(base_state: int, outcome: str) -> tuple[int, float]:
    """Return (new_base_state, runs_scored) for a base-outcome combo."""
    first = bool(base_state & 1)
    second = bool(base_state & 2)
    third = bool(base_state & 4)

    if outcome == "out":
        return base_state, 0.0

    if outcome == "hr":
        runs = 1.0 + (1 if first else 0) + (1 if second else 0) + (1 if third else 0)
        return 0, runs

    if outcome == "walk":
        # Force advancement only if bases are loaded behind
        if first and second and third:
            return 7, 1.0  # bases loaded walk forces in a run
        if first and second:
            return 7, 0.0  # 1B+2B+3B
        if first:
            return base_state | 2, 0.0  # add second base
        return base_state | 1, 0.0  # add first base

    if outcome == "single":
        runs = 1.0 if third else 0.0
        # Runner on second often scores on single, runner on first to second/third
        if second:
            runs += 0.6
        new_first = True
        new_second = first
        new_third = False
        if second and not first:
            new_second = False
        new_state = (1 if new_first else 0) + (2 if new_second else 0) + (4 if new_third else 0)
        return new_state, runs

    if outcome == "double":
        runs = 1.0 if third else 0.0
        runs += 1.0 if second else 0.0
        new_first = False
        new_second = True
        new_third = first
        new_state = (1 if new_first else 0) + (2 if new_second else 0) + (4 if new_third else 0)
        return new_state, runs

    if outcome == "triple":
        runs = 1.0 + (1 if first else 0) + (1 if second else 0) + (1 if third else 0)
        return 4, runs  # runner on third only

    return base_state, 0.0


def simulate_inning(lineup: list[BatterProfile], start_idx: int = 0) -> tuple[float, int]:
    """Simulate one inning. Returns (expected_runs, next_batter_idx).

    Uses an analytic expected-value approach: each PA contributes its
    probability-weighted runs, and outs accumulate as the expected out
    probability. The inning ends when cumulative outs reach 3.
    """
    state = 0  # empty bases
    runs = 0.0
    cumulative_outs = 0.0
    idx = start_idx
    lineup_len = len(lineup)
    pa_count = 0

    while cumulative_outs < 3.0 and pa_count < 15:
        batter = lineup[idx % lineup_len]
        probs = _outcome_probabilities(batter)

        # Expected runs from this PA
        pa_runs = 0.0
        state_transitions: dict[int, float] = {}
        out_prob = probs.get("out", 0.0)

        for outcome, prob in probs.items():
            new_state, r = _transition(state, outcome)
            pa_runs += prob * r
            state_transitions[new_state] = state_transitions.get(new_state, 0.0) + prob

        runs += pa_runs
        cumulative_outs += out_prob

        # Transition to most likely non-out state (base advancement)
        if state_transitions:
            state = max(state_transitions, key=state_transitions.get)

        idx += 1
        pa_count += 1

    return runs, idx % lineup_len


def lineup_run_expectancy(lineup: list[BatterProfile], innings: int = 9) -> float:
    """Estimate total runs for a full game given a lineup order.

    Uses a simplified simulation that approximates the Markov chain
    run expectancy. Returns expected total runs.
    """
    if len(lineup) < 9:
        return 4.4  # league average fallback

    total_runs = 0.0
    idx = 0
    for _ in range(innings):
        inning_runs, idx = simulate_inning(lineup, idx)
        total_runs += inning_runs

    return clamp(total_runs, 1.0, 20.0)


def lineup_order_efficiency(lineup: list[BatterProfile]) -> float:
    """Return 0-1 efficiency score for the lineup order.

    Compares the lineup's run expectancy to an optimal arrangement.
    Optimal: highest OBP at 1-2, best power (SLG) at 3-5, rest by OBP desc.
    """
    if len(lineup) < 9:
        return 0.5

    actual = lineup_run_expectancy(lineup)

    # Build "optimal" order
    by_obp = sorted(lineup, key=lambda b: -b.obp)
    by_slg = sorted(lineup, key=lambda b: -b.slg)

    optimal = [
        by_obp[0],  # leadoff: highest OBP
        by_obp[1],  # 2-hole: second highest OBP
        by_slg[0],  # 3-hole: best power
        by_slg[1],  # cleanup: second best power
        by_obp[2],  # 5-hole: third best OBP
        by_slg[2],  # 6-hole: third best power
        by_obp[3],  # 7-hole
        by_obp[4],  # 8-hole
        by_obp[5],  # 9-hole
    ]

    optimal_runs = lineup_run_expectancy(optimal)

    if optimal_runs <= 0:
        return 0.5

    ratio = actual / optimal_runs
    return clamp(ratio, 0.0, 1.0)


def build_batter_profile(
    name: str,
    stats: dict[str, Any] | None = None,
) -> BatterProfile:
    """Build a BatterProfile from a stats dict."""
    stats = stats or {}
    return BatterProfile(
        name=name,
        obp=safe_float(stats.get("obp", 0.320), 0.320),
        single_rate=safe_float(stats.get("single_rate", 0.15), 0.15),
        double_rate=safe_float(stats.get("double_rate", 0.05), 0.05),
        triple_rate=safe_float(stats.get("triple_rate", 0.005), 0.005),
        hr_rate=safe_float(stats.get("hr_rate", 0.03), 0.03),
        walk_rate=safe_float(stats.get("walk_rate", 0.08), 0.08),
        k_rate=safe_float(stats.get("k_rate", 0.22), 0.22),
        avg=safe_float(stats.get("avg", 0.250), 0.250),
        slg=safe_float(stats.get("slg", 0.400), 0.400),
        wrc_plus=safe_float(stats.get("wrc_plus", 100.0), 100.0),
    )
