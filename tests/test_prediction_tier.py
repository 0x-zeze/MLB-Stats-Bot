"""Tests for tiered prediction timing."""

import unittest
from datetime import datetime, timedelta, timezone

from src.prediction_tier import (
    PredictionTier,
    apply_tier_confidence_cap,
    determine_prediction_tier,
    should_refresh_prediction,
)


class TestDeterminePredictionTier(unittest.TestCase):
    def test_none_game_time_returns_standard(self) -> None:
        result = determine_prediction_tier(None)
        self.assertEqual(result.tier, "standard")

    def test_early_preview(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=8)
        result = determine_prediction_tier(game_time, now)
        self.assertEqual(result.tier, "early_preview")
        self.assertLessEqual(result.confidence_cap, 0.60)
        self.assertTrue(result.refresh_recommended)

    def test_standard_tier(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=3)
        result = determine_prediction_tier(game_time, now, lineup_confirmed=True)
        self.assertEqual(result.tier, "standard")
        self.assertLessEqual(result.confidence_cap, 0.85)

    def test_final_tier(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=1)
        result = determine_prediction_tier(game_time, now, lineup_confirmed=True, pitcher_confirmed=True)
        self.assertEqual(result.tier, "final")
        self.assertLessEqual(result.confidence_cap, 0.95)

    def test_no_pitcher_caps_confidence(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=1)
        result = determine_prediction_tier(game_time, now, pitcher_confirmed=False)
        self.assertLessEqual(result.confidence_cap, 0.55)

    def test_final_without_lineup_caps(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=1)
        result = determine_prediction_tier(game_time, now, lineup_confirmed=False)
        self.assertLessEqual(result.confidence_cap, 0.75)

    def test_string_game_time(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = (now + timedelta(hours=4)).isoformat()
        result = determine_prediction_tier(game_time, now)
        self.assertEqual(result.tier, "standard")

    def test_hours_to_game_calculated(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now + timedelta(hours=5)
        result = determine_prediction_tier(game_time, now)
        self.assertAlmostEqual(result.hours_to_game, 5.0, places=1)

    def test_past_game_time(self) -> None:
        now = datetime.now(timezone.utc)
        game_time = now - timedelta(hours=1)
        result = determine_prediction_tier(game_time, now)
        self.assertEqual(result.tier, "final")
        self.assertAlmostEqual(result.hours_to_game, 0.0)


class TestShouldRefreshPrediction(unittest.TestCase):
    def test_pitcher_changed(self) -> None:
        original = PredictionTier(tier="standard")
        current = PredictionTier(tier="standard")
        self.assertTrue(should_refresh_prediction(original, current, pitcher_changed=True))

    def test_lineup_changed_in_final(self) -> None:
        original = PredictionTier(tier="final")
        current = PredictionTier(tier="final")
        self.assertTrue(should_refresh_prediction(original, current, lineup_changed=True))

    def test_tier_upgrade(self) -> None:
        original = PredictionTier(tier="early_preview")
        current = PredictionTier(tier="standard")
        self.assertTrue(should_refresh_prediction(original, current))

    def test_lineup_confirmed(self) -> None:
        original = PredictionTier(tier="standard", lineup_confirmed=False)
        current = PredictionTier(tier="standard", lineup_confirmed=True)
        self.assertTrue(should_refresh_prediction(original, current))

    def test_no_change(self) -> None:
        original = PredictionTier(tier="standard", lineup_confirmed=True)
        current = PredictionTier(tier="standard", lineup_confirmed=True)
        self.assertFalse(should_refresh_prediction(original, current))


class TestApplyTierConfidenceCap(unittest.TestCase):
    def test_early_preview_caps_to_low(self) -> None:
        tier = PredictionTier(tier="early_preview", confidence_cap=0.60)
        self.assertEqual(apply_tier_confidence_cap("High", tier), "Low")
        self.assertEqual(apply_tier_confidence_cap("Medium", tier), "Low")

    def test_standard_caps_high_to_medium(self) -> None:
        tier = PredictionTier(tier="standard", confidence_cap=0.85)
        self.assertEqual(apply_tier_confidence_cap("High", tier), "Medium")
        self.assertEqual(apply_tier_confidence_cap("Medium", tier), "Medium")
        self.assertEqual(apply_tier_confidence_cap("Low", tier), "Low")

    def test_final_allows_high(self) -> None:
        tier = PredictionTier(tier="final", confidence_cap=0.95)
        self.assertEqual(apply_tier_confidence_cap("High", tier), "High")


if __name__ == "__main__":
    unittest.main()
