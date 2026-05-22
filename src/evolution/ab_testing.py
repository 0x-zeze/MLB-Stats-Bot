"""A/B testing framework for parallel model variant evaluation."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from ..utils import safe_float


@dataclass
class ModelVariant:
    """A model variant for A/B testing."""

    variant_id: str
    weights: dict[str, float]
    description: str
    created_date: str = ""


@dataclass
class ABTestResult:
    """Result of an A/B test evaluation."""

    variant_a: str
    variant_b: str
    games_evaluated: int
    variant_a_brier: float
    variant_b_brier: float
    variant_a_roi: float
    variant_b_roi: float
    winner: str | None = None
    confidence_level: float = 0.0


class ABTestingFramework:
    """Framework for running parallel model variants and comparing performance."""

    MIN_GAMES_PER_VARIANT = 25

    def __init__(self) -> None:
        self.variants: dict[str, ModelVariant] = {}
        self.assignments: dict[str, str] = {}
        self.outcomes: dict[str, list[dict[str, Any]]] = {}

    def register_variant(self, variant: ModelVariant) -> None:
        """Register a model variant for testing."""
        self.variants[variant.variant_id] = variant
        if variant.variant_id not in self.outcomes:
            self.outcomes[variant.variant_id] = []

    def assign_game(self, game_id: str) -> str:
        """Deterministically assign a game to a variant.

        Uses hash-based assignment for reproducibility.
        """
        if game_id in self.assignments:
            return self.assignments[game_id]

        if len(self.variants) < 2:
            variant_ids = list(self.variants.keys())
            assigned = variant_ids[0] if variant_ids else ""
            self.assignments[game_id] = assigned
            return assigned

        variant_ids = sorted(self.variants.keys())
        hash_val = int(hashlib.md5(game_id.encode()).hexdigest(), 16)
        index = hash_val % len(variant_ids)
        assigned = variant_ids[index]
        self.assignments[game_id] = assigned
        return assigned

    def record_outcome(self, game_id: str, outcome: dict[str, Any]) -> None:
        """Record the outcome of a game for its assigned variant."""
        variant_id = self.assignments.get(game_id)
        if variant_id and variant_id in self.outcomes:
            self.outcomes[variant_id].append({
                "game_id": game_id,
                **outcome,
            })

    def evaluate(self) -> ABTestResult | None:
        """Evaluate the A/B test if sufficient data exists."""
        variant_ids = sorted(self.variants.keys())
        if len(variant_ids) < 2:
            return None

        variant_a = variant_ids[0]
        variant_b = variant_ids[1]

        outcomes_a = self.outcomes.get(variant_a, [])
        outcomes_b = self.outcomes.get(variant_b, [])

        if len(outcomes_a) < self.MIN_GAMES_PER_VARIANT or len(outcomes_b) < self.MIN_GAMES_PER_VARIANT:
            return None

        brier_a = _compute_brier(outcomes_a)
        brier_b = _compute_brier(outcomes_b)
        roi_a = _compute_roi(outcomes_a)
        roi_b = _compute_roi(outcomes_b)

        total_games = len(outcomes_a) + len(outcomes_b)

        winner = None
        confidence = 0.0
        brier_diff = abs(brier_a - brier_b)

        if brier_diff > 0.01:
            winner = variant_a if brier_a < brier_b else variant_b
            confidence = min(brier_diff * 20, 0.95)
        elif abs(roi_a - roi_b) > 0.02:
            winner = variant_a if roi_a > roi_b else variant_b
            confidence = min(abs(roi_a - roi_b) * 5, 0.80)

        return ABTestResult(
            variant_a=variant_a,
            variant_b=variant_b,
            games_evaluated=total_games,
            variant_a_brier=round(brier_a, 4),
            variant_b_brier=round(brier_b, 4),
            variant_a_roi=round(roi_a, 4),
            variant_b_roi=round(roi_b, 4),
            winner=winner,
            confidence_level=round(confidence, 3),
        )

    def get_variant_weights(self, variant_id: str) -> dict[str, float] | None:
        """Get the weights for a specific variant."""
        variant = self.variants.get(variant_id)
        return variant.weights if variant else None

    def reset(self) -> None:
        """Reset all test data."""
        self.variants.clear()
        self.assignments.clear()
        self.outcomes.clear()


def _compute_brier(outcomes: list[dict[str, Any]]) -> float:
    """Compute Brier score from outcomes."""
    if not outcomes:
        return 1.0

    total = 0.0
    for outcome in outcomes:
        prob = safe_float(outcome.get("predicted_probability", 0.5), 0.5)
        actual = 1.0 if outcome.get("correct", False) else 0.0
        total += (prob - actual) ** 2

    return total / len(outcomes)


def _compute_roi(outcomes: list[dict[str, Any]]) -> float:
    """Compute ROI from outcomes."""
    if not outcomes:
        return 0.0

    total_profit = sum(safe_float(o.get("profit_loss", 0.0), 0.0) for o in outcomes)
    total_wagered = sum(1.0 for o in outcomes if not o.get("no_bet", False))

    if total_wagered <= 0:
        return 0.0

    return total_profit / total_wagered
