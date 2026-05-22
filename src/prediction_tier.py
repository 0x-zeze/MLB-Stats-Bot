"""Tiered prediction timing for MLB predictions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .utils import clamp, safe_float


TIER_RULES = {
    "early_preview": {"hours_before": 6.0, "confidence_cap": 0.60, "label": "Early Preview"},
    "standard": {"hours_before": 2.0, "confidence_cap": 0.85, "label": "Standard"},
    "final": {"hours_before": 0.0, "confidence_cap": 0.95, "label": "Final Prediction"},
}


@dataclass(frozen=True)
class PredictionTier:
    """Prediction timing tier with constraints."""

    tier: str = "standard"
    hours_to_game: float = 3.0
    confidence_cap: float = 0.85
    lineup_confirmed: bool = False
    pitcher_confirmed: bool = True
    data_completeness: float = 0.5
    refresh_recommended: bool = False
    label: str = "Standard"


def determine_prediction_tier(
    game_start_time: datetime | str | None,
    current_time: datetime | None = None,
    lineup_confirmed: bool = False,
    pitcher_confirmed: bool = True,
) -> PredictionTier:
    """Classify prediction timing tier and set confidence constraints."""
    if current_time is None:
        current_time = datetime.now(timezone.utc)

    if game_start_time is None:
        return PredictionTier(
            tier="standard",
            hours_to_game=3.0,
            confidence_cap=0.85,
            lineup_confirmed=lineup_confirmed,
            pitcher_confirmed=pitcher_confirmed,
            label="Standard",
        )

    if isinstance(game_start_time, str):
        try:
            game_start_time = datetime.fromisoformat(game_start_time.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return PredictionTier(tier="standard", label="Standard")

    if game_start_time.tzinfo is None:
        game_start_time = game_start_time.replace(tzinfo=timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    hours_to_game = max(0.0, (game_start_time - current_time).total_seconds() / 3600.0)

    if hours_to_game >= 6.0:
        tier = "early_preview"
        confidence_cap = TIER_RULES["early_preview"]["confidence_cap"]
        label = TIER_RULES["early_preview"]["label"]
    elif hours_to_game >= 2.0:
        tier = "standard"
        confidence_cap = TIER_RULES["standard"]["confidence_cap"]
        label = TIER_RULES["standard"]["label"]
    else:
        tier = "final"
        confidence_cap = TIER_RULES["final"]["confidence_cap"]
        label = TIER_RULES["final"]["label"]

    if not pitcher_confirmed:
        confidence_cap = min(confidence_cap, 0.55)

    if tier == "final" and not lineup_confirmed:
        confidence_cap = min(confidence_cap, 0.75)

    data_completeness = _estimate_data_completeness(
        hours_to_game, lineup_confirmed, pitcher_confirmed
    )

    refresh_recommended = (
        tier == "early_preview"
        or (tier == "standard" and not lineup_confirmed and hours_to_game < 3.0)
    )

    return PredictionTier(
        tier=tier,
        hours_to_game=round(hours_to_game, 2),
        confidence_cap=confidence_cap,
        lineup_confirmed=lineup_confirmed,
        pitcher_confirmed=pitcher_confirmed,
        data_completeness=data_completeness,
        refresh_recommended=refresh_recommended,
        label=label,
    )


def _estimate_data_completeness(
    hours_to_game: float,
    lineup_confirmed: bool,
    pitcher_confirmed: bool,
) -> float:
    """Estimate how complete the available data is (0-1)."""
    base = 0.4

    if pitcher_confirmed:
        base += 0.25
    if lineup_confirmed:
        base += 0.20

    time_bonus = clamp((6.0 - hours_to_game) * 0.025, 0.0, 0.15)
    base += time_bonus

    return clamp(base, 0.2, 1.0)


def should_refresh_prediction(
    original_tier: PredictionTier,
    current_tier: PredictionTier,
    lineup_changed: bool = False,
    pitcher_changed: bool = False,
) -> bool:
    """Return True if prediction should be regenerated."""
    if pitcher_changed:
        return True

    if lineup_changed and current_tier.tier in ("standard", "final"):
        return True

    tier_order = {"early_preview": 0, "standard": 1, "final": 2}
    original_rank = tier_order.get(original_tier.tier, 0)
    current_rank = tier_order.get(current_tier.tier, 0)

    if current_rank > original_rank:
        return True

    if not original_tier.lineup_confirmed and current_tier.lineup_confirmed:
        return True

    return False


def apply_tier_confidence_cap(
    confidence: str,
    tier: PredictionTier,
) -> str:
    """Apply tier-specific confidence cap to a prediction confidence level."""
    confidence_values = {"Low": 0.55, "Medium": 0.65, "High": 0.75}
    current_value = confidence_values.get(confidence, 0.55)

    if tier.confidence_cap <= 0.60:
        return "Low"
    elif tier.confidence_cap <= 0.85 and confidence == "High":
        return "Medium"

    return confidence
