"""Pitcher variance profiling from historical start-to-start ERA deviation.

Some pitchers are consistently consistent (low variance: Cole, Burnes).
Others are effectively wild (high variance: Glasnow, Snell). This module
computes a pitcher's ERA stddev across starts and feeds it into the
dynamic variance model.

A high-variance pitcher increases total-runs variance, which affects
over/under probabilities (wider distribution = more value on the extremes).
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import pstdev
from typing import Any

from .utils import clamp, safe_float

LEAGUE_AVG_ERA_STDDEV = 1.5  # typical start-to-start ERA stddev
MIN_STARTS_FOR_PROFILE = 5


@dataclass
class PitcherVarianceProfile:
    """Variance characteristics for a starting pitcher."""

    pitcher_id: str = ""
    era_stddev: float = LEAGUE_AVG_ERA_STDDEV
    whip_stddev: float = 0.45
    innings_stddev: float = 1.2
    start_count: int = 0
    volatility_label: str = "medium"  # "low", "medium", "high"
    consistency_score: float = 0.5  # 0-1, higher = more consistent

    @property
    def variance_multiplier(self) -> float:
        """Return 0.8-1.3 multiplier for dynamic variance.

        High-variance pitchers increase the total-runs variance.
        """
        return clamp(self.era_stddev / LEAGUE_AVG_ERA_STDDEV, 0.8, 1.3)


def build_variance_profile(
    pitcher_id: str,
    start_logs: list[dict[str, Any]],
    as_of_date: str | None = None,
) -> PitcherVarianceProfile:
    """Build a variance profile from start logs.

    Each start log should have: date, era (or earned_runs + innings),
    whip (or hits+walks + innings), innings_pitched.
    """
    from datetime import date, datetime

    target = date.today()
    if as_of_date:
        try:
            target = datetime.fromisoformat(str(as_of_date)[:10]).date()
        except (ValueError, TypeError):
            pass

    # Filter to starts before as_of_date
    valid_starts: list[dict[str, Any]] = []
    for log in start_logs:
        log_date_str = str(log.get("date", log.get("game_date", "")))[:10]
        try:
            log_date = datetime.fromisoformat(log_date_str).date()
        except (ValueError, TypeError):
            continue
        if log_date < target:
            valid_starts.append(log)

    if len(valid_starts) < MIN_STARTS_FOR_PROFILE:
        return PitcherVarianceProfile(pitcher_id=pitcher_id)

    # Extract ERA per start (compute if not provided)
    era_values: list[float] = []
    whip_values: list[float] = []
    ip_values: list[float] = []

    for log in valid_starts:
        era = safe_float(log.get("era"), None)
        if era is None:
            er = safe_float(log.get("earned_runs"), 0)
            ip = safe_float(log.get("innings_pitched", log.get("ip", 0)), 0)
            if ip > 0:
                era = (er / ip) * 9.0
        if era is not None and era >= 0:
            era_values.append(clamp(era, 0.0, 20.0))

        whip = safe_float(log.get("whip"), None)
        if whip is None:
            hits = safe_float(log.get("hits", 0))
            walks = safe_float(log.get("walks", log.get("bb", 0)), 0)
            ip = safe_float(log.get("innings_pitched", log.get("ip", 0)), 0)
            if ip > 0:
                whip = (hits + walks) / ip
        if whip is not None and whip >= 0:
            whip_values.append(clamp(whip, 0.0, 5.0))

        ip = safe_float(log.get("innings_pitched", log.get("ip", 0)), 0)
        if ip > 0:
            ip_values.append(ip)

    era_stddev = pstdev(era_values) if len(era_values) >= 2 else LEAGUE_AVG_ERA_STDDEV
    whip_stddev = pstdev(whip_values) if len(whip_values) >= 2 else 0.45
    ip_stddev = pstdev(ip_values) if len(ip_values) >= 2 else 1.2

    # Classify volatility
    if era_stddev <= 1.0:
        label = "low"
        consistency = clamp(1.0 - era_stddev / LEAGUE_AVG_ERA_STDDEV, 0.6, 1.0)
    elif era_stddev >= 2.5:
        label = "high"
        consistency = clamp(1.0 - era_stddev / (LEAGUE_AVG_ERA_STDDEV * 2), 0.1, 0.4)
    else:
        label = "medium"
        consistency = clamp(1.0 - era_stddev / (LEAGUE_AVG_ERA_STDDEV * 1.5), 0.3, 0.7)

    return PitcherVarianceProfile(
        pitcher_id=pitcher_id,
        era_stddev=round(era_stddev, 3),
        whip_stddev=round(whip_stddev, 3),
        innings_stddev=round(ip_stddev, 3),
        start_count=len(valid_starts),
        volatility_label=label,
        consistency_score=round(consistency, 3),
    )


def variance_profile_to_context(
    home_profile: PitcherVarianceProfile | None,
    away_profile: PitcherVarianceProfile | None,
) -> tuple[float, float]:
    """Return (home_pitcher_era_stddev, away_pitcher_era_stddev) for VarianceContext."""
    home = home_profile.era_stddev if home_profile else LEAGUE_AVG_ERA_STDDEV
    away = away_profile.era_stddev if away_profile else LEAGUE_AVG_ERA_STDDEV
    return home, away


def volatility_warning(profile: PitcherVarianceProfile | None) -> str:
    """Return a human-readable volatility note for the prediction output."""
    if profile is None or profile.start_count < MIN_STARTS_FOR_PROFILE:
        return ""
    if profile.volatility_label == "high":
        return f"High-variance starter (ERA stddev {profile.era_stddev:.1f}): total-runs variance increased"
    if profile.volatility_label == "low":
        return f"Consistent starter (ERA stddev {profile.era_stddev:.1f}): total-runs variance reduced"
    return ""
