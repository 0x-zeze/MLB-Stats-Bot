"""Travel and timezone fatigue adjustments for MLB predictions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


TIMEZONE_OFFSETS = {
    "ET": -5, "EST": -5, "EDT": -4,
    "CT": -6, "CST": -6, "CDT": -5,
    "MT": -7, "MST": -7, "MDT": -6,
    "PT": -8, "PST": -8, "PDT": -7,
}

TEAM_TIMEZONES = {
    "NYY": "ET", "NYM": "ET", "BOS": "ET", "BAL": "ET", "TB": "ET",
    "TOR": "ET", "PHI": "ET", "WSH": "ET", "ATL": "ET", "MIA": "ET",
    "PIT": "ET", "CIN": "ET", "CLE": "ET", "DET": "ET",
    "CHC": "CT", "CWS": "CT", "MIL": "CT", "MIN": "CT",
    "STL": "CT", "KC": "CT", "HOU": "CT", "TEX": "CT",
    "COL": "MT", "ARI": "MT",
    "LAD": "PT", "LAA": "PT", "SD": "PT", "SF": "PT",
    "OAK": "PT", "SEA": "PT",
}


@dataclass(frozen=True)
class TravelContext:
    """Travel fatigue context for a team."""

    origin_timezone: str = "ET"
    destination_timezone: str = "ET"
    zones_crossed: int = 0
    direction: str = "same"  # "east", "west", "same"
    day_game_after_night: bool = False
    consecutive_road_days: int = 0
    miles_traveled_last_3_days: float = 0.0
    arrival_hour_local: float = 0.0  # hour of day at destination
    travel_day_before_game: bool = False  # flew in day-of
    coast_to_coast: bool = False


def _timezone_offset(tz: str) -> int:
    return TIMEZONE_OFFSETS.get(tz.upper().strip(), -5)


def compute_zones_crossed(origin_tz: str, destination_tz: str) -> tuple[int, str]:
    """Return (zones_crossed, direction) between two timezones."""
    origin = _timezone_offset(origin_tz)
    dest = _timezone_offset(destination_tz)
    diff = dest - origin

    if diff == 0:
        return 0, "same"
    elif diff > 0:
        return abs(diff), "east"
    else:
        return abs(diff), "west"


def travel_fatigue_adjustment(context: TravelContext | None) -> float:
    """Return offense suppression factor from travel fatigue.

    Returns a negative value (runs suppressed) when fatigue is present.
    West-to-East travel is harder (losing hours, earlier body clock).
    Enhanced with miles, arrival time, and coast-to-coast detection.
    """
    if context is None:
        return 0.0

    penalty = 0.0

    if context.zones_crossed >= 3:
        base = -0.18
        if context.direction == "east":
            base -= 0.07
        penalty += base
    elif context.zones_crossed == 2:
        base = -0.10
        if context.direction == "east":
            base -= 0.04
        penalty += base
    elif context.zones_crossed == 1:
        penalty += -0.03

    # Coast-to-coast penalty (3+ zones, regardless of direction)
    if context.coast_to_coast:
        penalty -= 0.05

    # Day game after night
    if context.day_game_after_night:
        penalty += -0.15

    # Consecutive road days
    if context.consecutive_road_days >= 10:
        penalty += -0.08
    elif context.consecutive_road_days >= 7:
        penalty += -0.04

    # Miles traveled (quantified): >1000 miles = significant
    miles = context.miles_traveled_last_3_days
    if miles > 1500:
        penalty -= 0.06
    elif miles > 1000:
        penalty -= 0.04
    elif miles > 500:
        penalty -= 0.02

    # Late arrival (after 2 AM local) = sleep deprivation
    if context.arrival_hour_local > 2 and context.arrival_hour_local < 6:
        penalty -= 0.05
    elif context.arrival_hour_local >= 6 and context.arrival_hour_local < 9:
        penalty -= 0.03

    # Travel day (flew in same day as game)
    if context.travel_day_before_game:
        penalty -= 0.04

    return clamp(penalty, -0.45, 0.0)


def day_after_night_penalty(
    is_day_game: bool,
    previous_game_was_night: bool,
    previous_game_ended_late: bool = False,
) -> float:
    """Return offense suppression for day game after night game.

    Historical data shows ~0.3 fewer runs in day-after-night situations.
    """
    if not is_day_game or not previous_game_was_night:
        return 0.0

    penalty = -0.15
    if previous_game_ended_late:
        penalty -= 0.08

    return penalty


def build_travel_context(
    team_abbrev: str,
    venue_timezone: str,
    schedule_data: dict[str, Any] | None = None,
) -> TravelContext:
    """Build TravelContext from team abbreviation and venue timezone."""
    home_tz = TEAM_TIMEZONES.get(team_abbrev.upper(), "ET")
    zones, direction = compute_zones_crossed(home_tz, venue_timezone)

    day_after_night = False
    road_days = 0

    if schedule_data and isinstance(schedule_data, dict):
        day_after_night = bool(schedule_data.get("day_game_after_night", False))
        road_days = int(safe_float(schedule_data.get("consecutive_road_days", 0), 0))

    return TravelContext(
        origin_timezone=home_tz,
        destination_timezone=venue_timezone,
        zones_crossed=zones,
        direction=direction,
        day_game_after_night=day_after_night,
        consecutive_road_days=road_days,
    )
