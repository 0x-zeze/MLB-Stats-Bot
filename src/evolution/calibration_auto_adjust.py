"""Calibration auto-adjustment for persistent miscalibration detection."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from ..utils import clamp, safe_float


MAX_ADJUSTMENT_PER_BUCKET = 0.02
MIN_SAMPLE_SIZE = 30
MIN_LOOKBACK_DAYS = 14


def detect_persistent_miscalibration(
    calibration_history: list[dict[str, Any]],
    bucket: str,
    lookback_days: int = MIN_LOOKBACK_DAYS,
    current_date: str | None = None,
) -> dict[str, Any] | None:
    """Detect if a probability bucket is consistently miscalibrated.

    Returns an adjustment proposal if the bucket has been off by more than
    2% for at least `lookback_days` consecutive days with sufficient sample.
    """
    if not calibration_history:
        return None

    now = _parse_date(current_date) if current_date else datetime.now()
    cutoff = now - timedelta(days=lookback_days)

    relevant = [
        entry for entry in calibration_history
        if entry.get("bucket") == bucket
        and _parse_date(entry.get("date")) is not None
        and _parse_date(entry.get("date")) >= cutoff
    ]

    if not relevant:
        return None

    total_predicted = 0.0
    total_actual = 0.0
    total_games = 0

    for entry in relevant:
        games = int(safe_float(entry.get("games", 0), 0))
        predicted = safe_float(entry.get("avg_predicted", 0.5), 0.5)
        actual = safe_float(entry.get("actual_win_rate", 0.5), 0.5)

        total_predicted += predicted * games
        total_actual += actual * games
        total_games += games

    if total_games < MIN_SAMPLE_SIZE:
        return None

    avg_predicted = total_predicted / total_games
    avg_actual = total_actual / total_games
    error = avg_predicted - avg_actual

    if abs(error) < 0.02:
        return None

    adjustment = clamp(-error * 0.5, -MAX_ADJUSTMENT_PER_BUCKET, MAX_ADJUSTMENT_PER_BUCKET)

    return {
        "bucket": bucket,
        "avg_predicted": round(avg_predicted, 4),
        "avg_actual": round(avg_actual, 4),
        "error": round(error, 4),
        "proposed_adjustment": round(adjustment, 4),
        "sample_size": total_games,
        "lookback_days": lookback_days,
        "production_update_allowed": False,
    }


def apply_calibration_adjustment(
    current_confidence_thresholds: dict[str, float],
    adjustment: dict[str, Any],
) -> dict[str, float]:
    """Apply a bounded calibration correction to confidence thresholds.

    This is the fast-path that bypasses the full promotion gate but
    still enforces bounded adjustments and minimum sample size.
    """
    if not adjustment or adjustment.get("sample_size", 0) < MIN_SAMPLE_SIZE:
        return current_confidence_thresholds

    proposed = safe_float(adjustment.get("proposed_adjustment"), 0.0)
    bounded = clamp(proposed, -MAX_ADJUSTMENT_PER_BUCKET, MAX_ADJUSTMENT_PER_BUCKET)

    if abs(bounded) < 0.005:
        return current_confidence_thresholds

    result = dict(current_confidence_thresholds)
    bucket = adjustment.get("bucket", "")

    if bucket in result:
        result[bucket] = clamp(result[bucket] + bounded, 0.01, 0.99)

    return result


def find_miscalibrated_buckets(
    calibration_history: list[dict[str, Any]],
    buckets: list[str] | None = None,
    lookback_days: int = MIN_LOOKBACK_DAYS,
    current_date: str | None = None,
) -> list[dict[str, Any]]:
    """Find all buckets with persistent miscalibration."""
    if buckets is None:
        buckets = [
            "50-55%", "55-60%", "60-65%", "65-70%", "70-75%", "75-80%"
        ]

    results = []
    for bucket in buckets:
        adjustment = detect_persistent_miscalibration(
            calibration_history, bucket, lookback_days, current_date
        )
        if adjustment is not None:
            results.append(adjustment)

    return results


def _parse_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
