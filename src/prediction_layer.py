"""Prediction layer for deterministic MLB model outputs."""

from __future__ import annotations

from typing import Any

from .model import BaselinePredictionModel
from .totals import predict_total_runs as predict_total_runs_model


def predict_moneyline_from_features(
    collected: dict[str, Any],
    features: dict[str, Any],
) -> dict[str, Any]:
    """Produce deterministic moneyline probability from engineered features."""
    result = BaselinePredictionModel().predict(
        collected["home_team"],
        collected["away_team"],
        collected["home_pitcher"],
        collected["away_pitcher"],
    )
    return {
        "matchup": collected["context"]["matchup"],
        "home_win_probability": result.home_win_probability,
        "away_win_probability": result.away_win_probability,
        "predicted_winner": result.predicted_winner,
        "final_lean": result.predicted_winner,
        "confidence": result.confidence,
        "components": features["moneyline"]["components"]
        | {"defense": 0.0, "injuries_lineup": 0.0, "market_odds": 0.0},
        "market": collected["market"],
        "main_factors": result.main_factors,
        "market_type": "moneyline",
        "source": "deterministic_python_model",
    }


def predict_totals_from_features(
    collected: dict[str, Any],
    features: dict[str, Any],
) -> dict[str, Any]:
    """Produce deterministic team runs, total runs, and O/U probabilities."""
    market_total = features["totals"].get("market_total")
    result = predict_total_runs_model(
        collected["home_team"],
        collected["away_team"],
        collected["total_context"],
        market_total=market_total,
    )
    return {
        "matchup": collected["context"]["matchup"],
        "home_expected_runs": result.home_expected_runs,
        "away_expected_runs": result.away_expected_runs,
        "projected_total_runs": result.projected_total_runs,
        "market_total": result.market_total,
        "over_probabilities": result.over_probabilities,
        "under_probabilities": result.under_probabilities,
        "best_total_lean": result.best_total_lean,
        "final_lean": result.best_total_lean,
        "confidence": result.confidence,
        "model_edge": result.model_edge,
        "market_type": "totals",
        "main_factors": result.main_factors,
        "source": "deterministic_python_model",
    }


def build_predictions(collected: dict[str, Any], features: dict[str, Any]) -> dict[str, Any]:
    """Build all deterministic predictions for one game."""
    return {
        "moneyline": predict_moneyline_from_features(collected, features),
        "totals": predict_totals_from_features(collected, features),
    }
