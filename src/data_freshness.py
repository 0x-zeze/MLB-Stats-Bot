"""Data freshness checks for MLB prediction inputs."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _parse_timestamp(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def check_data_freshness(
    data_timestamp: Any,
    max_age_minutes: int | float,
    now: datetime | None = None,
) -> str:
    """Return fresh, stale, or missing for a timestamp."""
    parsed = _parse_timestamp(data_timestamp)
    if parsed is None:
        return "missing"

    current = now or datetime.now(timezone.utc)
    current = current if current.tzinfo else current.replace(tzinfo=timezone.utc)
    age_minutes = (current - parsed).total_seconds() / 60.0
    return "fresh" if age_minutes <= float(max_age_minutes) else "stale"

