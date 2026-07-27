"""Data freshness checks for MLB prediction inputs."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .temporal_contract import check_data_freshness as _check_data_freshness


def check_data_freshness(
    data_timestamp: Any,
    max_age_minutes: int | float,
    now: datetime | None = None,
) -> str:
    """Return fresh, stale, missing, or invalid_future for a timestamp.

    Future timestamps beyond a small clock-skew allowance are invalid_future,
    never fresh.
    """
    return _check_data_freshness(data_timestamp, max_age_minutes, now=now)
