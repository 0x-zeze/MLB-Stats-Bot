"""Tests for umpire zone tendency adjustment."""

import unittest

from src.umpire import (
    UmpireContext,
    build_umpire_context,
    classify_zone_tendency,
    umpire_adjustment,
    umpire_pitcher_interaction,
)


class TestClassifyZoneTendency(unittest.TestCase):
    def test_tight_zone(self) -> None:
        self.assertEqual(classify_zone_tendency(0.03, -0.01), "tight")

    def test_wide_zone(self) -> None:
        self.assertEqual(classify_zone_tendency(-0.03, 0.01), "wide")

    def test_neutral_zone(self) -> None:
        self.assertEqual(classify_zone_tendency(0.0, 0.0), "neutral")

    def test_borderline_neutral(self) -> None:
        self.assertEqual(classify_zone_tendency(0.01, 0.0), "neutral")


class TestUmpireAdjustment(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(umpire_adjustment(None), 0.0)

    def test_insufficient_games_returns_zero(self) -> None:
        ump = UmpireContext(umpire_name="Test", zone_tendency="tight", games_behind_plate=5)
        self.assertEqual(umpire_adjustment(ump), 0.0)

    def test_tight_zone_negative(self) -> None:
        ump = UmpireContext(
            umpire_name="Angel Hernandez",
            zone_tendency="tight",
            k_rate_adjustment=0.02,
            bb_rate_adjustment=-0.01,
            run_factor=0.95,
            games_behind_plate=50,
        )
        result = umpire_adjustment(ump)
        self.assertLess(result, 0.0)

    def test_wide_zone_positive(self) -> None:
        ump = UmpireContext(
            umpire_name="Wide Ump",
            zone_tendency="wide",
            k_rate_adjustment=-0.02,
            bb_rate_adjustment=0.01,
            run_factor=1.05,
            games_behind_plate=50,
        )
        result = umpire_adjustment(ump)
        self.assertGreater(result, 0.0)

    def test_neutral_zone_near_zero(self) -> None:
        ump = UmpireContext(
            umpire_name="Neutral",
            zone_tendency="neutral",
            run_factor=1.0,
            games_behind_plate=50,
        )
        result = umpire_adjustment(ump)
        self.assertAlmostEqual(result, 0.0, places=2)

    def test_clamped_range(self) -> None:
        ump = UmpireContext(
            umpire_name="Extreme",
            zone_tendency="tight",
            k_rate_adjustment=0.10,
            bb_rate_adjustment=-0.05,
            run_factor=0.80,
            games_behind_plate=100,
        )
        result = umpire_adjustment(ump)
        self.assertGreaterEqual(result, -0.45)
        self.assertLessEqual(result, 0.45)


class TestUmpirePitcherInteraction(unittest.TestCase):
    def test_none_umpire(self) -> None:
        self.assertEqual(umpire_pitcher_interaction(None, 0.25, 0.08), 0.0)

    def test_tight_zone_benefits_high_k_pitcher(self) -> None:
        ump = UmpireContext(umpire_name="Tight", zone_tendency="tight", games_behind_plate=50)
        result = umpire_pitcher_interaction(ump, 0.30, 0.06)
        self.assertGreater(result, 0.0)

    def test_wide_zone_hurts_high_walk_pitcher(self) -> None:
        ump = UmpireContext(umpire_name="Wide", zone_tendency="wide", games_behind_plate=50)
        result = umpire_pitcher_interaction(ump, 0.18, 0.12)
        self.assertGreater(result, 0.0)


class TestBuildUmpireContext(unittest.TestCase):
    def test_none_input(self) -> None:
        self.assertIsNone(build_umpire_context(None))

    def test_empty_dict(self) -> None:
        self.assertIsNone(build_umpire_context({}))

    def test_valid_data(self) -> None:
        data = {
            "name": "Joe West",
            "zone_tendency": "tight",
            "k_rate_adjustment": 0.02,
            "bb_rate_adjustment": -0.01,
            "run_factor": 0.96,
            "games_behind_plate": 80,
        }
        ctx = build_umpire_context(data)
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.umpire_name, "Joe West")
        self.assertEqual(ctx.zone_tendency, "tight")
        self.assertEqual(ctx.games_behind_plate, 80)


if __name__ == "__main__":
    unittest.main()
