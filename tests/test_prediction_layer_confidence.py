from unittest.mock import patch

import src.prediction_layer as prediction_layer


class _Team:
    def __init__(self, team):
        self.team = team


class _ModelResult:
    home_win_probability = 0.62
    away_win_probability = 0.38
    predicted_winner = "Home"


class _Model:
    def predict(self, *args, **kwargs):
        return _ModelResult()

    def _main_factors(self, components, home_favored):
        return []


def test_predict_moneyline_confidence_uses_calibrated_probability():
    collected = {
        "home_team": _Team("Home"),
        "away_team": _Team("Away"),
        "home_pitcher": object(),
        "away_pitcher": object(),
        "context": {"matchup": "Away @ Home"},
        "market": {},
        "park": None,
        "game": None,
    }
    features = {"moneyline": {"components": {"starter": 0.12}, "opener_flag": False}}

    with patch.object(prediction_layer, "BaselinePredictionModel", return_value=_Model()), \
         patch.object(prediction_layer, "calibrate", return_value=0.54):
        result = prediction_layer.predict_moneyline_from_features(
            collected,
            features,
            weight_overrides={"starter": 1.0},
        )

    assert result["home_win_probability"] == 0.54
    assert result["confidence"] == "Medium"
