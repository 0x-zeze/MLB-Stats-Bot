"""Confidence calibration metrics for MLB predictions."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable

from .utils import clamp, safe_float


def brier_score(probabilities: Iterable[float], outcomes: Iterable[int]) -> float:
    """Return mean squared probability error."""
    pairs = list(zip(probabilities, outcomes))
    if not pairs:
        return 0.0
    return sum((clamp(safe_float(prob), 0.0, 1.0) - int(outcome)) ** 2 for prob, outcome in pairs) / len(pairs)


def log_loss(probabilities: Iterable[float], outcomes: Iterable[int], epsilon: float = 1e-15) -> float:
    """Return binary log loss with clipped probabilities."""
    pairs = list(zip(probabilities, outcomes))
    if not pairs:
        return 0.0
    total = 0.0
    for probability, outcome in pairs:
        clipped = clamp(safe_float(probability), epsilon, 1.0 - epsilon)
        total += int(outcome) * math.log(clipped) + (1 - int(outcome)) * math.log(1.0 - clipped)
    return -total / len(pairs)


def probability_bucket(probability: float, bucket_size: float = 0.05) -> str:
    """Return a readable probability bucket such as 55-60%."""
    clipped = clamp(safe_float(probability), 0.0, 1.0)
    lower = math.floor(clipped / bucket_size) * bucket_size
    upper = min(1.0, lower + bucket_size)
    return f"{int(round(lower * 100))}-{int(round(upper * 100))}%"


def confidence_bucket(probability: float) -> str:
    """Map probability edge to low/medium/high confidence."""
    edge = abs(safe_float(probability) - 0.5)
    if edge < 0.04:
        return "low"
    if edge < 0.10:
        return "medium"
    return "high"


def calibration_table(
    rows: list[dict[str, Any]],
    probability_key: str = "probability",
    outcome_key: str = "won",
    bucket_size: float = 0.05,
) -> list[dict[str, Any]]:
    """Build calibration rows grouped by probability bucket."""
    groups: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for row in rows:
        probability = clamp(safe_float(row.get(probability_key)), 0.0, 1.0)
        outcome = int(safe_float(row.get(outcome_key), 0.0))
        groups[probability_bucket(probability, bucket_size)].append((probability, outcome))

    table: list[dict[str, Any]] = []
    for bucket in sorted(groups, key=lambda value: int(value.split("-")[0])):
        values = groups[bucket]
        avg_probability = sum(prob for prob, _ in values) / len(values)
        actual_rate = sum(outcome for _, outcome in values) / len(values)
        table.append(
            {
                "bucket": bucket,
                "count": len(values),
                "avg_probability": avg_probability,
                "actual_rate": actual_rate,
                "calibration_error": actual_rate - avg_probability,
            }
        )
    return table


def calibration_by_confidence(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build calibration rows grouped by low/medium/high confidence."""
    groups: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for row in rows:
        probability = clamp(safe_float(row.get("probability")), 0.0, 1.0)
        outcome = int(safe_float(row.get("won"), 0.0))
        groups[confidence_bucket(probability)].append((probability, outcome))

    output = []
    for bucket in ("low", "medium", "high"):
        values = groups.get(bucket, [])
        if not values:
            output.append(
                {
                    "confidence": bucket,
                    "count": 0,
                    "avg_probability": 0.0,
                    "actual_rate": 0.0,
                    "calibration_error": 0.0,
                }
            )
            continue
        avg_probability = sum(prob for prob, _ in values) / len(values)
        actual_rate = sum(outcome for _, outcome in values) / len(values)
        output.append(
            {
                "confidence": bucket,
                "count": len(values),
                "avg_probability": avg_probability,
                "actual_rate": actual_rate,
                "calibration_error": actual_rate - avg_probability,
            }
        )
    return output

