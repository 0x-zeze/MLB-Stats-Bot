"""Enhanced pitcher matchup analysis with platoon splits, TTO, trajectory, and pitch mix."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .data_loader import PitcherStats
from .features import normalize_stat, pitcher_score, pitcher_score_with_xfip
from .utils import clamp, safe_float


@dataclass(frozen=True)
class PitcherMatchupContext:
    """Extended pitcher context for matchup-specific scoring."""

    pitcher: PitcherStats
    opponent_lineup_handedness: str = "balanced"  # "lhh_heavy", "rhh_heavy", "balanced"
    tto_woba: float | None = None
    pitch_count_trend: list[int] | None = None
    whiff_rate: float | None = None
    chase_rate: float | None = None


def platoon_adjustment(pitcher: PitcherStats, opponent_handedness: str) -> float:
    """Return adjustment based on pitcher's platoon splits vs lineup composition.

    Positive = pitcher is strong against this handedness.
    Negative = pitcher is vulnerable.
    """
    hand = opponent_handedness.lower().strip()

    if hand == "lhh_heavy":
        era = safe_float(getattr(pitcher, "era_vs_lhh", None), None)
        whip = safe_float(getattr(pitcher, "whip_vs_lhh", None), None)
        woba = safe_float(getattr(pitcher, "woba_vs_lhh", None), None)
    elif hand == "rhh_heavy":
        era = safe_float(getattr(pitcher, "era_vs_rhh", None), None)
        whip = safe_float(getattr(pitcher, "whip_vs_rhh", None), None)
        woba = safe_float(getattr(pitcher, "woba_vs_rhh", None), None)
    else:
        return 0.0

    if era is None and whip is None and woba is None:
        return 0.0

    scores: list[float] = []
    if era is not None and era > 0:
        scores.append(normalize_stat(era, 4.20, higher_is_better=False))
    if whip is not None and whip > 0:
        scores.append(normalize_stat(whip, 1.30, higher_is_better=False))
    if woba is not None and woba > 0:
        scores.append(normalize_stat(woba, 0.315, higher_is_better=False))

    if not scores:
        return 0.0

    avg = sum(scores) / len(scores)
    overall_score = pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)
    diff = avg - overall_score

    return clamp(diff * 0.4, -0.25, 0.25)


def tto_penalty(tto_woba: float | None) -> float:
    """Return penalty for third-time-through-order vulnerability.

    Higher TTO wOBA = pitcher gets hit harder on third pass = negative adjustment.
    League average TTO wOBA is ~0.340.
    """
    if tto_woba is None:
        return 0.0

    deviation = tto_woba - 0.340
    if deviation <= 0:
        return clamp(deviation * 0.3, -0.10, 0.0)

    return clamp(-deviation * 0.8, -0.25, 0.0)


def pitch_count_trajectory_signal(counts: list[int] | None) -> float:
    """Score pitch count trajectory from last 5 starts.

    Positive = trending up (deeper starts, more stamina).
    Negative = trending down (shorter outings, possible fatigue/injury).
    """
    if not counts or len(counts) < 3:
        return 0.0

    recent = counts[-3:]
    earlier = counts[:-3] if len(counts) > 3 else counts[:2]

    if not earlier:
        return 0.0

    recent_avg = sum(recent) / len(recent)
    earlier_avg = sum(earlier) / len(earlier)

    diff = recent_avg - earlier_avg

    if diff > 10:
        return 0.10
    elif diff > 5:
        return 0.05
    elif diff < -10:
        return -0.12
    elif diff < -5:
        return -0.06

    return 0.0


def pitch_mix_quality(whiff_rate: float | None, chase_rate: float | None) -> float:
    """Score pitch quality from Statcast swing-and-miss data.

    League average whiff rate ~25%, chase rate ~28%.
    Higher = better stuff.
    """
    if whiff_rate is None and chase_rate is None:
        return 0.0

    score = 0.0
    if whiff_rate is not None:
        score += (whiff_rate - 0.25) * 1.5
    if chase_rate is not None:
        score += (chase_rate - 0.28) * 1.2

    return clamp(score, -0.30, 0.30)


def enhanced_pitcher_score(context: PitcherMatchupContext) -> float:
    """Pitcher score incorporating platoon, TTO, trajectory, and pitch mix.

    Builds on the base pitcher_score and adds matchup-specific adjustments.
    """
    pitcher = context.pitcher
    xfip = safe_float(getattr(pitcher, "xfip", None), None)
    base = (
        pitcher_score_with_xfip(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio, xfip)
        if xfip is not None
        else pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)
    )

    platoon_adj = platoon_adjustment(pitcher, context.opponent_lineup_handedness)

    tto = context.tto_woba if context.tto_woba is not None else getattr(pitcher, "tto_woba", None)
    tto_adj = tto_penalty(tto)

    trajectory_adj = pitch_count_trajectory_signal(context.pitch_count_trend)

    whiff = context.whiff_rate if context.whiff_rate is not None else getattr(pitcher, "whiff_rate", None)
    chase = context.chase_rate if context.chase_rate is not None else getattr(pitcher, "chase_rate", None)
    mix_adj = pitch_mix_quality(whiff, chase)

    enhanced = base + platoon_adj + tto_adj + trajectory_adj + mix_adj

    return clamp(enhanced, -1.0, 1.0)


def classify_lineup_handedness(
    lineup_data: dict[str, Any] | list[dict[str, Any]] | None,
) -> str:
    """Classify a lineup as lhh_heavy, rhh_heavy, or balanced.

    Expects lineup_data to contain batter entries with 'bats' or 'handedness' field.
    """
    if not lineup_data:
        return "balanced"

    batters = lineup_data if isinstance(lineup_data, list) else lineup_data.get("batters", [])
    if not batters:
        return "balanced"

    lhh = 0
    rhh = 0
    for batter in batters:
        if not isinstance(batter, dict):
            continue
        hand = str(batter.get("bats", batter.get("handedness", "R"))).upper().strip()
        if hand in ("L", "LHH", "LEFT"):
            lhh += 1
        elif hand in ("R", "RHH", "RIGHT"):
            rhh += 1

    total = lhh + rhh
    if total == 0:
        return "balanced"

    lhh_pct = lhh / total
    if lhh_pct >= 0.55:
        return "lhh_heavy"
    elif lhh_pct <= 0.35:
        return "rhh_heavy"
    return "balanced"
