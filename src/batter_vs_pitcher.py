"""Batter-vs-pitcher (BvP) matchup analysis for MLB predictions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


MIN_PLATE_APPEARANCES = 30
MIN_LINEUP_BVP_PAS = 50


@dataclass(frozen=True)
class BvPResult:
    """Aggregated batter-vs-pitcher matchup result."""

    plate_appearances: int = 0
    batting_average: float = 0.0
    ops: float = 0.0
    woba: float = 0.0
    k_rate: float = 0.0
    bb_rate: float = 0.0
    hr_rate: float = 0.0
    sufficient_sample: bool = False


def compute_bvp_from_events(
    events: list[dict[str, Any]],
) -> BvPResult:
    """Compute BvP stats from a list of plate appearance events."""
    if not events:
        return BvPResult()

    pa = len(events)
    hits = sum(1 for e in events if e.get("is_hit", False))
    at_bats = sum(1 for e in events if not e.get("is_walk", False) and not e.get("is_hbp", False) and not e.get("is_sac", False))
    walks = sum(1 for e in events if e.get("is_walk", False))
    strikeouts = sum(1 for e in events if e.get("is_strikeout", False))
    home_runs = sum(1 for e in events if e.get("is_home_run", False))
    total_bases = sum(int(safe_float(e.get("total_bases", 0), 0)) for e in events)

    avg = hits / max(at_bats, 1)
    obp = (hits + walks) / max(pa, 1)
    slg = total_bases / max(at_bats, 1)
    ops = obp + slg

    woba_values = [safe_float(e.get("woba_value"), None) for e in events]
    woba_valid = [v for v in woba_values if v is not None]
    woba = sum(woba_valid) / max(len(woba_valid), 1) if woba_valid else 0.0

    return BvPResult(
        plate_appearances=pa,
        batting_average=avg,
        ops=ops,
        woba=woba,
        k_rate=strikeouts / max(pa, 1),
        bb_rate=walks / max(pa, 1),
        hr_rate=home_runs / max(pa, 1),
        sufficient_sample=pa >= MIN_PLATE_APPEARANCES,
    )


def aggregate_bvp_for_lineup(
    lineup_batter_ids: list[str | int],
    pitcher_id: str | int,
    statcast_rows: list[dict[str, Any]],
) -> BvPResult | None:
    """Aggregate BvP for an entire lineup against a specific pitcher.

    Returns None if insufficient total plate appearances across the lineup.
    """
    if not lineup_batter_ids or not pitcher_id or not statcast_rows:
        return None

    pitcher_str = str(pitcher_id).strip()
    batter_set = {str(b).strip() for b in lineup_batter_ids if b}

    relevant_events = [
        row for row in statcast_rows
        if str(row.get("pitcher", row.get("pitcher_id", ""))).strip() == pitcher_str
        and str(row.get("batter", row.get("batter_id", ""))).strip() in batter_set
    ]

    if len(relevant_events) < MIN_LINEUP_BVP_PAS:
        return None

    return compute_bvp_from_events(relevant_events)


def bvp_adjustment(bvp: BvPResult | None) -> float:
    """Return a runs adjustment based on BvP matchup history.

    Positive = lineup has historically hit this pitcher well.
    Negative = pitcher has dominated this lineup.
    """
    if bvp is None or not bvp.sufficient_sample:
        return 0.0

    ops_signal = (bvp.ops - 0.720) * 0.8
    woba_signal = (bvp.woba - 0.315) * 1.5
    k_signal = (0.22 - bvp.k_rate) * 0.6
    hr_signal = (bvp.hr_rate - 0.03) * 3.0

    raw = ops_signal + woba_signal + k_signal + hr_signal
    sample_weight = min(bvp.plate_appearances / 100.0, 1.0)

    return clamp(raw * sample_weight * 0.5, -0.30, 0.30)


def bvp_confidence_signal(bvp: BvPResult | None) -> str:
    """Classify BvP signal strength for quality control."""
    if bvp is None or not bvp.sufficient_sample:
        return "unavailable"

    if bvp.plate_appearances >= 80:
        return "strong"
    elif bvp.plate_appearances >= 50:
        return "moderate"
    return "weak"
