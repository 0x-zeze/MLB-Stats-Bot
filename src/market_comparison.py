"""Market comparison layer for model probability versus betting markets."""

from __future__ import annotations

from typing import Any

from .odds import american_odds_to_implied_probability, calculate_edge
from .sharp_money import detect_sharp_money_signal, sharp_money_risk_factor
from .utils import safe_float


def market_implied_probability(odds: Any) -> float | None:
    """Convert American odds to implied probability when available."""
    if odds in (None, ""):
        return None
    return american_odds_to_implied_probability(str(odds))


def detect_line_movement(market: dict[str, Any]) -> dict[str, Any]:
    """Detect simple total line movement from opening to current number."""
    opening = safe_float(market.get("opening_total"), 0.0)
    current = safe_float(market.get("current_total"), 0.0) or safe_float(
        market.get("market_total"), 0.0
    )
    movement = current - opening if opening > 0 and current > 0 else 0.0
    return {
        "opening_total": opening or None,
        "current_total": current or None,
        "movement": movement,
        "moved_heavily": abs(movement) >= 0.75,
    }


def compare_moneyline_market(
    prediction: dict[str, Any],
    market: dict[str, Any],
) -> dict[str, Any]:
    """Compare deterministic moneyline probability against market implied probability."""
    home_market_probability = market_implied_probability(market.get("home_moneyline"))
    away_market_probability = market_implied_probability(market.get("away_moneyline"))
    home_edge = (
        calculate_edge(prediction["home_win_probability"], home_market_probability)
        if home_market_probability is not None
        else None
    )
    away_edge = (
        calculate_edge(prediction["away_win_probability"], away_market_probability)
        if away_market_probability is not None
        else None
    )
    pick_edge = (
        home_edge
        if prediction["predicted_winner"] == market.get("home_team")
        else away_edge
    )
    return {
        "home_market_implied_probability": home_market_probability,
        "away_market_implied_probability": away_market_probability,
        "home_edge": home_edge,
        "away_edge": away_edge,
        "pick_edge": pick_edge,
        "line_movement": detect_line_movement(market),
    }


def compare_total_market(
    prediction: dict[str, Any],
    market: dict[str, Any],
) -> dict[str, Any]:
    """Compare deterministic total projection against market total."""
    market_total = safe_float(market.get("market_total"), 0.0)
    projected_total = safe_float(prediction.get("projected_total_runs"), 0.0)
    total_difference = projected_total - market_total if market_total > 0 else None
    return {
        "market_total": market_total or None,
        "projected_total": projected_total,
        "total_difference": total_difference,
        "model_edge": prediction.get("model_edge"),
        "line_movement": detect_line_movement(market),
    }


def compare_markets(
    predictions: dict[str, Any],
    collected: dict[str, Any],
) -> dict[str, Any]:
    """Run all market comparison checks for the pipeline."""
    market = collected["market"]
    if not market.get("available"):
        return {
            "available": False,
            "moneyline": {},
            "totals": {},
            "line_movement": detect_line_movement(market),
            "sharp_money": None,
        }

    moneyline_comparison = compare_moneyline_market(predictions["moneyline"], market)
    totals_comparison = compare_total_market(predictions["totals"], market)

    model_pick = predictions["moneyline"].get("predicted_winner", "")
    model_prob = predictions["moneyline"].get("home_win_probability", 0.5)
    opening_odds = {
        "home": market.get("opening_home_moneyline") or market.get("home_moneyline"),
        "away": market.get("opening_away_moneyline") or market.get("away_moneyline"),
    }
    closing_odds = {
        "home": market.get("home_moneyline"),
        "away": market.get("away_moneyline"),
    }
    sharp_signal = detect_sharp_money_signal(
        model_pick=model_pick,
        model_probability=model_prob,
        opening_odds=opening_odds,
        closing_odds=closing_odds,
    )

    return {
        "available": True,
        "moneyline": moneyline_comparison,
        "totals": totals_comparison,
        "line_movement": detect_line_movement(market),
        "sharp_money": {
            "direction": sharp_signal.sharp_money_direction,
            "movement_magnitude": sharp_signal.movement_magnitude,
            "reverse_line_movement": sharp_signal.reverse_line_movement,
            "steam_move": sharp_signal.steam_move_detected,
            "risk_factor": sharp_money_risk_factor(sharp_signal),
        },
    }
