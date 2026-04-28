"""Park-factor inputs for projected total runs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .data_loader import read_csv
from .utils import clamp, clean_name, data_path, safe_float


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


def park_factor_adjustment(park: ParkFactors | None) -> float:
    """Return total-runs adjustment from park context."""
    if park is None:
        return 0.0

    run_adj = (park.run_factor - 100.0) * 0.045
    hr_adj = (park.home_run_factor - 100.0) * 0.018
    handed_hr_adj = ((park.lhb_hr_factor + park.rhb_hr_factor) / 2.0 - 100.0) * 0.006
    extra_base_adj = ((park.doubles_factor + park.triples_factor) / 2.0 - 100.0) * 0.006
    return clamp(run_adj + hr_adj + handed_hr_adj + extra_base_adj, -0.9, 0.9)


def load_park_factors(path: str | Path | None = None) -> dict[str, ParkFactors]:
    """Load park factors keyed by home team."""
    source = Path(path) if path else data_path("sample_park_factors.csv")
    parks: dict[str, ParkFactors] = {}
    for row in read_csv(source):
        park = ParkFactors(
            team=row["team"],
            park=row.get("park", row["team"]),
            run_factor=safe_float(row.get("run_factor"), 100.0),
            home_run_factor=safe_float(row.get("home_run_factor"), 100.0),
            lhb_hr_factor=safe_float(row.get("lhb_hr_factor"), 100.0),
            rhb_hr_factor=safe_float(row.get("rhb_hr_factor"), 100.0),
            doubles_factor=safe_float(row.get("doubles_factor"), 100.0),
            triples_factor=safe_float(row.get("triples_factor"), 100.0),
        )
        parks[clean_name(park.team)] = park
    return parks


def get_park_factor(parks: dict[str, ParkFactors], home_team: str) -> ParkFactors | None:
    """Find park factor by home team."""
    return parks.get(clean_name(home_team))
