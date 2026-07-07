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
            "sharp_money": None,
        }

    moneyline_comparison = compare_moneyline_market(predictions["moneyline"], market)
    model_pick = predictions["moneyline"].get("predicted_winner", "")
    model_prob = predictions["moneyline"].get("home_win_probability", 0.5)
    # predicted_winner is a team name; odds below are keyed by "home"/"away".
    # Resolve the pick side so sharp-money detection looks up the right odds.
    pick_side = (
        "home" if model_pick and model_pick == market.get("home_team")
        else "away" if model_pick and model_pick == market.get("away_team")
        else "home"
    )
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
        pick_side=pick_side,
    )

    return {
        "available": True,
        "moneyline": moneyline_comparison,
        "sharp_money": {
            "direction": sharp_signal.sharp_money_direction,
            "movement_magnitude": sharp_signal.movement_magnitude,
            "reverse_line_movement": sharp_signal.reverse_line_movement,
            "steam_move": sharp_signal.steam_move_detected,
            "risk_factor": sharp_money_risk_factor(sharp_signal),
        },
    }
