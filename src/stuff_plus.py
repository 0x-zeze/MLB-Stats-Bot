"""Stuff+ and pitch-level matchup scoring from Statcast pitch data.

Stuff+ grades pitches on their physical characteristics (velocity, spin,
movement) rather than results, making it more predictive than whiff rate alone.
This module computes a pitcher's Stuff+ per pitch type and the matchup edge
against a lineup's handedness.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any

from .utils import clamp, safe_float

LEAGUE_AVG_STUFF_PLUS = 100.0
LEAGUE_AVG_WHIFF = 0.25
LEAGUE_AVG_CHASE = 0.28
LEAGUE_AVG_CSW = 0.33  # called strikes + whiffs


@dataclass(frozen=True)
class PitchTypeStats:
    """Statcast pitch-level stats for one pitch type."""

    pitch_type: str = ""
    stuff_plus: float = 100.0
    whiff_rate: float = 0.25
    chase_rate: float = 0.28
    csw_rate: float = 0.33
    usage_rate: float = 0.0
    avg_velocity: float = 0.0
    avg_spin: float = 0.0
    sample_pitches: int = 0


@dataclass(frozen=True)
class PitcherStuffProfile:
    """Full pitch arsenal profile for a pitcher."""

    pitcher_id: str = ""
    pitch_types: dict[str, PitchTypeStats] = None  # type: ignore
    overall_stuff_plus: float = 100.0
    stuff_vs_lhh: float = 100.0
    stuff_vs_rhh: float = 100.0
    sample_pitches: int = 0

    def __post_init__(self) -> None:
        if self.pitch_types is None:
            object.__setattr__(self, "pitch_types", {})


def build_pitcher_stuff_profile(
    pitcher_id: str,
    pitch_rows: list[dict[str, Any]],
    as_of_date: str | None = None,
    window_days: int = 30,
) -> PitcherStuffProfile:
    """Build a Stuff+ profile from Statcast pitch-level rows.

    Only uses data before as_of_date to prevent leakage.
    """
    from datetime import date, datetime, timedelta

    target = None
    if as_of_date:
        try:
            target = datetime.fromisoformat(str(as_of_date)[:10]).date()
        except (ValueError, TypeError):
            target = date.today()
    else:
        target = date.today()

    cutoff = target - timedelta(days=window_days)

    filtered: list[dict[str, Any]] = []
    for row in pitch_rows:
        row_date_str = str(row.get("game_date", row.get("date", "")))[:10]
        try:
            row_date = datetime.fromisoformat(row_date_str).date()
        except (ValueError, TypeError):
            continue
        if cutoff <= row_date < target:
            filtered.append(row)

    if not filtered:
        return PitcherStuffProfile(pitcher_id=pitcher_id)

    by_type: dict[str, list[dict[str, Any]]] = {}
    for row in filtered:
        ptype = str(row.get("pitch_type", row.get("pitch_name", ""))).strip().upper()
        if not ptype:
            continue
        by_type.setdefault(ptype, []).append(row)

    pitch_types: dict[str, PitchTypeStats] = {}
    all_stuff: list[float] = []
    stuff_vs_lhh: list[float] = []
    stuff_vs_rhh: list[float] = []
    total_pitches = 0

    for ptype, rows in by_type.items():
        stuff_vals = [safe_float(r.get("stuff_plus", 100.0), 100.0) for r in rows]
        whiff_vals = [safe_float(r.get("whiff_rate", r.get("is_whiff", 0)), None) for r in rows]
        chase_vals = [safe_float(r.get("chase_rate", 0), None) for r in rows]
        csw_vals = [safe_float(r.get("csw_rate", 0), None) for r in rows]
        vel_vals = [safe_float(r.get("release_speed", r.get("velocity", 0)), None) for r in rows]
        spin_vals = [safe_float(r.get("release_spin_rate", r.get("spin_rate", 0)), None) for r in rows]

        def _mean_valid(vals: list, default: float) -> float:
            valid = [v for v in vals if v is not None]
            return mean(valid) if valid else default

        stuff_mean = _mean_valid(stuff_vals, 100.0)
        all_stuff.extend(stuff_vals)

        for r in rows:
            stand = str(r.get("stand", "R")).upper().strip()
            s = safe_float(r.get("stuff_plus", 100.0), 100.0)
            if stand == "L":
                stuff_vs_lhh.append(s)
            else:
                stuff_vs_rhh.append(s)

        total_pitches += len(rows)

        pitch_types[ptype] = PitchTypeStats(
            pitch_type=ptype,
            stuff_plus=stuff_mean,
            whiff_rate=_mean_valid(whiff_vals, LEAGUE_AVG_WHIFF),
            chase_rate=_mean_valid(chase_vals, LEAGUE_AVG_CHASE),
            csw_rate=_mean_valid(csw_vals, LEAGUE_AVG_CSW),
            usage_rate=len(rows) / max(len(filtered), 1),
            avg_velocity=_mean_valid(vel_vals, 0.0),
            avg_spin=_mean_valid(spin_vals, 0.0),
            sample_pitches=len(rows),
        )

    overall = mean(all_stuff) if all_stuff else 100.0
    vs_lhh = mean(stuff_vs_lhh) if stuff_vs_lhh else overall
    vs_rhh = mean(stuff_vs_rhh) if stuff_vs_rhh else overall

    return PitcherStuffProfile(
        pitcher_id=pitcher_id,
        pitch_types=pitch_types,
        overall_stuff_plus=overall,
        stuff_vs_lhh=vs_lhh,
        stuff_vs_rhh=vs_rhh,
        sample_pitches=total_pitches,
    )


def stuff_plus_score(profile: PitcherStuffProfile | None) -> float:
    """Return a -1..1 pitcher quality signal from Stuff+.

    100 = league average. Above 100 = better stuff = positive signal.
    """
    if profile is None or profile.sample_pitches < 50:
        return 0.0
    deviation = profile.overall_stuff_plus - LEAGUE_AVG_STUFF_PLUS
    return clamp(deviation / 30.0, -1.0, 1.0)


def platoon_stuff_adjustment(
    profile: PitcherStuffProfile | None,
    opponent_handedness: str,
) -> float:
    """Return platoon edge from Stuff+ split differential.

    Positive = pitcher has better stuff against this handedness.
    """
    if profile is None or profile.sample_pitches < 50:
        return 0.0

    hand = opponent_handedness.lower().strip()
    if hand == "lhh_heavy":
        diff = profile.stuff_vs_lhh - profile.stuff_vs_rhh
    elif hand == "rhh_heavy":
        diff = profile.stuff_vs_rhh - profile.stuff_vs_lhh
    else:
        return 0.0

    return clamp(diff / 40.0, -0.25, 0.25)


def best_pitch_weapon(profile: PitcherStuffProfile | None) -> str | None:
    """Return the pitch type with the highest Stuff+ (the 'out' pitch)."""
    if profile is None or not profile.pitch_types:
        return None
    best = max(profile.pitch_types.values(), key=lambda p: p.stuff_plus)
    if best.sample_pitches < 10:
        return None
    return best.pitch_type
