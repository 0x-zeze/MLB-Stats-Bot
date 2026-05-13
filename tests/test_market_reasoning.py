"""Tests for src/market_reasoning.py — edge decomposition and market reasoning."""

from __future__ import annotations

import pytest
from src.market_reasoning import (
    compute_edge_attribution,
    explain_market_disagreement,
    detect_steam_move,
    build_market_reasoning,
)


class TestComputeEdgeAttribution:
    """Edge decomposition tests."""

    def test_basic_attribution(self):
        result = compute_edge_attribution(
            starter_edge=0.15,
            lineup_edge=0.05,
            bullpen_edge=0.03,
            offense_edge=0.08,
            park_factor=0.02,
            weather_adjustment=0.01,
            data_quality=80.0,
        )
        assert result["components"]["starting_pitcher"] == pytest.approx(0.15, abs=0.001)
        assert result["components"]["lineup"] == pytest.approx(0.05, abs=0.001)
        assert result["components"]["bullpen"] == pytest.approx(0.03, abs=0.001)
        assert result["components"]["offense"] == pytest.approx(0.08, abs=0.001)
        assert result["components"]["park_factor"] == pytest.approx(0.02, abs=0.001)
        assert result["components"]["weather"] == pytest.approx(0.01, abs=0.001)
        assert result["total_edge"] > 0

    def test_largest_component_identified(self):
        result = compute_edge_attribution(
            starter_edge=0.25,
            lineup_edge=0.05,
            bullpen_edge=0.03,
            offense_edge=0.08,
            park_factor=0.02,
            weather_adjustment=0.01,
            data_quality=80.0,
        )
        assert result["largest_driver"] == "starting_pitcher"
        assert result["largest_contribution_pct"] > 40

    def test_zero_edge_handling(self):
        result = compute_edge_attribution(
            starter_edge=0.0,
            lineup_edge=0.0,
            bullpen_edge=0.0,
            offense_edge=0.0,
            park_factor=0.0,
            weather_adjustment=0.0,
            data_quality=50.0,
        )
        assert result["total_edge"] == 0.0
        assert result["largest_driver"] is None

    def test_data_quality_scaling(self):
        """Lower data quality should scale down the edge."""
        high_dq = compute_edge_attribution(
            starter_edge=0.20, lineup_edge=0.0, bullpen_edge=0.0,
            offense_edge=0.0, park_factor=0.0, weather_adjustment=0.0,
            data_quality=90.0,
        )
        low_dq = compute_edge_attribution(
            starter_edge=0.20, lineup_edge=0.0, bullpen_edge=0.0,
            offense_edge=0.0, park_factor=0.0, weather_adjustment=0.0,
            data_quality=50.0,
        )
        assert high_dq["confidence_adjusted_edge"] > low_dq["confidence_adjusted_edge"]

    def test_confidence_tier_assignment(self):
        result_high = compute_edge_attribution(
            starter_edge=0.30, lineup_edge=0.10, bullpen_edge=0.05,
            offense_edge=0.10, park_factor=0.03, weather_adjustment=0.02,
            data_quality=90.0,
        )
        result_low = compute_edge_attribution(
            starter_edge=0.01, lineup_edge=0.01, bullpen_edge=0.01,
            offense_edge=0.01, park_factor=0.0, weather_adjustment=0.0,
            data_quality=60.0,
        )
        assert result_high["confidence_tier"] in ("High", "Medium")
        assert result_low["confidence_tier"] in ("Low", "Medium")


class TestExplainMarketDisagreement:
    """Market disagreement explanation tests."""

    def test_model_higher_than_market(self):
        result = explain_market_disagreement(
            model_probability=0.65,
            market_implied_probability=0.55,
            market_type="moneyline",
        )
        assert result["model_probability"] == 0.65
        assert result["market_implied_probability"] == 0.55
        assert result["gap"] == pytest.approx(0.10, abs=0.001)
        assert result["direction"] == "model_higher"
        assert result["magnitude"] in ("moderate", "large")
        assert len(result["explanation"]) > 0

    def test_market_higher_than_model(self):
        result = explain_market_disagreement(
            model_probability=0.48,
            market_implied_probability=0.55,
            market_type="moneyline",
        )
        assert result["direction"] == "market_higher"

    def test_small_gap(self):
        result = explain_market_disagreement(
            model_probability=0.53,
            market_implied_probability=0.52,
            market_type="moneyline",
        )
        assert result["magnitude"] == "small"

    def test_totals_market(self):
        result = explain_market_disagreement(
            model_probability=0.60,
            market_implied_probability=0.52,
            market_type="totals",
        )
        assert "totals" in result["explanation"].lower() or "over" in result["explanation"].lower() or "total" in result["explanation"].lower()


class TestDetectSteamMove:
    """Steam move detection tests."""

    def test_steam_detected_heavy(self):
        result = detect_steam_move(
            opening_line=-150,
            current_line=-180,
            opening_total=None,
            current_total=None,
        )
        assert result["steam_detected"] is True
        assert result["direction"] == "toward_favorite"
        assert result["magnitude"] in ("moderate", "heavy")

    def test_steam_detected_totals(self):
        result = detect_steam_move(
            opening_line=None,
            current_line=None,
            opening_total=8.5,
            current_total=9.5,
        )
        assert result["steam_detected"] is True
        assert result["direction"] == "over"
        assert result["magnitude"] == "heavy"

    def test_no_steam(self):
        result = detect_steam_move(
            opening_line=-150,
            current_line=-152,
            opening_total=8.5,
            current_total=8.5,
        )
        assert result["steam_detected"] is False

    def test_missing_data(self):
        result = detect_steam_move(
            opening_line=None,
            current_line=None,
            opening_total=None,
            current_total=None,
        )
        assert result["steam_detected"] is False


class TestBuildMarketReasoning:
    """Integration test for full market reasoning."""

    def test_full_reasoning(self):
        result = build_market_reasoning(
            model_probability=0.62,
            market_implied_probability=0.55,
            opening_line=-140,
            current_line=-165,
            opening_total=None,
            current_total=None,
            starter_edge=0.20,
            lineup_edge=0.08,
            bullpen_edge=0.05,
            offense_edge=0.10,
            park_factor=0.02,
            weather_adjustment=0.01,
            data_quality=85.0,
            market_type="moneyline",
        )
        assert "edge_attribution" in result
        assert "market_disagreement" in result
        assert "steam_move" in result
        assert "summary" in result
        assert isinstance(result["summary"], str)
        assert len(result["summary"]) > 0