"""Player-level contribution scoring for MLB predictions.

Computes per-player and per-unit (lineup, SP, bullpen) scores that feed into
the prediction pipeline as a delta adjustment on top of the base model.

Key functions
-------------
calculate_lineup_contribution  – batting lineup ⇒ weighted lineup score
calculate_sp_contribution      – starter stats ⇒ normalised SP score
calculate_bullpen_contribution – bullpen stats ⇒ normalised BP score
calculate_team_player_score    – combine everything for both sides
"""

from __future__ import annotations

from typing import Any

from .utils import clamp, safe_float


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# League-average wRC+ is 100 by definition.
_LEAGUE_AVG_WRC_PLUS = 100.0

# Replacement-level wRC+ for IL / absent players.
_REPLACEMENT_WRC_PLUS = 75.0

# Batting-order positional weights (slot 1-based).
_ORDER_WEIGHT = {
    1: 1.3, 2: 1.3, 3: 1.3, 4: 1.3,
    5: 1.0, 6: 1.0, 7: 1.0,
    8: 0.7, 9: 0.7,
}


# ---------------------------------------------------------------------------
# Lineup contribution
# ---------------------------------------------------------------------------

def _platoon_multiplier(batter_hand: str, pitcher_hand: str) -> float:
    """Return a multiplier for platoon advantage/disadvantage.

    Same-side matchups (LHH vs LHP, RHH vs RHP) are disadvantageous.
    Opposite-side matchups are advantageous.  Switch hitters get a neutral 1.0.
    """
    b = str(batter_hand).upper()[:1]
    p = str(pitcher_hand).upper()[:1]
    if b == "S" or not b or not p:
        return 1.0
    if b == p:
        return 0.88  # same-side disadvantage
    return 1.12  # opposite-side advantage


def _hot_cold_multiplier(last_7_wrc: float | None) -> float:
    """Streak multiplier based on last-7-day wRC+."""
    if last_7_wrc is None:
        return 1.0
    v = safe_float(last_7_wrc, 100.0)
    if v > 140:
        return 1.15
    if v < 70:
        return 0.88
    return 1.0


def calculate_lineup_contribution(
    lineup: list[dict[str, Any]] | None,
    opposing_sp_hand: str = "R",
    *,
    return_details: bool = False,
) -> float | tuple[float, list[dict[str, Any]], list[dict[str, Any]]]:
    """Score a batting lineup.

    Parameters
    ----------
    lineup : list of dicts, each with keys:
        name, wrc_plus, hand (L/R/S), last_7_wrc, is_il (bool), slot (1-9)
    opposing_sp_hand : "L" or "R"
    return_details : bool
        False (default) returns only the float score, matching the public API
        requested for calculate_lineup_contribution(). True returns
        (score, key_contributors, key_risks) for pipeline integration.

    Returns
    -------
    float in [-0.30, +0.30] relative to league average, or a details tuple
    when return_details=True.
    """
    if not lineup:
        return (0.0, [], []) if return_details else 0.0

    weighted_scores: list[float] = []
    weight_sum = 0.0
    contributors: list[dict[str, Any]] = []

    for batter in lineup:
        slot = int(batter.get("slot", 5))
        slot = clamp(slot, 1, 9)
        order_w = _ORDER_WEIGHT.get(slot, 1.0)

        is_il = bool(batter.get("is_il", False))
        wrc = safe_float(batter.get("wrc_plus"), _LEAGUE_AVG_WRC_PLUS)
        if is_il:
            wrc = _REPLACEMENT_WRC_PLUS

        base_score = (wrc / _LEAGUE_AVG_WRC_PLUS) * 0.15
        platoon = _platoon_multiplier(
            batter.get("hand", "R"), opposing_sp_hand
        )
        streak = _hot_cold_multiplier(batter.get("last_7_wrc"))
        contribution = base_score * platoon * streak * order_w

        weighted_scores.append(contribution)
        weight_sum += order_w

        name = batter.get("name", f"Slot {slot}")
        # Track for contributor / risk reporting
        contributors.append({
            "name": name,
            "slot": slot,
            "contribution": round(contribution, 4),
            "wrc_plus": wrc,
            "is_il": is_il,
            "streak_mult": streak,
            "platoon_mult": platoon,
        })

    if weight_sum <= 0:
        return 0.0, [], []

    avg_contribution = sum(weighted_scores) / weight_sum
    # League-average lineup would score exactly 0.15.
    # Normalise to [-0.30, +0.30] relative to league average.
    lineup_score = clamp((avg_contribution - 0.15) * 6.0, -0.30, 0.30)

    # Key contributors: top 3 by contribution
    sorted_by_contrib = sorted(
        contributors, key=lambda c: c["contribution"], reverse=True
    )
    key_contributors = [
        {
            "name": c["name"],
            "contribution": c["contribution"],
            "reason": _contributor_reason(c),
        }
        for c in sorted_by_contrib[:3]
    ]

    # Key risks: IL or cold streak
    key_risks = [
        {
            "name": c["name"],
            "risk": round(0.15 - c["contribution"], 4),
            "reason": _risk_reason(c),
        }
        for c in contributors
        if c["is_il"] or c["streak_mult"] < 1.0
    ]

    lineup_score = round(lineup_score, 4)
    return (lineup_score, key_contributors, key_risks) if return_details else lineup_score


def _contributor_reason(c: dict) -> str:
    parts = []
    if c["wrc_plus"] >= 130:
        parts.append(f"elite bat (wRC+ {c['wrc_plus']:.0f})")
    elif c["wrc_plus"] >= 110:
        parts.append(f"above-avg bat (wRC+ {c['wrc_plus']:.0f})")
    if c["platoon_mult"] > 1.0:
        parts.append("platoon advantage")
    if c["streak_mult"] > 1.0:
        parts.append("hot streak")
    return ", ".join(parts) if parts else f"wRC+ {c['wrc_plus']:.0f}"


def _risk_reason(c: dict) -> str:
    parts = []
    if c["is_il"]:
        parts.append("IL / replacement level")
    if c["streak_mult"] < 1.0:
        parts.append("cold streak (last 7d)")
    if c["platoon_mult"] < 1.0:
        parts.append("same-side platoon disadvantage")
    return ", ".join(parts) if parts else "below average"


# ---------------------------------------------------------------------------
# SP contribution
# ---------------------------------------------------------------------------

def calculate_sp_contribution(pitcher_stats: dict[str, Any] | None) -> float:
    """Score a starting pitcher on a 0-1 scale.

    Parameters
    ----------
    pitcher_stats : dict with optional keys:
        era, fip, xfip, k_per_9, bb_per_9, whip, last_5_era,
        innings_pitched_avg

    Returns
    -------
    float normalised 0-1 (1 = elite, 0 = replacement level)
    """
    if not pitcher_stats:
        return 0.40  # Unknown pitcher → below-average default

    fip = safe_float(pitcher_stats.get("fip"), 4.20)
    era = safe_float(pitcher_stats.get("era"), 4.20)
    k_per_9 = safe_float(pitcher_stats.get("k_per_9"), 8.0)
    bb_per_9 = safe_float(pitcher_stats.get("bb_per_9"), 3.2)
    last_5_era = safe_float(pitcher_stats.get("last_5_era"), era)
    ip_avg = safe_float(pitcher_stats.get("innings_pitched_avg"), 5.5)

    # Core: inverse FIP, scaled so a 2.50 FIP → ~1.0, 5.50 FIP → ~0.45
    core = clamp((1.0 / max(fip, 1.0)) * 2.5, 0.0, 1.0)

    # Command bonus: K/BB ratio
    k_bb = k_per_9 / max(bb_per_9, 0.5)
    command_bonus = 0.08 if k_bb > 3.0 else 0.0

    # Recent form: improvement vs season → bonus, regression → penalty
    era_diff = era - last_5_era
    if era_diff > 0.5:
        recent_bonus = 0.05   # improving (last 5 ERA lower than season)
    elif era_diff < -0.5:
        recent_bonus = -0.08  # regressing
    else:
        recent_bonus = 0.0

    # Stamina: short starters force early bullpen usage
    stamina_penalty = -0.10 if ip_avg < 5.0 else 0.0

    score = core + command_bonus + recent_bonus + stamina_penalty
    return round(clamp(score, 0.0, 1.0), 4)


# ---------------------------------------------------------------------------
# Bullpen contribution
# ---------------------------------------------------------------------------

def calculate_bullpen_contribution(
    bullpen_stats: dict[str, Any] | None,
    fatigue_data: dict[str, Any] | None = None,
) -> float:
    """Score a bullpen unit on a 0-1 scale.

    Parameters
    ----------
    bullpen_stats : dict with optional keys:
        closer_era, setup_era, leverage_era,
        save_opportunities_converted (0-1 ratio)
    fatigue_data : dict with optional key:
        usage_last_3_days (int)

    Returns
    -------
    float normalised 0-1 (1 = elite, 0 = terrible)
    """
    if not bullpen_stats:
        return 0.45  # unknown → below average

    closer_era = safe_float(bullpen_stats.get("closer_era"), 3.80)
    setup_era = safe_float(bullpen_stats.get("setup_era"), 3.80)
    leverage_era = safe_float(bullpen_stats.get("leverage_era"), 4.00)
    save_pct = safe_float(bullpen_stats.get("save_opportunities_converted"), 0.60)

    # Weighted ERA composite (lower is better)
    composite_era = closer_era * 0.40 + setup_era * 0.35 + leverage_era * 0.25

    # Inverse ERA score, scaled so 2.0 ERA → ~1.0, 5.0 ERA → ~0.40
    base = clamp((1.0 / max(composite_era, 1.0)) * 2.5, 0.0, 1.0)

    # Fatigue penalty
    usage = int((fatigue_data or {}).get("usage_last_3_days", 0))
    if usage > 5:
        fatigue_penalty = -0.12
    elif usage > 3:
        fatigue_penalty = -0.06
    else:
        fatigue_penalty = 0.0

    # Save conversion bonus
    save_bonus = 0.05 if save_pct > 0.70 else 0.0

    score = base + fatigue_penalty + save_bonus
    return round(clamp(score, 0.0, 1.0), 4)


# ---------------------------------------------------------------------------
# Narrative generation
# ---------------------------------------------------------------------------

def _build_narrative(
    home_combined: float,
    away_combined: float,
    home_name: str,
    away_name: str,
    home_contributors: list[dict],
    away_contributors: list[dict],
    home_risks: list[dict],
    away_risks: list[dict],
) -> str:
    """Generate a 1-2 sentence narrative about the player matchup."""
    delta = home_combined - away_combined

    if abs(delta) < 0.02:
        return (
            f"Player-level matchup antara {away_name} dan {home_name} "
            f"sangat seimbang — tidak ada keunggulan signifikan dari sisi mana pun."
        )

    stronger = home_name if delta > 0 else away_name
    weaker = away_name if delta > 0 else home_name
    stronger_contribs = home_contributors if delta > 0 else away_contributors
    weaker_risks = away_risks if delta > 0 else home_risks

    strength_parts = []
    if stronger_contribs:
        top = stronger_contribs[0]
        strength_parts.append(f"{top['name']} ({top['reason']})")

    risk_parts = []
    if weaker_risks:
        top_risk = weaker_risks[0]
        risk_parts.append(f"{top_risk['name']} ({top_risk['reason']})")

    magnitude = "tipis" if abs(delta) < 0.08 else "signifikan"

    narrative = f"{stronger} memiliki keunggulan player-level {magnitude} atas {weaker}"
    if strength_parts:
        narrative += f", ditopang oleh {strength_parts[0]}"
    if risk_parts:
        narrative += f"; {weaker} terbebani {risk_parts[0]}"
    narrative += "."

    return narrative


# ---------------------------------------------------------------------------
# Public API — full team score
# ---------------------------------------------------------------------------

def calculate_team_player_score(
    home_lineup: list[dict[str, Any]] | None,
    away_lineup: list[dict[str, Any]] | None,
    home_sp: dict[str, Any] | None,
    away_sp: dict[str, Any] | None,
    home_bullpen: dict[str, Any] | None,
    away_bullpen: dict[str, Any] | None,
    game_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Calculate comprehensive player-level scores for both teams.

    Parameters
    ----------
    home_lineup, away_lineup : list of batter dicts (see calculate_lineup_contribution)
    home_sp, away_sp         : pitcher stats dicts (see calculate_sp_contribution)
    home_bullpen, away_bullpen : bullpen stats dicts (see calculate_bullpen_contribution)
    game_context             : dict with at least "home_name", "away_name"

    Returns
    -------
    dict with "home", "away", "delta", "narrative" keys.
    """
    ctx = game_context or {}
    home_name = ctx.get("home_name", "Home")
    away_name = ctx.get("away_name", "Away")

    # Determine opposing SP handedness for platoon calc
    home_sp_hand = (home_sp or {}).get("throws", "R")
    away_sp_hand = (away_sp or {}).get("throws", "R")

    # Lineup scores
    home_lineup_score, home_contributors, home_risks = calculate_lineup_contribution(
        home_lineup, opposing_sp_hand=away_sp_hand, return_details=True
    )
    away_lineup_score, away_contributors, away_risks = calculate_lineup_contribution(
        away_lineup, opposing_sp_hand=home_sp_hand, return_details=True
    )

    # SP scores
    home_sp_score = calculate_sp_contribution(home_sp)
    away_sp_score = calculate_sp_contribution(away_sp)

    # Bullpen scores
    home_bp_data = ctx.get("home_fatigue_data")
    away_bp_data = ctx.get("away_fatigue_data")
    home_bp_score = calculate_bullpen_contribution(home_bullpen, home_bp_data)
    away_bp_score = calculate_bullpen_contribution(away_bullpen, away_bp_data)

    # Combined score: lineup contributes most to the "player-level" adjustment
    # SP and bullpen have their own weight channels, so their contribution here
    # is a secondary signal about *how much better* one side's unit is than the
    # other's.
    def combined(lineup: float, sp: float, bp: float) -> float:
        return round(lineup * 0.50 + sp * 0.30 + bp * 0.20, 4)

    home_combined = combined(home_lineup_score, home_sp_score, home_bp_score)
    away_combined = combined(away_lineup_score, away_sp_score, away_bp_score)

    delta = round(home_combined - away_combined, 4)

    narrative = _build_narrative(
        home_combined, away_combined,
        home_name, away_name,
        home_contributors, away_contributors,
        home_risks, away_risks,
    )

    return {
        "home": {
            "lineup_score": home_lineup_score,
            "sp_score": home_sp_score,
            "bullpen_score": home_bp_score,
            "combined_score": home_combined,
            "key_contributors": home_contributors,
            "key_risks": home_risks,
        },
        "away": {
            "lineup_score": away_lineup_score,
            "sp_score": away_sp_score,
            "bullpen_score": away_bp_score,
            "combined_score": away_combined,
            "key_contributors": away_contributors,
            "key_risks": away_risks,
        },
        "delta": delta,
        "narrative": narrative,
    }
