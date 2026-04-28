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
