"""Prediction layer for deterministic MLB model outputs."""

from __future__ import annotations

from typing import Any

from .first_inning import FirstInningContext, predict_first_inning
from .model import BaselinePredictionModel
from .probability_calibrator import calibrate
from .situational_weights import SituationalWeightEngine, classify_park_type, determine_seasonal_phase
from .utils import clamp, confidence_label, logistic, safe_float


def predict_moneyline_from_features(
    collected: dict[str, Any],
    features: dict[str, Any],
    weight_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Produce deterministic moneyline probability from engineered features."""
    # Compute situational weights (or use overrides from dynamic_weights)
    moneyline_features = features["moneyline"]

    if weight_overrides:
        weights = dict(weight_overrides)
    else:
        park_factor = None
        park_data = collected.get("park")
        if park_data is not None:
            park_factor = safe_float(getattr(park_data, "run_factor", None), None)

        opener_flag = moneyline_features.get("opener_flag", False)
        game = collected.get("game")
        game_date_str = getattr(game, "date", None) if game else None

        engine = SituationalWeightEngine()
        weights = engine.compute_weights_from_context(
            park_run_factor=park_factor,
            opener_detected=opener_flag,
            short_start_projected=False,
            game_date=game_date_str,
        )

    result = BaselinePredictionModel().predict(
        collected["home_team"],
        collected["away_team"],
        collected["home_pitcher"],
        collected["away_pitcher"],
        weight_overrides=weights,
    )
    model = BaselinePredictionModel()
    components = moneyline_features["components"]
    rating_difference = sum(
        weights.get(name, 0.0) * value for name, value in components.items()
    )
    raw_home_probability = clamp(logistic(rating_difference), 0.05, 0.95)
    home_probability = calibrate(raw_home_probability)
    away_probability = 1.0 - home_probability
    predicted_winner = (
        collected["home_team"].team
        if home_probability >= 0.5
        else collected["away_team"].team
    )

    return {
        "matchup": collected["context"]["matchup"],
        "home_win_probability": home_probability,
        "away_win_probability": away_probability,
        "predicted_winner": predicted_winner,
        "final_lean": predicted_winner,
        "confidence": confidence_label(home_probability),
        "components": components | {"defense": 0.0, "injuries_lineup": 0.0, "market_odds": 0.0},
        "market": collected["market"],
        "main_factors": model._main_factors(components, home_probability >= 0.5),
        "market_type": "moneyline",
        "rating_difference": rating_difference,
        "situational_weights": weights,
        "baseline_without_fatigue": {
            "home_win_probability": result.home_win_probability,
            "away_win_probability": result.away_win_probability,
            "predicted_winner": result.predicted_winner,
        },
        "source": "deterministic_python_model",
    }


def predict_first_inning_from_features(
    collected: dict[str, Any],
    features: dict[str, Any],
) -> dict[str, Any]:
    """Produce deterministic first-inning YRFI/NRFI prediction."""
    home_pitcher = collected.get("home_pitcher")
    away_pitcher = collected.get("away_pitcher")
    park = collected.get("park")

    context = FirstInningContext(
        away_first_inning_scoring_rate=safe_float(
            features.get("first_inning", {}).get("away_first_inning_scoring_rate"), 0.27
        ),
        home_first_inning_scoring_rate=safe_float(
            features.get("first_inning", {}).get("home_first_inning_scoring_rate"), 0.27
        ),
        away_first_inning_allowed_rate=safe_float(
            features.get("first_inning", {}).get("away_first_inning_allowed_rate"), 0.27
        ),
        home_first_inning_allowed_rate=safe_float(
            features.get("first_inning", {}).get("home_first_inning_allowed_rate"), 0.27
        ),
        away_pitcher_first_inning_era=safe_float(
            getattr(away_pitcher, "first_inning_era", None), 4.50
        ) if away_pitcher else 4.50,
        home_pitcher_first_inning_era=safe_float(
            getattr(home_pitcher, "first_inning_era", None), 4.50
        ) if home_pitcher else 4.50,
        away_pitcher_first_inning_whip=safe_float(
            getattr(away_pitcher, "first_inning_whip", None), 1.40
        ) if away_pitcher else 1.40,
        home_pitcher_first_inning_whip=safe_float(
            getattr(home_pitcher, "first_inning_whip", None), 1.40
        ) if home_pitcher else 1.40,
        away_leadoff_obp=safe_float(
            features.get("first_inning", {}).get("away_leadoff_obp"), 0.330
        ),
        home_leadoff_obp=safe_float(
            features.get("first_inning", {}).get("home_leadoff_obp"), 0.330
        ),
        away_pitcher_first_pitch_strike_rate=safe_float(
            getattr(away_pitcher, "first_pitch_strike_rate", None), 0.60
        ) if away_pitcher else 0.60,
        home_pitcher_first_pitch_strike_rate=safe_float(
            getattr(home_pitcher, "first_pitch_strike_rate", None), 0.60
        ) if home_pitcher else 0.60,
        venue_yrfi_rate=safe_float(
            features.get("first_inning", {}).get("venue_yrfi_rate"), 0.46
        ),
        park_run_factor=safe_float(
            getattr(park, "run_factor", None), 100.0
        ) if park else 100.0,
        away_pitcher_k_rate=safe_float(
            getattr(away_pitcher, "k_rate", None), 0.22
        ) if away_pitcher else 0.22,
        home_pitcher_k_rate=safe_float(
            getattr(home_pitcher, "k_rate", None), 0.22
        ) if home_pitcher else 0.22,
        away_pitcher_ground_ball_rate=safe_float(
            getattr(away_pitcher, "ground_ball_rate", None), 0.44
        ) if away_pitcher else 0.44,
        home_pitcher_ground_ball_rate=safe_float(
            getattr(home_pitcher, "ground_ball_rate", None), 0.44
        ) if home_pitcher else 0.44,
    )

    prediction = predict_first_inning(context)

    return {
        "matchup": collected["context"]["matchup"],
        "yrfi_probability": prediction.yrfi_probability,
        "nrfi_probability": prediction.nrfi_probability,
        "top_first_run_probability": prediction.top_first_run_probability,
        "bottom_first_run_probability": prediction.bottom_first_run_probability,
        "lean": prediction.lean,
        "confidence": prediction.confidence,
        "main_factors": prediction.main_factors,
        "source": "deterministic_python_model",
    }


def build_predictions(
    collected: dict[str, Any],
    features: dict[str, Any],
    weight_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Build all deterministic predictions for one game.

    Parameters
    ----------
    weight_overrides : optional dict
        If provided, these weights are passed to predict_moneyline_from_features
        instead of the default SituationalWeightEngine weights.  Keys must match
        the component names ("team_strength", "starting_pitcher", etc.).
    """
    return {
        "moneyline": predict_moneyline_from_features(
            collected, features, weight_overrides=weight_overrides
        ),
        "first_inning": predict_first_inning_from_features(collected, features),
    }
