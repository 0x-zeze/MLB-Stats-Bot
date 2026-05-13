"""Bullpen usage and fatigue adjustments for total runs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .data_loader import read_csv
from .utils import clamp, clean_name, data_path, safe_float, safe_int


@dataclass(frozen=True)
class BullpenUsage:
    """Recent bullpen usage available before the target game."""

    team: str
    bullpen_innings_last_3_days: float = 0.0
    relievers_used_yesterday: int = 0
    closer_available: bool = True
    high_leverage_available: bool = True
    back_to_back_usage: int = 0
    bullpen_era_last_7: float = 4.10


def bullpen_fatigue_adjustment(bullpen: BullpenUsage | None) -> float:
    """Return opponent team-runs adjustment from bullpen fatigue."""
    if bullpen is None:
        return 0.0

    innings_adj = max(0.0, bullpen.bullpen_innings_last_3_days - 9.0) * 0.07
    reliever_adj = max(0, bullpen.relievers_used_yesterday - 4) * 0.06
    closer_adj = 0.20 if not bullpen.closer_available else 0.0
    leverage_adj = 0.16 if not bullpen.high_leverage_available else 0.0
    back_to_back_adj = bullpen.back_to_back_usage * 0.08
    era_adj = max(0.0, bullpen.bullpen_era_last_7 - 4.10) * 0.08
    return clamp(
        innings_adj + reliever_adj + closer_adj + leverage_adj + back_to_back_adj + era_adj,
        0.0,
        1.2,
    )


def load_bullpen_usage(path: str | Path | None = None) -> dict[str, BullpenUsage]:
    """Load bullpen usage keyed by team."""
    source = Path(path) if path else data_path("sample_bullpen_usage.csv")
    usage: dict[str, BullpenUsage] = {}
    for row in read_csv(source):
        closer_available = str(row.get("closer_available", "true")).strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        high_leverage_available = str(row.get("high_leverage_available", "true")).strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        bullpen = BullpenUsage(
            team=row["team"],
            bullpen_innings_last_3_days=safe_float(row.get("bullpen_innings_last_3_days")),
            relievers_used_yesterday=safe_int(row.get("relievers_used_yesterday")),
            closer_available=closer_available,
            high_leverage_available=high_leverage_available,
            back_to_back_usage=safe_int(row.get("back_to_back_usage")),
            bullpen_era_last_7=safe_float(row.get("bullpen_era_last_7"), 4.10),
        )
        usage[clean_name(bullpen.team)] = bullpen
    return usage


def get_bullpen_usage(usage: dict[str, BullpenUsage], team: str) -> BullpenUsage | None:
    """Find bullpen usage by team."""
    return usage.get(clean_name(team))


def expected_bullpen_quality_remaining(
    bullpen: BullpenUsage | None,
    expected_starter_ip: float = 5.5,
    league_avg_bullpen_era: float = 4.10,
) -> dict[str, float]:
    """Estimate the quality of bullpen innings the team has available.

    Returns a dict with:
    - expected_bullpen_ip: how many innings the bullpen must cover
    - bullpen_quality_score: 0-1 scale (1 = elite bullpen remaining)
    - fatigue_penalty: how many runs of penalty from fatigue
    - effective_era: expected ERA for remaining bullpen innings

    This upgrades the simple fatigue flags into a continuous quality
    estimate that the totals and moneyline models can use directly.
    """
    if bullpen is None:
        return {
            "expected_bullpen_ip": max(0.0, 9.0 - expected_starter_ip),
            "bullpen_quality_score": 0.5,
            "fatigue_penalty": 0.0,
            "effective_era": league_avg_bullpen_era,
        }

    expected_bullpen_ip = max(0.0, 9.0 - expected_starter_ip)

    # Base quality from recent ERA
    era = max(1.0, bullpen.bullpen_era_last_7)
    era_quality = clamp((league_avg_bullpen_era - era) / 2.0, -0.5, 0.5)

    # Availability score: closer + high-leverage arms
    availability_score = 0.0
    if not bullpen.closer_available:
        availability_score -= 0.15
    if not bullpen.high_leverage_available:
        availability_score -= 0.10

    # Fatigue from recent workload
    innings_fatigue = max(0.0, bullpen.bullpen_innings_last_3_days - 9.0) * 0.03
    reliever_fatigue = max(0, bullpen.relievers_used_yesterday - 3) * 0.04
    b2b_fatigue = bullpen.back_to_back_usage * 0.05
    total_fatigue = clamp(innings_fatigue + reliever_fatigue + b2b_fatigue, 0.0, 0.4)

    # Composite quality score (0-1 scale, 0.5 = league average)
    raw_quality = 0.5 + era_quality + availability_score - total_fatigue
    quality_score = clamp(raw_quality, 0.1, 0.95)

    # Effective ERA: how many runs the bullpen is likely to allow
    era_adjustment = (1.0 - quality_score) * 2.0  # scale quality to ERA modifier
    effective_era = clamp(league_avg_bullpen_era + era_adjustment, 2.5, 7.0)

    # Fatigue penalty in expected runs
    fatigue_penalty = total_fatigue * expected_bullpen_ip * 0.5

    return {
        "expected_bullpen_ip": round(expected_bullpen_ip, 1),
        "bullpen_quality_score": round(quality_score, 3),
        "fatigue_penalty": round(fatigue_penalty, 2),
        "effective_era": round(effective_era, 2),
    }
