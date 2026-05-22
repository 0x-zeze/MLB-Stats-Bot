"""Lineup depth analysis: WAR replacement, batting order weighting, catcher impact."""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any

from .utils import clamp, safe_float


BATTING_ORDER_WEIGHTS = [0.14, 0.15, 0.15, 0.13, 0.11, 0.09, 0.08, 0.08, 0.07]

REPLACEMENT_LEVEL_WAR_PER_GAME = 0.0


@dataclass(frozen=True)
class LineupDepthContext:
    """Full lineup depth assessment inputs."""

    batting_order_wrc_plus: list[float] | None = None
    total_lineup_war: float = 0.0
    missing_player_wars: list[float] | None = None
    catcher_framing_runs: float = 0.0
    replacement_level_war: float = 0.0


def war_replacement_penalty(missing_wars: list[float] | None) -> float:
    """Penalty from missing players relative to replacement level.

    Each missing player's WAR above replacement represents lost production.
    A 4-WAR player missing is much worse than a 0.5-WAR player.
    """
    if not missing_wars:
        return 0.0

    total_lost = sum(max(0.0, w - REPLACEMENT_LEVEL_WAR_PER_GAME) for w in missing_wars)

    penalty = total_lost * 0.04
    return clamp(-penalty, -0.45, 0.0)


def batting_order_quality(order_wrc_plus: list[float] | None) -> float:
    """Weighted score emphasizing slots 2-4 over 7-9.

    Returns a -1 to 1 score where 0 = league average lineup quality.
    """
    if not order_wrc_plus or len(order_wrc_plus) < 4:
        return 0.0

    weights = BATTING_ORDER_WEIGHTS[:len(order_wrc_plus)]
    weight_sum = sum(weights)

    weighted_wrc = sum(
        w * wrc for w, wrc in zip(weights, order_wrc_plus)
    ) / max(weight_sum, 0.01)

    return clamp((weighted_wrc - 100.0) / 50.0, -1.0, 1.0)


def catcher_impact_factor(framing_runs: float) -> float:
    """Adjustment from catcher game-calling/framing proxy.

    Elite framers save ~15 runs/season (~0.1 runs/game).
    Poor framers cost ~10 runs/season.
    """
    return clamp(framing_runs * 0.008, -0.12, 0.15)


def top_of_order_concentration(order_wrc_plus: list[float] | None) -> float:
    """Measure how top-heavy the lineup is (0-1 scale).

    High concentration = vulnerable to early pitcher removal or bullpen matchups.
    """
    if not order_wrc_plus or len(order_wrc_plus) < 6:
        return 0.5

    top3_avg = mean(order_wrc_plus[:3])
    bottom_avg = mean(order_wrc_plus[3:])

    if bottom_avg <= 0:
        return 1.0

    ratio = top3_avg / max(bottom_avg, 1.0)
    return clamp(ratio / 2.5, 0.2, 1.0)


def enhanced_lineup_impact(context: LineupDepthContext) -> dict[str, Any]:
    """Full lineup depth assessment combining all factors.

    Returns a dict with:
    - impact_score: 0-1 (1 = elite full-strength lineup)
    - war_penalty: runs lost from missing players
    - order_quality: weighted batting order score
    - catcher_impact: framing/game-calling adjustment
    - top_heavy_factor: lineup concentration risk
    - total_adjustment: combined runs adjustment for prediction model
    """
    war_pen = war_replacement_penalty(context.missing_player_wars)
    order_qual = batting_order_quality(context.batting_order_wrc_plus)
    catcher_adj = catcher_impact_factor(context.catcher_framing_runs)
    top_heavy = top_of_order_concentration(context.batting_order_wrc_plus)

    total_adjustment = war_pen + (order_qual * 0.25) + catcher_adj

    base_quality = 0.5 + (order_qual * 0.3)
    missing_penalty = abs(war_pen)
    impact_score = clamp(base_quality - missing_penalty + catcher_adj * 0.5, 0.1, 1.0)

    return {
        "impact_score": round(impact_score, 3),
        "war_penalty": round(war_pen, 3),
        "order_quality": round(order_qual, 3),
        "catcher_impact": round(catcher_adj, 3),
        "top_heavy_factor": round(top_heavy, 3),
        "total_adjustment": round(clamp(total_adjustment, -0.60, 0.40), 3),
    }
