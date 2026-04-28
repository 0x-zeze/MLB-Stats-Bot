"""Lineup context for total-runs projection."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .data_loader import read_csv
from .utils import clamp, clean_name, data_path, safe_float, safe_int


@dataclass(frozen=True)
class LineupContext:
    """Projected or confirmed lineup context for one team."""

    team: str
    confirmed: bool = False
    missing_star_hitters: int = 0
    top5_strength: float = 100.0
    platoon_advantage: float = 0.0
    injured_hitters: int = 0
    key_rest_days: int = 0


def lineup_adjustment(lineup: LineupContext | None) -> float:
    """Return team-runs adjustment from lineup quality and availability."""
    if lineup is None:
        return 0.0

    strength_adj = (lineup.top5_strength - 100.0) * 0.018
    platoon_adj = clamp(lineup.platoon_advantage, -1.0, 1.0) * 0.22
    missing_adj = -0.28 * lineup.missing_star_hitters
    injured_adj = -0.12 * lineup.injured_hitters
    rest_adj = -0.18 * lineup.key_rest_days
    confirmation_adj = 0.04 if lineup.confirmed else -0.03
    return clamp(
        strength_adj + platoon_adj + missing_adj + injured_adj + rest_adj + confirmation_adj,
        -1.2,
        0.9,
    )


def load_lineups(path: str | Path | None = None) -> dict[str, LineupContext]:
    """Load lineup contexts keyed by team."""
    source = Path(path) if path else data_path("sample_lineups.csv")
    lineups: dict[str, LineupContext] = {}
    for row in read_csv(source):
        confirmed = str(row.get("confirmed", "")).strip().lower() in {"1", "true", "yes", "y"}
        lineup = LineupContext(
            team=row["team"],
            confirmed=confirmed,
            missing_star_hitters=safe_int(row.get("missing_star_hitters")),
            top5_strength=safe_float(row.get("top5_strength"), 100.0),
            platoon_advantage=safe_float(row.get("platoon_advantage"), 0.0),
            injured_hitters=safe_int(row.get("injured_hitters")),
            key_rest_days=safe_int(row.get("key_rest_days")),
        )
        lineups[clean_name(lineup.team)] = lineup
    return lineups


def get_lineup(lineups: dict[str, LineupContext], team: str) -> LineupContext | None:
    """Find lineup context by team."""
    return lineups.get(clean_name(team))
