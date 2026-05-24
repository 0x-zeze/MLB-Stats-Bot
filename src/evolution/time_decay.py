"""Time decay for evolution lessons and memory."""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

from ..utils import safe_float


DEFAULT_HALF_LIFE_DAYS = 90
AUDIT_HALF_LIFE_DAYS = 60


def decay_lesson_weight(
    lesson_date: str | datetime,
    current_date: str | datetime | None = None,
    half_life_days: int = DEFAULT_HALF_LIFE_DAYS,
) -> float:
    """Return 0-1 weight for a lesson based on age.

    Uses exponential decay with configurable half-life.
    April lessons decay significantly by September (90-day half-life).
    """
    lesson_dt = _parse_date(lesson_date)
    if lesson_dt is None:
        return 0.5

    if current_date is None:
        current_dt = datetime.now()
    else:
        current_dt = _parse_date(current_date)
        if current_dt is None:
            current_dt = datetime.now()

    days_old = max(0.0, (current_dt - lesson_dt).total_seconds() / 86400.0)

    if days_old <= 0:
        return 1.0

    decay = math.exp(-math.log(2) * days_old / max(half_life_days, 1))

    return max(0.01, min(1.0, decay))


def apply_time_decay_to_lessons(
    lessons: list[dict[str, Any]],
    current_date: str | datetime | None = None,
    half_life_days: int = DEFAULT_HALF_LIFE_DAYS,
    min_weight: float = 0.05,
) -> list[dict[str, Any]]:
    """Apply time decay weights to a list of lessons.

    Returns lessons with an added 'decay_weight' field.
    Filters out lessons below min_weight threshold.
    """
    result = []
    for lesson in lessons:
        date_field = lesson.get("date", lesson.get("created_at", lesson.get("timestamp")))
        if not date_field:
            result.append({**lesson, "decay_weight": 0.5})
            continue

        weight = decay_lesson_weight(date_field, current_date, half_life_days)

        if weight >= min_weight:
            result.append({**lesson, "decay_weight": round(weight, 4)})

    return result


def weighted_lesson_relevance(
    lessons: list[dict[str, Any]],
    pattern_key: str,
    current_date: str | datetime | None = None,
    half_life_days: int = DEFAULT_HALF_LIFE_DAYS,
) -> float:
    """Compute time-weighted relevance score for lessons matching a pattern.

    Returns 0-1 where higher = more recent/relevant lessons match this pattern.
    """
    matching = [
        l for l in lessons
        if l.get("pattern", l.get("pattern_key", "")) == pattern_key
    ]

    if not matching:
        return 0.0

    total_weight = 0.0
    for lesson in matching:
        date_field = lesson.get("date", lesson.get("created_at", lesson.get("timestamp")))
        if date_field:
            total_weight += decay_lesson_weight(date_field, current_date, half_life_days)
        else:
            total_weight += 0.5

    return min(1.0, total_weight / max(len(matching), 1))


def decay_row_weight(
    row: dict[str, Any],
    current_date: str | datetime | None = None,
    half_life_days: int = AUDIT_HALF_LIFE_DAYS,
) -> float:
    """Return 0-1 decay weight for an evaluation/outcome row.

    Looks for date in common row fields: date, game_date, timestamp.
    Uses shorter half-life (60 days) suited for audit recency weighting.
    """
    date_field = row.get("date") or row.get("game_date") or row.get("timestamp") or row.get("created_at")
    if not date_field:
        return 0.5
    return decay_lesson_weight(date_field, current_date, half_life_days)


def _parse_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
