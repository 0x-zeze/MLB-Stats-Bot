"""Market efficiency analysis by time window before first pitch.

Line movement at different time horizons carries different signals:
- 24h+ movement: often public money, weather news, lineup drops
- 6h movement: sharper, post-lineup confirmation
- 1h movement: sharp money, professional confirmation

This module classifies line movement into time windows and helps the
prediction model weight each window's signal appropriately.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .utils import clamp, safe_float

TIME_WINDOWS = {
    "early": (24, 6),    # 24h-6h before first pitch
    "mid": (6, 1),       # 6h-1h before
    "late": (1, 0),      # final hour
}


@dataclass
class LineSnapshot:
    """A single odds snapshot with timestamp."""

    odds: float
    hours_before_game: float
    source: str = "unknown"


@dataclass
class WindowMovement:
    """Line movement within a time window."""

    window: str
    start_odds: float
    end_odds: float
    movement_cents: float
    direction: str  # "toward_favorite", "toward_underdog", "stable"


@dataclass
class MarketEfficiencyProfile:
    """Per-window movement classification for a single game's market."""

    windows: dict[str, WindowMovement] = field(default_factory=dict)
    opening_odds: float = 0.0
    closing_odds: float = 0.0
    total_movement_cents: float = 0.0
    sharp_confirmation: bool = False  # late move confirms early move
    steam_move: bool = False  # rapid same-direction move across windows


def classify_movement(start: float, end: float) -> tuple[float, str]:
    """Return (cents, direction) for a line movement.

    Positive cents = line moved toward the favorite (odds became more negative).
    Negative cents = line moved toward the underdog.
    """
    # Convert American odds to a cents scale where positive = favorite strength
    start_cents = abs(start) if start < 0 else -start
    end_cents = abs(end) if end < 0 else -end
    diff = end_cents - start_cents
    if abs(diff) < 3:
        return diff, "stable"
    if diff > 0:
        return diff, "toward_favorite"
    return diff, "toward_underdog"


def build_market_profile(snapshots: list[LineSnapshot]) -> MarketEfficiencyProfile:
    """Build a market efficiency profile from a list of line snapshots."""
    if not snapshots:
        return MarketEfficiencyProfile()

    sorted_snaps = sorted(snapshots, key=lambda s: -s.hours_before_game)
    opening = sorted_snaps[0].odds
    closing = sorted_snaps[-1].odds

    profile = MarketEfficiencyProfile(
        opening_odds=opening,
        closing_odds=closing,
        total_movement_cents=classify_movement(opening, closing)[0],
    )

    for window_name, (start_hr, end_hr) in TIME_WINDOWS.items():
        window_snaps = [
            s for s in sorted_snaps
            if (end_hr < s.hours_before_game <= start_hr) or (end_hr == 0 and s.hours_before_game <= start_hr)
        ]
        if len(window_snaps) < 1:
            continue
        start_odds = window_snaps[0].odds
        end_odds = window_snaps[-1].odds
        if len(window_snaps) == 1:
            # Single snapshot: no movement within this window
            profile.windows[window_name] = WindowMovement(
                window=window_name,
                start_odds=start_odds,
                end_odds=end_odds,
                movement_cents=0.0,
                direction="stable",
            )
            continue
        cents, direction = classify_movement(start_odds, end_odds)
        profile.windows[window_name] = WindowMovement(
            window=window_name,
            start_odds=start_odds,
            end_odds=end_odds,
            movement_cents=cents,
            direction=direction,
        )

    # Detect sharp confirmation: late window moves same direction as total
    late = profile.windows.get("late")
    if late and late.direction != "stable" and profile.total_movement_cents != 0:
        late_sign = 1 if late.movement_cents > 0 else -1
        total_sign = 1 if profile.total_movement_cents > 0 else -1
        profile.sharp_confirmation = late_sign == total_sign

    # Detect steam move: all windows move same direction
    if len(profile.windows) >= 2:
        directions = {w.direction for w in profile.windows.values()}
        if len(directions) == 1 and "stable" not in directions:
            profile.steam_move = True

    return profile


def market_signal_weight(profile: MarketEfficiencyProfile) -> float:
    """Return 0-1 weight for how much to trust the market movement signal.

    - Sharp confirmation (late confirms early): high weight
    - Steam move (all windows same direction): high weight
    - Conflicting windows: low weight
    """
    if not profile.windows:
        return 0.0

    weight = 0.3  # base

    if profile.sharp_confirmation:
        weight += 0.35
    if profile.steam_move:
        weight += 0.25

    # Penalize conflicting directions
    directions = {w.direction for w in profile.windows.values()}
    if len(directions) > 2 or (len(directions) == 2 and "stable" not in directions):
        weight -= 0.15

    return clamp(weight, 0.0, 1.0)


def movement_risk_factor(profile: MarketEfficiencyProfile, model_pick_is_favorite: bool) -> float:
    """Return 0-1 risk factor for the model pick based on market movement.

    If the market is moving against the model's pick, increase risk.
    """
    if not profile.windows:
        return 0.0

    risk = 0.0
    late = profile.windows.get("late")
    mid = profile.windows.get("mid")

    # Late movement against the pick is the strongest negative signal
    if late and late.direction != "stable":
        pick_moved_toward = (
            (late.direction == "toward_favorite" and model_pick_is_favorite)
            or (late.direction == "toward_underdog" and not model_pick_is_favorite)
        )
        if not pick_moved_toward:
            risk += min(abs(late.movement_cents) * 0.012, 0.25)

    # Mid movement adds context
    if mid and mid.direction != "stable":
        pick_moved_toward = (
            (mid.direction == "toward_favorite" and model_pick_is_favorite)
            or (mid.direction == "toward_underdog" and not model_pick_is_favorite)
        )
        if not pick_moved_toward:
            risk += min(abs(mid.movement_cents) * 0.008, 0.15)

    if profile.steam_move:
        pick_moved_toward = (
            (profile.total_movement_cents > 0 and model_pick_is_favorite)
            or (profile.total_movement_cents < 0 and not model_pick_is_favorite)
        )
        if not pick_moved_toward:
            risk += 0.15

    return clamp(risk, 0.0, 0.55)
