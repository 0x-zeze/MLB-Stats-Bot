"""Parlay/correlated-picks bankroll adjustment.

When multiple picks on the same slate share correlated factors (same weather,
same park, same opponent), the aggregate risk is higher than the sum of
individual risks. This module detects correlation and adjusts stake.

Correlation sources:
- Same game (obvious: moneyline + total are correlated)
- Same weather system (multiple games in same city/region)
- Same park factor (Coors Field affects both teams)
- Same division rivalry (familiarity affects variance)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


@dataclass
class PickCorrelation:
    """Detected correlation between two picks."""

    pick_a_id: str
    pick_b_id: str
    correlation_type: str  # "same_game", "same_weather", "same_park", "same_division"
    correlation_strength: float = 0.0  # 0-1


def detect_pick_correlation(
    pick_a: dict[str, Any],
    pick_b: dict[str, Any],
) -> PickCorrelation | None:
    """Detect correlation between two betting picks."""
    a_id = str(pick_a.get("decision_id", pick_a.get("game_pk", "")))
    b_id = str(pick_b.get("decision_id", pick_b.get("game_pk", "")))

    # Same game
    a_game = str(pick_a.get("game_pk", ""))
    b_game = str(pick_b.get("game_pk", ""))
    if a_game and b_game and a_game == b_game:
        return PickCorrelation(
            pick_a_id=a_id,
            pick_b_id=b_id,
            correlation_type="same_game",
            correlation_strength=0.7,
        )

    # Same park (home team)
    a_home = str(pick_a.get("home_team", "")).upper()
    b_home = str(pick_b.get("home_team", "")).upper()
    if a_home and b_home and a_home == b_home:
        return PickCorrelation(
            pick_a_id=a_id,
            pick_b_id=b_id,
            correlation_type="same_park",
            correlation_strength=0.25,
        )

    # Same division
    a_div = str(pick_a.get("division", "")).upper()
    b_div = str(pick_b.get("division", "")).upper()
    if a_div and b_div and a_div == b_div:
        return PickCorrelation(
            pick_a_id=a_id,
            pick_b_id=b_id,
            correlation_type="same_division",
            correlation_strength=0.15,
        )

    # Same weather system (same city or nearby)
    a_weather = str(pick_a.get("weather_hash", "")).lower()
    b_weather = str(pick_b.get("weather_hash", "")).lower()
    if a_weather and b_weather and a_weather == b_weather:
        return PickCorrelation(
            pick_a_id=a_id,
            pick_b_id=b_id,
            correlation_type="same_weather",
            correlation_strength=0.20,
        )

    return None


def aggregate_correlation_risk(
    picks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Analyze a slate of picks for correlation risk.

    Returns:
        - correlation_matrix: list of PickCorrelation
        - aggregate_stake_multiplier: 0.7-1.0 (reduce stakes if correlated)
        - correlated_groups: list of pick groups that share correlation
        - warning: human-readable warning if risk is high
    """
    correlations: list[PickCorrelation] = []

    for i, pick_a in enumerate(picks):
        for j, pick_b in enumerate(picks):
            if i >= j:
                continue
            corr = detect_pick_correlation(pick_a, pick_b)
            if corr and corr.correlation_strength > 0:
                correlations.append(corr)

    if not correlations:
        return {
            "correlation_matrix": [],
            "aggregate_stake_multiplier": 1.0,
            "correlated_groups": [],
            "warning": "",
        }

    # Compute aggregate stake multiplier
    # Each strong correlation reduces the multiplier
    max_strength = max(c.correlation_strength for c in correlations)
    strong_count = sum(1 for c in correlations if c.correlation_strength >= 0.5)
    moderate_count = sum(1 for c in correlations if 0.2 <= c.correlation_strength < 0.5)

    reduction = max_strength * 0.15 + strong_count * 0.05 + moderate_count * 0.02
    multiplier = clamp(1.0 - reduction, 0.7, 1.0)

    # Build correlated groups
    groups: list[list[str]] = []
    pick_to_group: dict[str, int] = {}
    for corr in correlations:
        a_group = pick_to_group.get(corr.pick_a_id)
        b_group = pick_to_group.get(corr.pick_b_id)
        if a_group is None and b_group is None:
            pick_to_group[corr.pick_a_id] = len(groups)
            pick_to_group[corr.pick_b_id] = len(groups)
            groups.append([corr.pick_a_id, corr.pick_b_id])
        elif a_group is not None and b_group is None:
            groups[a_group].append(corr.pick_b_id)
            pick_to_group[corr.pick_b_id] = a_group
        elif a_group is None and b_group is not None:
            groups[b_group].append(corr.pick_a_id)
            pick_to_group[corr.pick_a_id] = b_group
        elif a_group is not None and b_group is not None and a_group != b_group:
            # Merge groups
            groups[a_group].extend(groups[b_group])
            for pid in groups[b_group]:
                pick_to_group[pid] = a_group
            groups[b_group] = []

    correlated_groups = [g for g in groups if g]

    warning = ""
    if max_strength >= 0.5 or strong_count >= 2:
        warning = "High correlation detected: stakes reduced to manage aggregate risk"
    elif max_strength >= 0.2:
        warning = "Moderate correlation detected: stakes slightly reduced"

    return {
        "correlation_matrix": [
            {
                "pick_a": c.pick_a_id,
                "pick_b": c.pick_b_id,
                "type": c.correlation_type,
                "strength": round(c.correlation_strength, 2),
            }
            for c in correlations
        ],
        "aggregate_stake_multiplier": round(multiplier, 3),
        "correlated_groups": correlated_groups,
        "warning": warning,
    }


def adjust_stakes_for_correlation(
    picks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return picks with adjusted stake_units based on correlation analysis."""
    analysis = aggregate_correlation_risk(picks)
    multiplier = safe_float(analysis.get("aggregate_stake_multiplier"), 1.0)

    adjusted = []
    for pick in picks:
        new_pick = dict(pick)
        original_stake = safe_float(pick.get("stake_units", pick.get("units_staked", 0)), 0)
        new_pick["adjusted_stake_units"] = round(original_stake * multiplier, 3)
        new_pick["stake_adjustment_reason"] = analysis.get("warning", "")
        adjusted.append(new_pick)

    return adjusted
