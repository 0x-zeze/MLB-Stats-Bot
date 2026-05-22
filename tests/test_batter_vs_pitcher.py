"""Tests for batter-vs-pitcher matchup analysis."""

import unittest

from src.batter_vs_pitcher import (
    BvPResult,
    aggregate_bvp_for_lineup,
    bvp_adjustment,
    bvp_confidence_signal,
    compute_bvp_from_events,
)


class TestComputeBvpFromEvents(unittest.TestCase):
    def test_empty_events(self) -> None:
        result = compute_bvp_from_events([])
        self.assertEqual(result.plate_appearances, 0)
        self.assertFalse(result.sufficient_sample)

    def test_basic_events(self) -> None:
        events = [
            {"is_hit": True, "is_walk": False, "is_hbp": False, "is_sac": False, "is_strikeout": False, "is_home_run": False, "total_bases": 1},
            {"is_hit": False, "is_walk": True, "is_hbp": False, "is_sac": False, "is_strikeout": False, "is_home_run": False, "total_bases": 0},
            {"is_hit": False, "is_walk": False, "is_hbp": False, "is_sac": False, "is_strikeout": True, "is_home_run": False, "total_bases": 0},
            {"is_hit": True, "is_walk": False, "is_hbp": False, "is_sac": False, "is_strikeout": False, "is_home_run": True, "total_bases": 4},
        ]
        result = compute_bvp_from_events(events)
        self.assertEqual(result.plate_appearances, 4)
        self.assertFalse(result.sufficient_sample)
        self.assertAlmostEqual(result.batting_average, 2 / 3, places=3)
        self.assertAlmostEqual(result.k_rate, 0.25)
        self.assertAlmostEqual(result.hr_rate, 0.25)

    def test_sufficient_sample(self) -> None:
        events = [
            {"is_hit": True, "is_walk": False, "is_hbp": False, "is_sac": False, "is_strikeout": False, "is_home_run": False, "total_bases": 1}
        ] * 30
        result = compute_bvp_from_events(events)
        self.assertTrue(result.sufficient_sample)


class TestAggregateBvpForLineup(unittest.TestCase):
    def test_empty_inputs(self) -> None:
        self.assertIsNone(aggregate_bvp_for_lineup([], "123", []))
        self.assertIsNone(aggregate_bvp_for_lineup(["1"], "", []))

    def test_insufficient_pas(self) -> None:
        rows = [{"batter": "1", "pitcher": "99"}] * 10
        result = aggregate_bvp_for_lineup(["1"], "99", rows)
        self.assertIsNone(result)

    def test_sufficient_pas(self) -> None:
        rows = [
            {"batter": "1", "pitcher": "99", "is_hit": True, "is_walk": False, "is_hbp": False, "is_sac": False, "is_strikeout": False, "is_home_run": False, "total_bases": 1}
        ] * 60
        result = aggregate_bvp_for_lineup(["1", "2"], "99", rows)
        self.assertIsNotNone(result)
        self.assertEqual(result.plate_appearances, 60)


class TestBvpAdjustment(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(bvp_adjustment(None), 0.0)

    def test_insufficient_sample(self) -> None:
        bvp = BvPResult(plate_appearances=20, ops=0.900, woba=0.400, sufficient_sample=False)
        self.assertEqual(bvp_adjustment(bvp), 0.0)

    def test_positive_matchup(self) -> None:
        bvp = BvPResult(
            plate_appearances=50,
            ops=0.900,
            woba=0.400,
            k_rate=0.15,
            hr_rate=0.06,
            sufficient_sample=True,
        )
        result = bvp_adjustment(bvp)
        self.assertGreater(result, 0.0)

    def test_negative_matchup(self) -> None:
        bvp = BvPResult(
            plate_appearances=50,
            ops=0.500,
            woba=0.220,
            k_rate=0.35,
            hr_rate=0.01,
            sufficient_sample=True,
        )
        result = bvp_adjustment(bvp)
        self.assertLess(result, 0.0)

    def test_clamped(self) -> None:
        bvp = BvPResult(
            plate_appearances=100,
            ops=1.200,
            woba=0.500,
            k_rate=0.05,
            hr_rate=0.15,
            sufficient_sample=True,
        )
        result = bvp_adjustment(bvp)
        self.assertLessEqual(result, 0.30)
        self.assertGreaterEqual(result, -0.30)


class TestBvpConfidenceSignal(unittest.TestCase):
    def test_none(self) -> None:
        self.assertEqual(bvp_confidence_signal(None), "unavailable")

    def test_insufficient(self) -> None:
        bvp = BvPResult(plate_appearances=20, sufficient_sample=False)
        self.assertEqual(bvp_confidence_signal(bvp), "unavailable")

    def test_strong(self) -> None:
        bvp = BvPResult(plate_appearances=80, sufficient_sample=True)
        self.assertEqual(bvp_confidence_signal(bvp), "strong")

    def test_moderate(self) -> None:
        bvp = BvPResult(plate_appearances=55, sufficient_sample=True)
        self.assertEqual(bvp_confidence_signal(bvp), "moderate")

    def test_weak(self) -> None:
        bvp = BvPResult(plate_appearances=35, sufficient_sample=True)
        self.assertEqual(bvp_confidence_signal(bvp), "weak")


if __name__ == "__main__":
    unittest.main()
