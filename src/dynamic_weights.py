"""Dynamic weight engine that adapts prediction weights to game context.

Replaces the fixed situational weight adjustments with a game-mode-aware
system that detects the dominant dimension of a matchup and re-allocates
weight budgets accordingly.

Game modes
----------
PITCHER_DOMINATED : Both starters are aces, bullpens fresh, pitcher park.
BULLPEN_DOMINATED : Opener/bulk starter or exhausted bullpens dominate the game.
OFFENSE_DOMINATED : Hitter park / wind out / both starters weak.
BALANCED          : Default when none of the specialised modes fires.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from .utils import clamp, safe_float


# ---------------------------------------------------------------------------
# Game mode enum
# ---------------------------------------------------------------------------

class GameMode(str, Enum):
    PITCHER_DOMINATED = "PITCHER_DOMINATED"
    BULLPEN_DOMINATED = "BULLPEN_DOMINATED"
    OFFENSE_DOMINATED = "OFFENSE_DOMINATED"
    BALANCED = "BALANCED"


# ---------------------------------------------------------------------------
# Base weight tables — one per mode. Keys intentionally use the public names
# from the product spec: sp/log5/offense/bullpen/form/home.  The Python
# prediction layer maps them to internal component names at the integration
# boundary.
# ---------------------------------------------------------------------------

_WEIGHT_KEYS = ("sp", "log5", "offense", "bullpen", "form", "home")

BASE_WEIGHTS: dict[GameMode, dict[str, float]] = {
    GameMode.PITCHER_DOMINATED: {
        "sp": 0.40,
        "log5": 0.20,
        "offense": 0.18,
        "bullpen": 0.15,
        "form": 0.05,
        "home": 0.02,
    },
    GameMode.BULLPEN_DOMINATED: {
        "sp": 0.10,
        "log5": 0.25,
        "offense": 0.25,
        "bullpen": 0.30,
        "form": 0.08,
        "home": 0.02,
    },
    GameMode.OFFENSE_DOMINATED: {
        "sp": 0.15,
        "log5": 0.22,
        "offense": 0.35,
        "bullpen": 0.15,
        "form": 0.10,
        "home": 0.03,
    },
    GameMode.BALANCED: {
        "sp": 0.25,
        "log5": 0.30,
        "offense": 0.20,
        "bullpen": 0.10,
        "form": 0.10,
        "home": 0.05,
    },
}


# ---------------------------------------------------------------------------
# Mode detection
# ---------------------------------------------------------------------------

def _detect_game_mode(ctx: dict[str, Any]) -> GameMode:
    """Classify the game into one of four modes based on context signals."""

    sp_home_score = safe_float(ctx.get("sp_home_score"), 0.50)
    sp_away_score = safe_float(ctx.get("sp_away_score"), 0.50)
    bp_home_fatigue = str(ctx.get("bullpen_home_fatigue", "low")).lower()
    bp_away_fatigue = str(ctx.get("bullpen_away_fatigue", "low")).lower()
    park_factor = safe_float(ctx.get("park_factor_runs"), 1.0)
    wind_out = bool(ctx.get("weather_wind_out", False))

    both_aces = sp_home_score > 0.75 and sp_away_score > 0.75
    bullpen_fresh = bp_home_fatigue != "high" and bp_away_fatigue != "high"
    pitcher_park = park_factor < 1.02

    any_opener = sp_home_score < 0.45 or sp_away_score < 0.45
    any_bp_high = bp_home_fatigue == "high" or bp_away_fatigue == "high"

    both_sp_weak = sp_home_score < 0.45 and sp_away_score < 0.45
    hitter_park = park_factor > 1.08

    # Priority: specific run-environment modes first.  When both starters are
    # weak *and* the run environment is boosted (hitter park / wind out), the
    # game is offense-dominated rather than bullpen-dominated; bullpen mode is
    # for one-side opener/bulk situations or explicit fatigue flags.
    if both_aces and bullpen_fresh and pitcher_park:
        return GameMode.PITCHER_DOMINATED

    if (hitter_park or wind_out) and both_sp_weak:
        return GameMode.OFFENSE_DOMINATED

    if any_opener or any_bp_high:
        return GameMode.BULLPEN_DOMINATED

    return GameMode.BALANCED


# ---------------------------------------------------------------------------
# Micro-adjustments
# ---------------------------------------------------------------------------

def _apply_micro_adjustments(
    weights: dict[str, float],
    ctx: dict[str, Any],
) -> tuple[dict[str, float], list[str]]:
    """Apply small, additive adjustments to the base weights.

    Returns the adjusted (un-normalised) weights and a list of labels for
    every adjustment that actually fired.
    """
    w = dict(weights)
    applied: list[str] = []

    # --- SP not confirmed ---
    if not ctx.get("sp_home_confirmed", True):
        w["sp"] = max(0.01, w["sp"] - 0.08)
        w["bullpen"] += 0.08
        applied.append("sp_home_unconfirmed_penalty")
    if not ctx.get("sp_away_confirmed", True):
        w["sp"] = max(0.01, w["sp"] - 0.08)
        w["bullpen"] += 0.08
        applied.append("sp_away_unconfirmed_penalty")

    # --- Lineup not confirmed ---
    if not ctx.get("lineup_home_confirmed", True):
        w["offense"] = max(0.01, w["offense"] - 0.06)
        w["log5"] += 0.06
        applied.append("lineup_home_unconfirmed_penalty")
    if not ctx.get("lineup_away_confirmed", True):
        w["offense"] = max(0.01, w["offense"] - 0.06)
        w["log5"] += 0.06
        applied.append("lineup_away_unconfirmed_penalty")

    # --- IL count > 2 for either team ---
    il_home = int(ctx.get("il_home_count", 0))
    il_away = int(ctx.get("il_away_count", 0))
    if il_home > 2:
        penalty = 0.04
        w["offense"] = max(0.01, w["offense"] - penalty)
        w["log5"] += penalty
        applied.append(f"il_home_high({il_home})")
    if il_away > 2:
        penalty = 0.04
        w["offense"] = max(0.01, w["offense"] - penalty)
        w["log5"] += penalty
        applied.append(f"il_away_high({il_away})")

    # --- Bullpen fatigue HIGH ---
    bp_home = str(ctx.get("bullpen_home_fatigue", "low")).lower()
    bp_away = str(ctx.get("bullpen_away_fatigue", "low")).lower()
    if bp_home == "high":
        w["bullpen"] += 0.05
        w["sp"] = max(0.01, w["sp"] - 0.05)
        applied.append("bullpen_home_fatigue_high")
    if bp_away == "high":
        w["bullpen"] += 0.05
        w["sp"] = max(0.01, w["sp"] - 0.05)
        applied.append("bullpen_away_fatigue_high")

    return w, applied


# ---------------------------------------------------------------------------
# Normalise weights so they sum to exactly 1.0
# ---------------------------------------------------------------------------

def _normalise(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        # Fallback: uniform
        n = len(weights)
        return {k: 1.0 / n for k in weights}
    return {k: round(v / total, 6) for k, v in weights.items()}


# ---------------------------------------------------------------------------
# Confidence modifier — how much we trust our own prediction given unknowns
# ---------------------------------------------------------------------------

def _confidence_modifier(ctx: dict[str, Any], adjustments: list[str]) -> float:
    """Return a multiplier in [0.80, 1.0] that reflects uncertainty.

    Each uncertainty source subtracts a small amount. More unknowns ⇒ lower
    modifier ⇒ narrower probability bands (closer to 50%).
    """
    mod = 1.0

    if not ctx.get("sp_home_confirmed", True):
        mod -= 0.04
    if not ctx.get("sp_away_confirmed", True):
        mod -= 0.04
    if not ctx.get("lineup_home_confirmed", True):
        mod -= 0.03
    if not ctx.get("lineup_away_confirmed", True):
        mod -= 0.03

    il_total = int(ctx.get("il_home_count", 0)) + int(ctx.get("il_away_count", 0))
    if il_total > 4:
        mod -= 0.02

    bp_high_count = sum(
        1 for f in ("bullpen_home_fatigue", "bullpen_away_fatigue")
        if str(ctx.get(f, "low")).lower() == "high"
    )
    mod -= bp_high_count * 0.02

    return clamp(mod, 0.80, 1.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def calculate_dynamic_weights(game_context: dict[str, Any]) -> dict[str, Any]:
    """Calculate game-mode–aware prediction weights.

    Parameters
    ----------
    game_context : dict
        Keys expected (all optional with sensible defaults):
        - sp_home_confirmed, sp_away_confirmed : bool
        - sp_home_score, sp_away_score : float (0-1)
        - bullpen_home_fatigue, bullpen_away_fatigue : "low"|"medium"|"high"
        - park_factor_runs : float (league avg = 1.0)
        - weather_wind_out : bool
        - lineup_home_confirmed, lineup_away_confirmed : bool
        - il_home_count, il_away_count : int

    Returns
    -------
    dict with keys:
        mode              – str  (e.g. "PITCHER_DOMINATED")
        weights           – dict[str, float]  summing to 1.0
        adjustments_applied – list[str]
        confidence_modifier – float  in [0.80, 1.0]
    """
    ctx = game_context or {}
    mode = _detect_game_mode(ctx)
    base = BASE_WEIGHTS[mode].copy()
    adjusted, applied = _apply_micro_adjustments(base, ctx)
    normalised = _normalise(adjusted)
    conf = _confidence_modifier(ctx, applied)

    return {
        "mode": mode.value,
        "weights": normalised,
        "adjustments_applied": applied,
        "confidence_modifier": round(conf, 4),
    }
