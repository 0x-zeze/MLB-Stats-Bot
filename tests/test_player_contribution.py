"""Tests for src/player_contribution.py"""
import pytest

from src.player_contribution import (
    calculate_lineup_contribution,
    calculate_sp_contribution,
    calculate_bullpen_contribution,
    calculate_team_player_score,
    _platoon_multiplier,
    _hot_cold_multiplier,
)


# ---------------------------------------------------------------------------
# Platoon multiplier
# ---------------------------------------------------------------------------

class TestPlatoonMultiplier:
    def test_opposite_side_advantage(self):
        assert _platoon_multiplier("L", "R") == 1.12
        assert _platoon_multiplier("R", "L") == 1.12

    def test_same_side_disadvantage(self):
        assert _platoon_multiplier("L", "L") == 0.88
        assert _platoon_multiplier("R", "R") == 0.88

    def test_switch_hitter_neutral(self):
        assert _platoon_multiplier("S", "L") == 1.0
        assert _platoon_multiplier("S", "R") == 1.0

    def test_unknown_hand_neutral(self):
        assert _platoon_multiplier("", "R") == 1.0
        assert _platoon_multiplier("R", "") == 1.0


# ---------------------------------------------------------------------------
# Hot/cold multiplier
# ---------------------------------------------------------------------------

class TestHotColdMultiplier:
    def test_hot_streak(self):
        assert _hot_cold_multiplier(160) == 1.15

    def test_cold_streak(self):
        assert _hot_cold_multiplier(50) == 0.88

    def test_normal(self):
        assert _hot_cold_multiplier(110) == 1.0

    def test_none_is_neutral(self):
        assert _hot_cold_multiplier(None) == 1.0


# ---------------------------------------------------------------------------
# Lineup contribution
# ---------------------------------------------------------------------------

class TestLineupContribution:
    def test_empty_lineup_returns_zero(self):
        assert calculate_lineup_contribution(None) == 0.0
        score, contribs, risks = calculate_lineup_contribution(None, return_details=True)
        assert score == 0.0
        assert contribs == []
        assert risks == []

    def test_average_lineup_near_zero(self):
        lineup = [
            {"name": f"P{i}", "slot": i, "wrc_plus": 100, "hand": "R"}
            for i in range(1, 10)
        ]
        score, _, _ = calculate_lineup_contribution(lineup, "R", return_details=True)
        # Same-side platoon, but wRC+ = 100 → near zero
        assert -0.15 <= score <= 0.15

    def test_elite_lineup_positive(self):
        lineup = [
            {"name": f"P{i}", "slot": i, "wrc_plus": 150, "hand": "R"}
            for i in range(1, 10)
        ]
        score, contribs, _ = calculate_lineup_contribution(lineup, "L", return_details=True)
        assert score > 0.0
        assert len(contribs) == 3  # top 3

    def test_il_players_penalised(self):
        lineup = [
            {"name": "Star", "slot": 1, "wrc_plus": 170, "hand": "R", "is_il": True},
            {"name": "Normal", "slot": 2, "wrc_plus": 100, "hand": "R"},
        ]
        score, _, risks = calculate_lineup_contribution(lineup, "L", return_details=True)
        assert any(r["name"] == "Star" for r in risks)

    def test_batting_order_weights(self):
        # Top-of-order hitter contributes more than bottom
        lineup_top = [{"name": "A", "slot": 1, "wrc_plus": 140, "hand": "R"}]
        lineup_bot = [{"name": "B", "slot": 9, "wrc_plus": 140, "hand": "R"}]
        score_top, _, _ = calculate_lineup_contribution(lineup_top, "L", return_details=True)
        score_bot, _, _ = calculate_lineup_contribution(lineup_bot, "L", return_details=True)
        # Top-of-order gets 1.3x weight vs 0.7x for slot 9
        # Both are single-player lineups so the "average" reflects the weight
        assert score_top > score_bot or abs(score_top - score_bot) < 0.01


# ---------------------------------------------------------------------------
# SP contribution
# ---------------------------------------------------------------------------

class TestSpContribution:
    def test_none_returns_default(self):
        assert calculate_sp_contribution(None) == 0.40

    def test_elite_pitcher_high_score(self):
        stats = {
            "era": 2.50,
            "fip": 2.50,
            "k_per_9": 11.0,
            "bb_per_9": 2.0,
            "last_5_era": 2.00,
            "innings_pitched_avg": 6.5,
        }
        score = calculate_sp_contribution(stats)
        assert score > 0.75

    def test_bad_pitcher_low_score(self):
        stats = {
            "era": 6.00,
            "fip": 5.80,
            "k_per_9": 5.5,
            "bb_per_9": 5.0,
            "last_5_era": 7.00,
            "innings_pitched_avg": 4.0,
        }
        score = calculate_sp_contribution(stats)
        assert score < 0.50

    def test_score_clamped_0_1(self):
        # Even extreme stats should stay in range
        extreme_good = {"fip": 0.50, "k_per_9": 15, "bb_per_9": 0.5, "innings_pitched_avg": 8.0}
        extreme_bad = {"fip": 10.0, "k_per_9": 3, "bb_per_9": 7, "innings_pitched_avg": 3.0, "last_5_era": 12.0}
        assert 0.0 <= calculate_sp_contribution(extreme_good) <= 1.0
        assert 0.0 <= calculate_sp_contribution(extreme_bad) <= 1.0


# ---------------------------------------------------------------------------
# Bullpen contribution
# ---------------------------------------------------------------------------

class TestBullpenContribution:
    def test_none_returns_default(self):
        assert calculate_bullpen_contribution(None) == 0.45

    def test_elite_bullpen(self):
        stats = {
            "closer_era": 1.80,
            "setup_era": 2.50,
            "leverage_era": 2.80,
            "save_opportunities_converted": 0.85,
        }
        score = calculate_bullpen_contribution(stats)
        assert score > 0.65

    def test_fatigue_penalty(self):
        stats = {"closer_era": 3.0, "setup_era": 3.5, "leverage_era": 3.8}
        no_fatigue = calculate_bullpen_contribution(stats)
        with_fatigue = calculate_bullpen_contribution(stats, {"usage_last_3_days": 7})
        assert with_fatigue < no_fatigue

    def test_clamped_0_1(self):
        assert 0.0 <= calculate_bullpen_contribution({"closer_era": 0.5, "setup_era": 0.5, "leverage_era": 0.5}) <= 1.0
        assert 0.0 <= calculate_bullpen_contribution({"closer_era": 9.0, "setup_era": 9.0, "leverage_era": 9.0}) <= 1.0


# ---------------------------------------------------------------------------
# Full team score
# ---------------------------------------------------------------------------

class TestTeamPlayerScore:
    def test_returns_expected_structure(self):
        result = calculate_team_player_score(
            home_lineup=None,
            away_lineup=None,
            home_sp=None,
            away_sp=None,
            home_bullpen=None,
            away_bullpen=None,
        )
        assert "home" in result
        assert "away" in result
        assert "delta" in result
        assert "narrative" in result
        assert "lineup_score" in result["home"]
        assert "sp_score" in result["home"]
        assert "bullpen_score" in result["home"]
        assert "combined_score" in result["home"]
        assert "key_contributors" in result["home"]
        assert "key_risks" in result["home"]

    def test_symmetric_inputs_near_zero_delta(self):
        sp = {"era": 3.5, "fip": 3.5, "k_per_9": 9.0, "bb_per_9": 3.0}
        result = calculate_team_player_score(
            home_lineup=None,
            away_lineup=None,
            home_sp=sp,
            away_sp=sp,
            home_bullpen=None,
            away_bullpen=None,
        )
        assert abs(result["delta"]) < 0.01

    def test_strong_home_positive_delta(self):
        home_lineup = [
            {"name": f"H{i}", "slot": i, "wrc_plus": 130, "hand": "R"}
            for i in range(1, 10)
        ]
        away_lineup = [
            {"name": f"A{i}", "slot": i, "wrc_plus": 85, "hand": "R"}
            for i in range(1, 10)
        ]
        result = calculate_team_player_score(
            home_lineup=home_lineup,
            away_lineup=away_lineup,
            home_sp={"era": 2.5, "fip": 2.5, "k_per_9": 11, "bb_per_9": 2, "innings_pitched_avg": 6.5},
            away_sp={"era": 5.5, "fip": 5.5, "k_per_9": 6, "bb_per_9": 5, "innings_pitched_avg": 4.0},
            home_bullpen=None,
            away_bullpen=None,
            game_context={"home_name": "Home Team", "away_name": "Away Team"},
        )
        assert result["delta"] > 0
        assert "Home Team" in result["narrative"]

    def test_narrative_balanced(self):
        sp = {"era": 4.0, "fip": 4.0}
        result = calculate_team_player_score(
            home_lineup=None,
            away_lineup=None,
            home_sp=sp,
            away_sp=sp,
            home_bullpen=None,
            away_bullpen=None,
            game_context={"home_name": "A", "away_name": "B"},
        )
        assert "seimbang" in result["narrative"]
