"""Tests for rolling expected stats module."""

import unittest
from datetime import date

from src.rolling_expected_stats import (
    RollingExpectedStats,
    rolling_team_xstats,
    xstats_offense_adjustment,
)


class TestRollingTeamXstats(unittest.TestCase):
    def test_empty_inputs(self) -> None:
        result = rolling_team_xstats([], [])
        self.assertEqual(result.sample_size, 0)
        self.assertAlmostEqual(result.xwoba, 0.315)

    def test_no_matching_batters(self) -> None:
        rows = [{"batter": "999", "game_date": "2024-06-01", "estimated_woba_using_speedangle": 0.400}]
        result = rolling_team_xstats(["1", "2"], rows, as_of_date="2024-06-10")
        self.assertEqual(result.sample_size, 0)

    def test_filters_by_date_window(self) -> None:
        rows = [
            {"batter": "1", "game_date": "2024-05-01", "estimated_woba_using_speedangle": 0.400, "launch_speed": 95.0},
            {"batter": "1", "game_date": "2024-06-01", "estimated_woba_using_speedangle": 0.350, "launch_speed": 90.0},
            {"batter": "1", "game_date": "2024-06-10", "estimated_woba_using_speedangle": 0.500, "launch_speed": 100.0},
        ]
        result = rolling_team_xstats(["1"], rows, as_of_date="2024-06-10", window_days=14)
        self.assertEqual(result.sample_size, 1)
        self.assertAlmostEqual(result.xwoba, 0.350)

    def test_prevents_leakage(self) -> None:
        rows = [
            {"batter": "1", "game_date": "2024-06-10", "estimated_woba_using_speedangle": 0.500, "launch_speed": 100.0},
        ]
        result = rolling_team_xstats(["1"], rows, as_of_date="2024-06-10", window_days=14)
        self.assertEqual(result.sample_size, 0)

    def test_multiple_batters(self) -> None:
        rows = [
            {"batter": "1", "game_date": "2024-06-05", "estimated_woba_using_speedangle": 0.400, "launch_speed": 95.0},
            {"batter": "2", "game_date": "2024-06-06", "estimated_woba_using_speedangle": 0.300, "launch_speed": 85.0},
        ]
        result = rolling_team_xstats(["1", "2"], rows, as_of_date="2024-06-10", window_days=14)
        self.assertEqual(result.sample_size, 2)
        self.assertAlmostEqual(result.xwoba, 0.350)

    def test_hard_hit_and_barrel(self) -> None:
        rows = [
            {"batter": "1", "game_date": "2024-06-05", "launch_speed": 100.0, "launch_angle": 28},
            {"batter": "1", "game_date": "2024-06-06", "launch_speed": 80.0, "launch_angle": 10},
            {"batter": "1", "game_date": "2024-06-07", "launch_speed": 96.0, "launch_angle": 15},
        ]
        result = rolling_team_xstats(["1"], rows, as_of_date="2024-06-10", window_days=14)
        self.assertEqual(result.sample_size, 3)
        self.assertAlmostEqual(result.hard_hit_rate, 2 / 3, places=3)
        self.assertAlmostEqual(result.barrel_rate, 1 / 3, places=3)


class TestXstatsOffenseAdjustment(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(xstats_offense_adjustment(None), 0.0)

    def test_small_sample_returns_zero(self) -> None:
        stats = RollingExpectedStats(xwoba=0.400, sample_size=10)
        self.assertEqual(xstats_offense_adjustment(stats), 0.0)

    def test_above_average(self) -> None:
        stats = RollingExpectedStats(
            xwoba=0.370,
            xslg=0.460,
            barrel_rate=0.12,
            hard_hit_rate=0.45,
            avg_exit_velocity=91.0,
            sample_size=80,
        )
        result = xstats_offense_adjustment(stats)
        self.assertGreater(result, 0.0)

    def test_below_average(self) -> None:
        stats = RollingExpectedStats(
            xwoba=0.270,
            xslg=0.340,
            barrel_rate=0.04,
            hard_hit_rate=0.30,
            avg_exit_velocity=85.0,
            sample_size=80,
        )
        result = xstats_offense_adjustment(stats)
        self.assertLess(result, 0.0)

    def test_clamped(self) -> None:
        stats = RollingExpectedStats(
            xwoba=0.500,
            xslg=0.600,
            barrel_rate=0.20,
            hard_hit_rate=0.60,
            avg_exit_velocity=95.0,
            sample_size=200,
        )
        result = xstats_offense_adjustment(stats)
        self.assertLessEqual(result, 0.45)  # clamp widened for sweet-spot + distance signals
        self.assertGreaterEqual(result, -0.45)


if __name__ == "__main__":
    unittest.main()
