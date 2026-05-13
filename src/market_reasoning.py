"""Market-aware reasoning layer for MLB predictions.

Provides edge decomposition (offense vs pitching vs bullpen), "why market
is wrong" analysis, and line value assessment.  Deterministic probabilities
are preserved; this layer adds structured reasoning about *why* the model
may disagree with the market.
"""

from __future__ import annotations

from typing import Any

from .utils import clamp, safe_float


def decompose_edge(
    prediction: dict[str, Any],
    game_context: dict[str, Any],
) -> dict[str, Any]:
    """Break the model edge into component sources.

    Returns a dict with:
    - offense_edge: runs edge from offensive matchup
    - pitching_edge: runs edge from starting pitcher matchup
    - bullpen_edge: runs edge from bullpen quality/fatigue
    - park_edge: runs edge from park factor
    - weather_edge: runs edge from weather conditions
    - total_edge: sum of component edges
    - dominant_factor: which component contributes the most edge
    """
    breakdown = (
        prediction.get("model_breakdown")
        or prediction.get("modelBreakdown")
        or {}
    )
    if not isinstance(breakdown, dict):
        breakdown = {}

    offense = safe_float(
        breakdown.get("offenseEdge")
        or breakdown.get("offense_edge")
        or breakdown.get("lineupEdge")
        or breakdown.get("lineup_edge"),
        0.0,
    )
    pitching = safe_float(
        breakdown.get("starterEdge")
        or breakdown.get("starter_edge")
        or breakdown.get("pitchingEdge")
        or breakdown.get("pitching_edge"),
        0.0,
    )
    bullpen = safe_float(
        breakdown.get("bullpenEdge")
        or breakdown.get("bullpen_edge"),
        0.0,
    )
    park = safe_float(
        breakdown.get("parkEdge")
        or breakdown.get("park_edge")
        or breakdown.get("parkFactor"),
        0.0,
    )
    weather = safe_float(
        breakdown.get("weatherEdge")
        or breakdown.get("weather_edge"),
        0.0,
    )
    record = safe_float(
        breakdown.get("recordContextEdge")
        or breakdown.get("record_context_edge"),
        0.0,
    )
    matchup = safe_float(
        breakdown.get("matchupEdge")
        or breakdown.get("matchup_edge"),
        0.0,
    )

    components = {
        "offense": round(offense, 4),
        "pitching": round(pitching, 4),
        "bullpen": round(bullpen, 4),
        "park": round(park, 4),
        "weather": round(weather, 4),
        "record_context": round(record, 4),
        "matchup": round(matchup, 4),
    }

    abs_components = {k: abs(v) for k, v in components.items()}
    dominant = max(abs_components, key=abs_components.get) if any(abs_components.values()) else "none"
    total = sum(components.values())

    return {
        **components,
        "total_edge": round(total, 4),
        "dominant_factor": dominant,
    }


def _market_movement(game_context: dict[str, Any]) -> dict[str, float]:
    """Extract opening vs current market movement."""
    market = game_context.get("market") or game_context.get("odds") or {}
    opening_ml = safe_float(market.get("opening_moneyline"), 0.0)
    current_ml = safe_float(
        market.get("current_moneyline") or market.get("moneyline"), 0.0
    )
    opening_total = safe_float(market.get("opening_total"), 0.0)
    current_total = safe_float(
        market.get("current_total") or market.get("market_total"), 0.0
    )
    return {
        "opening_moneyline": opening_ml,
        "current_moneyline": current_ml,
        "ml_movement": round(current_ml - opening_ml, 1) if opening_ml != 0 else 0.0,
        "opening_total": opening_total,
        "current_total": current_total,
        "total_movement": round(current_total - opening_total, 1) if opening_total != 0 else 0.0,
    }


def _steam_move_detected(game_context: dict[str, Any]) -> bool:
    """Detect if there's a steam move (rapid line movement suggesting sharp money)."""
    movement = _market_movement(game_context)
    # Steam moves typically: >15c moneyline movement or >0.5 run total movement
    return abs(movement["ml_movement"]) >= 15.0 or abs(movement["total_movement"]) >= 0.5


def analyze_market_disagreement(
    prediction: dict[str, Any],
    game_context: dict[str, Any],
) -> dict[str, Any]:
    """Explain *why* the model may disagree with the market.

    Returns:
    - model_edge_pct: the model's edge as a percentage
    - market_movement: opening vs current line data
    - steam_move: whether a steam move was detected
    - reasons: list of human-readable reasons the model disagrees
    - value_assessment: "strong_value", "marginal_value", "no_value", "market_aligned"
    - line_value_score: 0-100 score of how much value the pick has
    """
    edge = safe_float(prediction.get("model_edge"), 0.0)
    market = str(prediction.get("market_type") or game_context.get("market_type") or "moneyline").lower()
    decomposition = decompose_edge(prediction, game_context)
    movement = _market_movement(game_context)
    steam = _steam_move_detected(game_context)

    reasons: list[str] = []

    # Check dominant factor alignment
    dominant = decomposition.get("dominant_factor", "none")
    if dominant == "pitching" and abs(decomposition.get("pitching", 0)) >= 0.15:
        reasons.append(
            f"Starting pitcher matchup is the primary edge source "
            f"({decomposition['pitching']:+.3f})"
        )
    if dominant == "offense" and abs(decomposition.get("offense", 0)) >= 0.10:
        reasons.append(
            f"Lineup/offense matchup provides a meaningful edge "
            f"({decomposition['offense']:+.3f})"
        )
    if dominant == "bullpen" and abs(decomposition.get("bullpen", 0)) >= 0.08:
        reasons.append(
            f"Bullpen quality/fatigue difference is significant "
            f"({decomposition['bullpen']:+.3f})"
        )

    # Market movement analysis
    if steam:
        if movement["ml_movement"] != 0:
            direction = "toward" if movement["ml_movement"] > 0 else "away from"
            reasons.append(
                f"Steam move detected: moneyline moved {movement['ml_movement']:+.0f}c "
                f"{direction} the pick"
            )
        if abs(movement["total_movement"]) >= 0.5:
            reasons.append(
                f"Total line moved {movement['total_movement']:+.1f} runs — "
                f"sharp money may disagree"
            )

    # Late lineup/pitcher news check
    quality = game_context.get("quality_report") or {}
    if quality.get("probable_pitchers") == "Projected":
        reasons.append("Probable pitchers not yet confirmed — market may not price true starter")
    if quality.get("lineup") in ("Projected", "Missing"):
        reasons.append("Lineup not confirmed — offensive projections may be off")

    # Opener situation
    opener = game_context.get("opener_situation") or {}
    if isinstance(opener, dict) and opener.get("is_opener"):
        reasons.append(
            f"Opener situation detected — bullpen usage pattern is non-standard, "
            f"market may underprice uncertainty"
        )

    # Value assessment
    abs_edge = abs(edge)
    if abs_edge >= 5.0:
        value = "strong_value"
        line_value_score = min(100, int(50 + abs_edge * 5))
    elif abs_edge >= 2.5:
        value = "marginal_value"
        line_value_score = int(30 + abs_edge * 8)
    elif abs_edge >= 1.0:
        value = "lean_value"
        line_value_score = int(15 + abs_edge * 15)
    else:
        value = "no_value"
        line_value_score = max(0, int(abs_edge * 10))

    # Adjust for steam move conflicting with model
    if steam and movement["ml_movement"] != 0:
        model_direction = 1 if safe_float(prediction.get("model_edge"), 0) > 0 else -1
        market_direction = 1 if movement["ml_movement"] > 0 else -1
        if model_direction != market_direction:
            line_value_score = max(0, line_value_score - 15)
            reasons.append(
                "Steam move is in the opposite direction of the model pick — "
                "exercise caution"
            )

    if not reasons:
        reasons.append("Model and market are broadly aligned — limited disagreement context")

    return {
        "model_edge_pct": round(edge, 2),
        "market_movement": movement,
        "steam_move": steam,
        "reasons": reasons,
        "value_assessment": value,
        "line_value_score": clamp(line_value_score, 0, 100),
        "edge_decomposition": decomposition,
    }


def format_market_reasoning(analysis: dict[str, Any]) -> str:
    """Render market reasoning as a compact human-readable string."""
    lines: list[str] = []
    lines.append(f"Value: {analysis.get('value_assessment', 'unknown')} "
                 f"(score: {analysis.get('line_value_score', 0)}/100)")
    lines.append(f"Model edge: {analysis.get('model_edge_pct', 0):+.1f}%")

    movement = analysis.get("market_movement") or {}
    if movement.get("total_movement"):
        lines.append(f"Total line moved: {movement['total_movement']:+.1f}")
    if movement.get("ml_movement"):
        lines.append(f"ML moved: {movement['ml_movement']:+.0f}c")

    if analysis.get("steam_move"):
        lines.append("⚡ Steam move detected")

    for reason in analysis.get("reasons", []):
        lines.append(f"• {reason}")

    decomposition = analysis.get("edge_decomposition") or {}
    dominant = decomposition.get("dominant_factor", "none")
    if dominant != "none":
        lines.append(f"Dominant edge source: {dominant}")

    return "\n".join(lines)


def compute_edge_attribution(
    starter_edge: float = 0.0,
    lineup_edge: float = 0.0,
    bullpen_edge: float = 0.0,
    offense_edge: float = 0.0,
    park_factor: float = 0.0,
    weather_adjustment: float = 0.0,
    data_quality: float = 100.0,
) -> dict[str, Any]:
    """Attribute model edge to individual components with contribution percentages.

    Provides a cleaner API for edge decomposition that accepts individual
    edge components rather than prediction/context dicts.

    Returns:
        dict with:
        - components: dict[str, float] mapping factor name to edge value
        - total_edge: float sum of all component edges
        - largest_driver: str name of the component contributing the most
        - largest_contribution_pct: float percentage of the largest driver
        - confidence_adjusted_edge: float edge scaled by data quality
        - confidence_tier: "High", "Medium", or "Low"
    """
    components: dict[str, float] = {
        "starting_pitcher": round(starter_edge, 4),
        "lineup": round(lineup_edge, 4),
        "bullpen": round(bullpen_edge, 4),
        "offense": round(offense_edge, 4),
        "park_factor": round(park_factor, 4),
        "weather": round(weather_adjustment, 4),
    }

    abs_total = sum(abs(v) for v in components.values())
    total_edge = sum(components.values())

    largest_driver = None
    largest_contribution_pct = 0.0
    if abs_total > 0:
        largest_driver = max(components, key=lambda k: abs(components[k]))
        largest_contribution_pct = round(abs(components[largest_driver]) / abs_total * 100, 1)

    # Scale edge by data quality (0.5 at quality=0, 1.0 at quality=100)
    dq_multiplier = clamp(0.5 + (data_quality / 200.0), 0.5, 1.0)
    confidence_adjusted_edge = round(abs(total_edge) * dq_multiplier, 4)

    if confidence_adjusted_edge >= 0.15 and data_quality >= 80:
        confidence_tier = "High"
    elif confidence_adjusted_edge >= 0.05 or data_quality >= 70:
        confidence_tier = "Medium"
    else:
        confidence_tier = "Low"

    return {
        "components": components,
        "total_edge": round(total_edge, 4),
        "largest_driver": largest_driver,
        "largest_contribution_pct": largest_contribution_pct,
        "confidence_adjusted_edge": confidence_adjusted_edge,
        "confidence_tier": confidence_tier,
    }


def explain_market_disagreement(
    model_probability: float,
    market_implied_probability: float,
    market_type: str = "moneyline",
) -> dict[str, Any]:
    """Explain the gap between model probability and market-implied probability.

    Returns:
        dict with:
        - model_probability: float
        - market_implied_probability: float
        - gap: float (positive = model sees more value)
        - direction: "model_higher" or "market_higher"
        - magnitude: "small", "moderate", or "large"
        - explanation: str human-readable explanation
    """
    gap = round(model_probability - market_implied_probability, 4)
    direction = "model_higher" if gap > 0 else "market_higher"
    abs_gap = abs(gap)

    if abs_gap >= 0.08:
        magnitude = "large"
    elif abs_gap >= 0.03:
        magnitude = "moderate"
    else:
        magnitude = "small"

    if market_type == "totals":
        if direction == "model_higher":
            explanation = (
                f"Model projects a higher total than the market implies "
                f"(gap: {abs_gap:.1%}). The Over may have value."
            )
        else:
            explanation = (
                f"Model projects a lower total than the market implies "
                f"(gap: {abs_gap:.1%}). The Under may have value."
            )
    else:
        if direction == "model_higher":
            explanation = (
                f"Model sees the pick as {abs_gap:.1%} more likely to win "
                f"than the market implies ({magnitude} disagreement)."
            )
        else:
            explanation = (
                f"Market implies a higher win probability than the model "
                f"(gap: {abs_gap:.1%}). Model may be underpricing "
                f"market intelligence."
            )

    return {
        "model_probability": model_probability,
        "market_implied_probability": market_implied_probability,
        "gap": round(gap, 4),
        "direction": direction,
        "magnitude": magnitude,
        "explanation": explanation,
    }


def detect_steam_move(
    opening_line: float | None = None,
    current_line: float | None = None,
    opening_total: float | None = None,
    current_total: float | None = None,
) -> dict[str, Any]:
    """Detect steam moves from opening → current line movement.

    A steam move is rapid line movement caused by sharp/professional
    money hitting the market simultaneously.

    Returns:
        dict with:
        - steam_detected: bool
        - ml_movement: float or None (in cents)
        - total_movement: float or None (in runs)
        - direction: str or None
        - magnitude: "none", "moderate", or "heavy"
    """
    ml_movement = None
    total_movement = None
    steam_detected = False
    direction = None
    magnitude = "none"

    if opening_line is not None and current_line is not None:
        ml_movement = round(current_line - opening_line, 1)
        if abs(ml_movement) >= 20:
            steam_detected = True
            magnitude = "heavy"
            # Toward favorite = negative movement (line gets more negative)
            direction = "toward_favorite" if ml_movement < 0 else "toward_underdog"
        elif abs(ml_movement) >= 10:
            steam_detected = True
            magnitude = "moderate"
            direction = "toward_favorite" if ml_movement < 0 else "toward_underdog"

    if opening_total is not None and current_total is not None:
        total_movement = round(current_total - opening_total, 1)
        if abs(total_movement) >= 1.0:
            steam_detected = True
            magnitude = "heavy"
            direction = "over" if total_movement > 0 else "under"
        elif abs(total_movement) >= 0.5:
            if not steam_detected:
                magnitude = "moderate"
            steam_detected = True
            direction = "over" if total_movement > 0 else "under"

    return {
        "steam_detected": steam_detected,
        "ml_movement": ml_movement,
        "total_movement": total_movement,
        "direction": direction,
        "magnitude": magnitude,
    }


def build_market_reasoning(
    *,
    model_probability: float,
    market_implied_probability: float,
    opening_line: float | None = None,
    current_line: float | None = None,
    opening_total: float | None = None,
    current_total: float | None = None,
    starter_edge: float = 0.0,
    lineup_edge: float = 0.0,
    bullpen_edge: float = 0.0,
    offense_edge: float = 0.0,
    park_factor: float = 0.0,
    weather_adjustment: float = 0.0,
    data_quality: float = 100.0,
    market_type: str = "moneyline",
) -> dict[str, Any]:
    """Build complete market reasoning combining edge attribution, disagreement
    analysis, and steam move detection.

    Returns:
        dict with:
        - edge_attribution: from compute_edge_attribution
        - market_disagreement: from explain_market_disagreement
        - steam_move: from detect_steam_move
        - summary: str human-readable summary of all reasoning
    """
    attribution = compute_edge_attribution(
        starter_edge=starter_edge,
        lineup_edge=lineup_edge,
        bullpen_edge=bullpen_edge,
        offense_edge=offense_edge,
        park_factor=park_factor,
        weather_adjustment=weather_adjustment,
        data_quality=data_quality,
    )
    disagreement = explain_market_disagreement(
        model_probability=model_probability,
        market_implied_probability=market_implied_probability,
        market_type=market_type,
    )
    steam = detect_steam_move(
        opening_line=opening_line,
        current_line=current_line,
        opening_total=opening_total,
        current_total=current_total,
    )

    # Build summary
    summary_parts: list[str] = []
    driver = attribution.get("largest_driver")
    if driver:
        pct = attribution["largest_contribution_pct"]
        summary_parts.append(
            f"Primary edge driver: {driver} ({pct:.0f}% of total edge)"
        )

    summary_parts.append(
        f"Model-market gap: {disagreement['gap']:+.1%} ({disagreement['magnitude']})"
    )

    if steam["steam_detected"]:
        summary_parts.append(
            f"Steam move detected ({steam['magnitude']}): {steam['direction']}"
        )

    summary_parts.append(
        f"Confidence tier: {attribution['confidence_tier']} "
        f"(adjusted edge: {attribution['confidence_adjusted_edge']:.3f})"
    )

    return {
        "edge_attribution": attribution,
        "market_disagreement": disagreement,
        "steam_move": steam,
        "summary": ". ".join(summary_parts) + ".",
    }
