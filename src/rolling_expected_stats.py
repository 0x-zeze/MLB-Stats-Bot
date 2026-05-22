"""Rolling expected stats (xwOBA, xSLG) from Statcast data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import mean
from typing import Any

from .utils import clamp, safe_float


@dataclass(frozen=True)
class RollingExpectedStats:
    """Team rolling expected stats over a window."""

    xwoba: float = 0.315
    xslg: float = 0.400
    xba: float = 0.250
    barrel_rate: float = 0.08
    hard_hit_rate: float = 0.39
    avg_exit_velocity: float = 88.0
    sample_size: int = 0
    window_days: int = 14


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except (ValueError, TypeError):
        pass
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def rolling_team_xstats(
    team_batter_ids: list[str | int],
    statcast_rows: list[dict[str, Any]],
    as_of_date: str | date | datetime | None = None,
    window_days: int = 14,
) -> RollingExpectedStats:
    """Compute rolling expected stats for a team's batters over a window.

    Only uses data BEFORE as_of_date to prevent leakage.
    """
    if not team_batter_ids or not statcast_rows:
        return RollingExpectedStats(window_days=window_days)

    target = _parse_date(as_of_date)
    if target is None:
        target = date.today()

    cutoff = target - timedelta(days=window_days)
    batter_set = {str(b).strip() for b in team_batter_ids if b}

    filtered = []
    for row in statcast_rows:
        batter_id = str(row.get("batter", row.get("batter_id", ""))).strip()
        if batter_id not in batter_set:
            continue
        row_date = _parse_date(row.get("game_date", row.get("date")))
        if row_date is None:
            continue
        if cutoff <= row_date < target:
            filtered.append(row)

    if not filtered:
        return RollingExpectedStats(window_days=window_days)

    xwoba_vals = [safe_float(r.get("estimated_woba_using_speedangle", r.get("xwoba")), None) for r in filtered]
    xslg_vals = [safe_float(r.get("estimated_slg_using_speedangle", r.get("xslg")), None) for r in filtered]
    xba_vals = [safe_float(r.get("estimated_ba_using_speedangle", r.get("xba")), None) for r in filtered]
    ev_vals = [safe_float(r.get("launch_speed", r.get("exit_velocity")), None) for r in filtered]
    la_vals = [safe_float(r.get("launch_angle"), None) for r in filtered]

    def _mean_valid(values: list[float | None], default: float) -> float:
        valid = [v for v in values if v is not None]
        return mean(valid) if valid else default

    ev_valid = [v for v in ev_vals if v is not None and v > 0]
    hard_hits = sum(1 for v in ev_valid if v >= 95.0)
    barrels = sum(
        1 for row in filtered
        if safe_float(row.get("launch_speed"), 0) >= 98.0
        and 26 <= safe_float(row.get("launch_angle"), 0) <= 30
    )
    batted_balls = len(ev_valid) if ev_valid else 1

    return RollingExpectedStats(
        xwoba=_mean_valid(xwoba_vals, 0.315),
        xslg=_mean_valid(xslg_vals, 0.400),
        xba=_mean_valid(xba_vals, 0.250),
        barrel_rate=barrels / max(batted_balls, 1),
        hard_hit_rate=hard_hits / max(batted_balls, 1),
        avg_exit_velocity=_mean_valid(ev_vals, 88.0),
        sample_size=len(filtered),
        window_days=window_days,
    )


def xstats_offense_adjustment(stats: RollingExpectedStats | None) -> float:
    """Return offense adjustment from rolling expected stats.

    Positive = team hitting better than league average process.
    """
    if stats is None or stats.sample_size < 20:
        return 0.0

    xwoba_adj = (stats.xwoba - 0.315) * 2.5
    xslg_adj = (stats.xslg - 0.400) * 1.2
    barrel_adj = (stats.barrel_rate - 0.08) * 2.0
    hard_hit_adj = (stats.hard_hit_rate - 0.39) * 1.0
    ev_adj = (stats.avg_exit_velocity - 88.0) * 0.02

    sample_weight = min(stats.sample_size / 100.0, 1.0)
    raw = xwoba_adj + xslg_adj + barrel_adj + hard_hit_adj + ev_adj

    return clamp(raw * sample_weight, -0.40, 0.40)
