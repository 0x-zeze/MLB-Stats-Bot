"""Tests for src/dynamic_weights.py"""
import pytest

from src.dynamic_weights import (
    GameMode,
    _detect_game_mode,
    _apply_micro_adjustments,
    _normalise,
    _confidence_modifier,
    calculate_dynamic_weights,
    BASE_WEIGHTS,
)


# ---------------------------------------------------------------------------
# Game mode detection
# ---------------------------------------------------------------------------

class TestGameModeDetection:
    def test_pitcher_dominated(self):
        ctx = {
            "sp_home_score": 0.85,
            "sp_away_score": 0.80,
            "bullpen_home_fatigue": "low",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 0.95,
        }
        assert _detect_game_mode(ctx) == GameMode.PITCHER_DOMINATED

    def test_bullpen_dominated_opener(self):
        ctx = {
            "sp_home_score": 0.40,  # opener-level
            "sp_away_score": 0.70,
            "bullpen_home_fatigue": "low",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 1.0,
        }
        assert _detect_game_mode(ctx) == GameMode.BULLPEN_DOMINATED

    def test_bullpen_dominated_fatigue(self):
        ctx = {
            "sp_home_score": 0.65,
            "sp_away_score": 0.60,
            "bullpen_home_fatigue": "high",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 1.0,
        }
        assert _detect_game_mode(ctx) == GameMode.BULLPEN_DOMINATED

    def test_offense_dominated(self):
        ctx = {
            "sp_home_score": 0.40,
            "sp_away_score": 0.35,
            "bullpen_home_fatigue": "low",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 1.15,  # Coors
        }
        assert _detect_game_mode(ctx) == GameMode.OFFENSE_DOMINATED

    def test_offense_dominated_wind_out(self):
        ctx = {
            "sp_home_score": 0.30,
            "sp_away_score": 0.40,
            "bullpen_home_fatigue": "low",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 1.0,
            "weather_wind_out": True,
        }
        assert _detect_game_mode(ctx) == GameMode.OFFENSE_DOMINATED

    def test_balanced_default(self):
        ctx = {
            "sp_home_score": 0.60,
            "sp_away_score": 0.65,
            "bullpen_home_fatigue": "medium",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 1.0,
        }
        assert _detect_game_mode(ctx) == GameMode.BALANCED

    def test_empty_context_is_balanced(self):
        assert _detect_game_mode({}) == GameMode.BALANCED


# ---------------------------------------------------------------------------
# Weight normalisation
# ---------------------------------------------------------------------------

class TestNormalise:
    def test_sums_to_one(self):
        w = {"a": 0.3, "b": 0.5, "c": 0.8}
        result = _normalise(w)
        assert abs(sum(result.values()) - 1.0) < 1e-6

    def test_zero_total_fallback(self):
        w = {"a": 0.0, "b": 0.0}
        result = _normalise(w)
        assert abs(sum(result.values()) - 1.0) < 1e-6


# ---------------------------------------------------------------------------
# Base weights always sum to 1
# ---------------------------------------------------------------------------

class TestBaseWeights:
    @pytest.mark.parametrize("mode", list(GameMode))
    def test_base_weights_sum_to_one(self, mode):
        total = sum(BASE_WEIGHTS[mode].values())
        assert abs(total - 1.0) < 1e-6, f"{mode}: sum = {total}"


# ---------------------------------------------------------------------------
# Micro-adjustments
# ---------------------------------------------------------------------------

class TestMicroAdjustments:
    def test_sp_unconfirmed_shifts_weight(self):
        base = BASE_WEIGHTS[GameMode.BALANCED].copy()
        original_sp = base["sp"]
        original_bp = base["bullpen"]
        adjusted, applied = _apply_micro_adjustments(base, {"sp_home_confirmed": False})
        assert adjusted["sp"] < original_sp
        assert adjusted["bullpen"] > original_bp
        assert "sp_home_unconfirmed_penalty" in applied

    def test_lineup_unconfirmed_shifts_weight(self):
        base = BASE_WEIGHTS[GameMode.BALANCED].copy()
        adjusted, applied = _apply_micro_adjustments(base, {"lineup_away_confirmed": False})
        assert "lineup_away_unconfirmed_penalty" in applied

    def test_il_high_triggers(self):
        base = BASE_WEIGHTS[GameMode.BALANCED].copy()
        adjusted, applied = _apply_micro_adjustments(base, {"il_home_count": 4})
        assert any("il_home" in a for a in applied)

    def test_il_low_no_trigger(self):
        base = BASE_WEIGHTS[GameMode.BALANCED].copy()
        adjusted, applied = _apply_micro_adjustments(base, {"il_home_count": 1})
        assert not any("il_home" in a for a in applied)


# ---------------------------------------------------------------------------
# Confidence modifier
# ---------------------------------------------------------------------------

class TestConfidenceModifier:
    def test_full_confidence_all_confirmed(self):
        ctx = {
            "sp_home_confirmed": True,
            "sp_away_confirmed": True,
            "lineup_home_confirmed": True,
            "lineup_away_confirmed": True,
        }
        assert _confidence_modifier(ctx, []) == 1.0

    def test_reduced_confidence_with_unknowns(self):
        ctx = {
            "sp_home_confirmed": False,
            "sp_away_confirmed": False,
            "lineup_home_confirmed": False,
            "lineup_away_confirmed": False,
            "il_home_count": 3,
            "il_away_count": 3,
            "bullpen_home_fatigue": "high",
            "bullpen_away_fatigue": "high",
        }
        mod = _confidence_modifier(ctx, [])
        assert mod >= 0.80
        assert mod < 0.90


# ---------------------------------------------------------------------------
# End-to-end API
# ---------------------------------------------------------------------------

class TestCalculateDynamicWeights:
    def test_returns_expected_keys(self):
        result = calculate_dynamic_weights({})
        assert "mode" in result
        assert "weights" in result
        assert "adjustments_applied" in result
        assert "confidence_modifier" in result

    def test_weights_sum_to_one(self):
        result = calculate_dynamic_weights({
            "sp_home_score": 0.90,
            "sp_away_score": 0.85,
            "bullpen_home_fatigue": "low",
            "bullpen_away_fatigue": "low",
            "park_factor_runs": 0.92,
        })
        assert abs(sum(result["weights"].values()) - 1.0) < 1e-5

    def test_none_context_does_not_crash(self):
        result = calculate_dynamic_weights(None)
        assert result["mode"] == "BALANCED"

    def test_bullpen_dominated_with_multiple_adjustments(self):
        result = calculate_dynamic_weights({
            "sp_home_score": 0.30,
            "sp_away_score": 0.70,
            "sp_home_confirmed": False,
            "bullpen_home_fatigue": "high",
            "bullpen_away_fatigue": "medium",
            "lineup_home_confirmed": False,
            "il_home_count": 4,
        })
        assert result["mode"] == "BULLPEN_DOMINATED"
        assert len(result["adjustments_applied"]) >= 3
        assert result["confidence_modifier"] < 1.0
        assert abs(sum(result["weights"].values()) - 1.0) < 1e-5
