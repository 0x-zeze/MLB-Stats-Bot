"""Clear modular MLB prediction pipeline.

Pipeline order:
1. Data collection
2. Feature engineering
3. Prediction
4. Market comparison
5. Quality control
6. Explanation
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .data_collection import collect_game_data
from .explanation_layer import build_prediction_explanation
from .feature_engineering_layer import build_game_features
from .market_comparison import compare_markets
from .prediction_layer import build_predictions
from .quality_control import apply_confidence_downgrade, generate_quality_report


def _apply_market_to_moneyline(
    prediction: dict[str, Any],
    market_comparison: dict[str, Any],
) -> dict[str, Any]:
    output = deepcopy(prediction)
    moneyline_market = market_comparison.get("moneyline", {})
    output.update(
        {
            "home_market_implied_probability": moneyline_market.get("home_market_implied_probability"),
            "away_market_implied_probability": moneyline_market.get("away_market_implied_probability"),
            "home_edge": moneyline_market.get("home_edge"),
            "away_edge": moneyline_market.get("away_edge"),
            "model_edge": moneyline_market.get("pick_edge"),
        }
    )
    return output


def _supporting_factors(moneyline: dict[str, Any], totals: dict[str, Any]) -> list[str]:
    factors = []
    factors.extend(moneyline.get("main_factors", []))
    factors.extend(totals.get("main_factors", []))
    unique: list[str] = []
    for factor in factors:
        if factor not in unique:
            unique.append(factor)
    return unique


def run_prediction_pipeline(game_id: str | int) -> dict[str, Any]:
    """Run one game through the full conservative pipeline."""
    collected = collect_game_data(game_id)
    features = build_game_features(collected)
    raw_predictions = build_predictions(collected, features)
    market_comparison = compare_markets(raw_predictions, collected)
    quality_report = generate_quality_report(collected["context"])

    moneyline_prediction = _apply_market_to_moneyline(
        raw_predictions["moneyline"],
        market_comparison,
    )
    moneyline = apply_confidence_downgrade(moneyline_prediction, quality_report)
    totals = apply_confidence_downgrade(raw_predictions["totals"], quality_report)
    supporting_factors = _supporting_factors(moneyline, totals)

    result = {
        "stages": {
            "data_collection": "complete",
            "feature_engineering": "complete",
            "prediction": "complete",
            "market_comparison": "complete",
            "quality_control": "complete",
            "explanation": "complete",
        },
        "game": collected["game"],
        "context": collected["context"],
        "market": collected["market"],
        "features": features,
        "raw_predictions": raw_predictions,
        "market_comparison": market_comparison,
        "quality_report": totals.get("quality_report", quality_report),
        "moneyline": moneyline,
        "totals": totals,
        "supporting_factors": supporting_factors,
    }
    result["explanation"] = build_prediction_explanation(result)
    return result
