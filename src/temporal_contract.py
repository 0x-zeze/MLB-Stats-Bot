"""UTC point-in-time temporal contract helpers (Python parity with JS)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

DEFAULT_CLOCK_SKEW_SECONDS = 120.0


def parse_utc(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts < 1e12:
            ts *= 1000.0
        return datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
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
    clock_skew_seconds: float = DEFAULT_CLOCK_SKEW_SECONDS,
) -> str:
    """Return fresh, stale, missing, or invalid_future for a timestamp."""
    parsed = parse_utc(data_timestamp)
    if parsed is None:
        return "missing"

    current = now or datetime.now(timezone.utc)
    current = current if current.tzinfo else current.replace(tzinfo=timezone.utc)

    delta_seconds = (parsed - current).total_seconds()
    if delta_seconds > float(clock_skew_seconds):
        return "invalid_future"

    age_minutes = (current - parsed).total_seconds() / 60.0
    if age_minutes < 0:
        return "fresh"
    return "fresh" if age_minutes <= float(max_age_minutes) else "stale"


def assert_pregame_eligible(
    *,
    observed_at: Any = None,
    effective_at: Any = None,
    as_of: Any = None,
    first_pitch: Any = None,
    clock_skew_seconds: float = DEFAULT_CLOCK_SKEW_SECONDS,
) -> dict[str, Any]:
    as_of_dt = parse_utc(as_of)
    if as_of_dt is None:
        return {"ok": False, "reason": "missing_as_of"}

    first_pitch_dt = parse_utc(first_pitch)
    if first_pitch_dt is not None:
        if (as_of_dt - first_pitch_dt).total_seconds() > float(clock_skew_seconds):
            return {"ok": False, "reason": "as_of_after_first_pitch"}

    for label, value in (("observed_at", observed_at), ("effective_at", effective_at)):
        dt = parse_utc(value)
        if dt is None:
            continue
        if (dt - as_of_dt).total_seconds() > float(clock_skew_seconds):
            return {"ok": False, "reason": f"{label}_after_as_of"}
        if first_pitch_dt is not None and (dt - first_pitch_dt).total_seconds() > float(
            clock_skew_seconds
        ):
            return {"ok": False, "reason": f"{label}_after_first_pitch"}

    return {"ok": True, "reason": None}


def filter_splits_before_date(splits: list[dict[str, Any]] | None, as_of_date_ymd: str) -> list[dict[str, Any]]:
    if not as_of_date_ymd:
        return []
    cutoff = str(as_of_date_ymd)[:10]
    kept: list[dict[str, Any]] = []
    for split in splits or []:
        raw = (
            split.get("date")
            or split.get("gameDate")
            or (split.get("game") or {}).get("gameDate")
            or ""
        )
        day = str(raw)[:10]
        if day and day < cutoff:
            kept.append(split)
    return kept
