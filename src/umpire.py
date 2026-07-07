"""Umpire strike zone tendency adjustment for MLB predictions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


@dataclass(frozen=True)
class UmpireContext:
    """Umpire zone tendency and its impact on run environment."""

    umpire_name: str = ""
    zone_tendency: str = "neutral"  # "tight", "neutral", "wide"
    k_rate_adjustment: float = 0.0
    bb_rate_adjustment: float = 0.0
    run_factor: float = 1.0
    games_behind_plate: int = 0


def classify_zone_tendency(
    called_strike_rate_above_avg: float,
    walk_rate_above_avg: float,
) -> str:
    """Classify umpire zone from deviation above league average rates."""
    if called_strike_rate_above_avg >= 0.02:
        return "tight" if walk_rate_above_avg <= -0.005 else "neutral"
    if called_strike_rate_above_avg <= -0.02:
        return "wide" if walk_rate_above_avg >= 0.005 else "neutral"
    return "neutral"


def umpire_adjustment(umpire: UmpireContext | None) -> float:
    """Return total-runs adjustment from umpire zone tendency.

    Tight zone -> fewer walks, more strikeouts -> fewer runs (negative).
    Wide zone -> more walks, fewer strikeouts -> more runs (positive).
    """
    if umpire is None:
        return 0.0

    if umpire.games_behind_plate < 10:
        return 0.0

    zone = umpire.zone_tendency.lower()
    if zone == "tight":
        base = -0.25
    elif zone == "wide":
        base = 0.25
    else:
        base = 0.0

    run_factor_adj = (umpire.run_factor - 1.0) * 0.8
    k_impact = umpire.k_rate_adjustment * -1.5
    bb_impact = umpire.bb_rate_adjustment * 2.0

    return clamp(base + run_factor_adj + k_impact + bb_impact, -0.45, 0.45)


def umpire_pitcher_interaction(
    umpire: UmpireContext | None,
    pitcher_k_rate: float,
    pitcher_bb_rate: float,
) -> float:
    """Adjustment for how umpire zone interacts with pitcher style.

    A tight-zone umpire benefits high-K pitchers (more called strikes).
    A wide-zone umpire hurts control pitchers (walks increase).
    """
    if umpire is None or umpire.games_behind_plate < 10:
        return 0.0

    zone = umpire.zone_tendency.lower()
    if zone == "tight":
        k_bonus = (pitcher_k_rate - 0.22) * 0.8
        bb_bonus = (0.085 - pitcher_bb_rate) * 0.5
        return clamp(k_bonus + bb_bonus, -0.15, 0.20)
    elif zone == "wide":
        bb_penalty = (pitcher_bb_rate - 0.085) * 0.9
        k_penalty = (0.22 - pitcher_k_rate) * 0.4
        return clamp(bb_penalty + k_penalty, -0.20, 0.15)

    return 0.0


def build_umpire_context(umpire_data: dict[str, Any] | None) -> UmpireContext | None:
    """Build UmpireContext from raw umpire data dict."""
    if not umpire_data or not isinstance(umpire_data, dict):
        return None

    name = str(umpire_data.get("name", "") or "")
    if not name:
        return None

    games = int(safe_float(umpire_data.get("games_behind_plate", 0), 0))
    k_adj = safe_float(umpire_data.get("k_rate_adjustment", 0), 0.0)
    bb_adj = safe_float(umpire_data.get("bb_rate_adjustment", 0), 0.0)
    run_factor = safe_float(umpire_data.get("run_factor", 1.0), 1.0)

    zone = str(umpire_data.get("zone_tendency", "")).lower()
    if zone not in ("tight", "wide", "neutral"):
        # bb_adj already represents the deviation from league-average walk rate,
        # so pass it directly (negating it would flip tight/wide classification).
        zone = classify_zone_tendency(k_adj, bb_adj)

    return UmpireContext(
        umpire_name=name,
        zone_tendency=zone,
        k_rate_adjustment=k_adj,
        bb_rate_adjustment=bb_adj,
        run_factor=run_factor,
        games_behind_plate=games,
    )
