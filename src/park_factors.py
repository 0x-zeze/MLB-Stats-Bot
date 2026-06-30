"""Park-factor inputs for projected total runs and YRFI/NRFI."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .data_loader import read_csv
from .utils import clamp, clean_name, data_path, safe_float


# Ballpark-specific YRFI historical rates (empirical, updated annually).
# Baseline league rate is 0.57; each park's rate is used to adjust YRFI probability.
BALLPARK_YRFI_RATES: dict[str, float] = {
    "Coors Field": 0.72,
    "Great American Ball Park": 0.65,
    "Globe Life Field": 0.63,
    "Fenway Park": 0.62,
    "Wrigley Field": 0.61,
    "Yankee Stadium": 0.60,
    "Chase Field": 0.60,
    "Minute Maid Park": 0.59,
    "Citizens Bank Park": 0.59,
    "American Family Field": 0.58,
    "Oracle Park": 0.55,
    "Petco Park": 0.54,
    "Dodger Stadium": 0.54,
    "T-Mobile Park": 0.53,
    "Tropicana Field": 0.53,
}

DEFAULT_YRFI_RATE = 0.57
LEAGUE_BASELINE_YRFI_RATE = 0.57


@dataclass(frozen=True)
class ParkFactors:
    """Run-environment factors where 100 is league average."""

    team: str
    park: str
    run_factor: float = 100.0
    home_run_factor: float = 100.0
    lhb_hr_factor: float = 100.0
    rhb_hr_factor: float = 100.0
    doubles_factor: float = 100.0
    triples_factor: float = 100.0
    yrfi_rate: float = DEFAULT_YRFI_RATE


def park_factor_adjustment(park: ParkFactors | None) -> float:
    """Return total-runs adjustment from park context."""
    if park is None:
        return 0.0

    run_adj = (park.run_factor - 100.0) * 0.045
    hr_adj = (park.home_run_factor - 100.0) * 0.018
    handed_hr_adj = ((park.lhb_hr_factor + park.rhb_hr_factor) / 2.0 - 100.0) * 0.006
    extra_base_adj = ((park.doubles_factor + park.triples_factor) / 2.0 - 100.0) * 0.006
    return clamp(run_adj + hr_adj + handed_hr_adj + extra_base_adj, -0.9, 0.9)


def yrfi_park_adjustment(park: ParkFactors | None) -> float:
    """Return YRFI probability adjustment from ballpark historical rate.

    Formula: (ballpark_yrfi_rate - LEAGUE_BASELINE_YRFI_RATE) * 0.5
    Capped at ±0.08 to avoid over-adjustment.
    """
    if park is None:
        return 0.0

    park_name = park.park.strip()
    yrfi_rate = BALLPARK_YRFI_RATES.get(park_name, DEFAULT_YRFI_RATE)
    raw_adjustment = (yrfi_rate - LEAGUE_BASELINE_YRFI_RATE) * 0.5
    return clamp(raw_adjustment, -0.08, 0.08)


def load_park_factors(path: str | Path | None = None) -> dict[str, ParkFactors]:
    """Load park factors keyed by home team."""
    source = Path(path) if path else data_path("sample_park_factors.csv")
    parks: dict[str, ParkFactors] = {}
    for row in read_csv(source):
        team_name = row["team"]
        park_name = row.get("park", team_name)
        yrfi_rate = BALLPARK_YRFI_RATES.get(park_name.strip(), DEFAULT_YRFI_RATE)
        park = ParkFactors(
            team=team_name,
            park=park_name,
            run_factor=safe_float(row.get("run_factor"), 100.0),
            home_run_factor=safe_float(row.get("home_run_factor"), 100.0),
            lhb_hr_factor=safe_float(row.get("lhb_hr_factor"), 100.0),
            rhb_hr_factor=safe_float(row.get("rhb_hr_factor"), 100.0),
            doubles_factor=safe_float(row.get("doubles_factor"), 100.0),
            triples_factor=safe_float(row.get("triples_factor"), 100.0),
            yrfi_rate=yrfi_rate,
        )
        parks[clean_name(team_name)] = park
    return parks


def get_park_factor(parks: dict[str, ParkFactors], home_team: str) -> ParkFactors | None:
    """Find park factor by home team."""
    return parks.get(clean_name(home_team))
