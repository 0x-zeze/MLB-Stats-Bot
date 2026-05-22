"""Tests for situational weight engine."""

import unittest
from datetime import date

from src.situational_weights import (
    BASE_WEIGHTS,
    GameSituation,
    MAX_SHIFT,
    SituationalWeightEngine,
    classify_park_type,
    determine_seasonal_phase,
)


class TestDetermineSeasonalPhase(unittest.TestCase):
    def test_none_returns_mid(self) -> None:
        self.assertEqual(determine_seasonal_phase(None), "mid")

    def test_april_is_early(self) -> None:
        self.assertEqual(determine_seasonal_phase(date(2024, 4, 15)), "early")

    def test_june_is_mid(self) -> None:
        self.assertEqual(determine_seasonal_phase(date(2024, 6, 15)), "mid")

    def test_september_is_late(self) -> None:
        self.assertEqual(determine_seasonal_phase(date(2024, 9, 10)), "late")

    def test_march_is_early(self) -> None:
        self.assertEqual(determine_seasonal_phase(date(2024, 3, 28)), "early")


class TestClassifyParkType(unittest.TestCase):
    def test_none_returns_neutral(self) -> None:
        self.assertEqual(classify_park_type(None), "neutral")

    def test_hitter_park(self) -> None:
        self.assertEqual(classify_park_type(110), "hitter_park")

    def test_pitcher_park(self) -> None:
        self.assertEqual(classify_park_type(92), "pitcher_park")

    def test_neutral(self) -> None:
        self.assertEqual(classify_park_type(100), "neutral")

    def test_boundary_high(self) -> None:
        self.assertEqual(classify_park_type(105), "hitter_park")

    def test_boundary_low(self) -> None:
        self.assertEqual(classify_park_type(95), "pitcher_park")


class TestSituationalWeightEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = SituationalWeightEngine()

    def test_neutral_situation_returns_base(self) -> None:
        situation = GameSituation()
        weights = self.engine.compute_weights(situation)
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=5)
        for key in BASE_WEIGHTS:
            self.assertAlmostEqual(weights[key], BASE_WEIGHTS[key], places=3)

    def test_weights_sum_to_one(self) -> None:
        situation = GameSituation(
            park_type="hitter_park",
            opener_detected=True,
            seasonal_phase="early",
        )
        weights = self.engine.compute_weights(situation)
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=5)

    def test_pitcher_park_boosts_sp(self) -> None:
        neutral = self.engine.compute_weights(GameSituation())
        pitcher_park = self.engine.compute_weights(GameSituation(park_type="pitcher_park"))
        self.assertGreater(pitcher_park["starting_pitcher"], neutral["starting_pitcher"])

    def test_hitter_park_boosts_offense(self) -> None:
        neutral = self.engine.compute_weights(GameSituation())
        hitter_park = self.engine.compute_weights(GameSituation(park_type="hitter_park"))
        self.assertGreater(hitter_park["offense"], neutral["offense"])

    def test_opener_reduces_sp_boosts_bullpen(self) -> None:
        neutral = self.engine.compute_weights(GameSituation())
        opener = self.engine.compute_weights(GameSituation(opener_detected=True))
        self.assertLess(opener["starting_pitcher"], neutral["starting_pitcher"])
        self.assertGreater(opener["bullpen"], neutral["bullpen"])

    def test_early_season_reduces_recent_form(self) -> None:
        neutral = self.engine.compute_weights(GameSituation())
        early = self.engine.compute_weights(GameSituation(seasonal_phase="early"))
        self.assertLess(early["recent_form"], neutral["recent_form"])

    def test_late_season_boosts_recent_form(self) -> None:
        neutral = self.engine.compute_weights(GameSituation())
        late = self.engine.compute_weights(GameSituation(seasonal_phase="late"))
        self.assertGreater(late["recent_form"], neutral["recent_form"])

    def test_max_shift_respected(self) -> None:
        situation = GameSituation(
            park_type="hitter_park",
            opener_detected=True,
            seasonal_phase="late",
        )
        weights = self.engine.compute_weights(situation)
        for key in BASE_WEIGHTS:
            diff = abs(weights[key] - BASE_WEIGHTS[key])
            self.assertLessEqual(diff, MAX_SHIFT + 0.02)

    def test_all_weights_positive(self) -> None:
        situation = GameSituation(
            park_type="pitcher_park",
            opener_detected=True,
            seasonal_phase="early",
        )
        weights = self.engine.compute_weights(situation)
        for value in weights.values():
            self.assertGreater(value, 0.0)

    def test_compute_weights_from_context(self) -> None:
        weights = self.engine.compute_weights_from_context(
            park_run_factor=110,
            opener_detected=False,
            game_date="2024-04-10",
        )
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=5)

    def test_compute_weights_from_context_none_date(self) -> None:
        weights = self.engine.compute_weights_from_context(
            park_run_factor=None,
            opener_detected=False,
            game_date=None,
        )
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
