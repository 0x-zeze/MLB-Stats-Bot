"""Tests for calibration auto-adjustment."""

import unittest

from src.evolution.calibration_auto_adjust import (
    apply_calibration_adjustment,
    detect_persistent_miscalibration,
    find_miscalibrated_buckets,
)


class TestDetectPersistentMiscalibration(unittest.TestCase):
    def test_empty_history(self) -> None:
        self.assertIsNone(detect_persistent_miscalibration([], "60-65%"))

    def test_insufficient_sample(self) -> None:
        history = [
            {"bucket": "60-65%", "date": "2024-06-01", "games": 10, "avg_predicted": 0.62, "actual_win_rate": 0.45},
        ]
        result = detect_persistent_miscalibration(history, "60-65%", current_date="2024-06-10")
        self.assertIsNone(result)

    def test_detects_overconfidence(self) -> None:
        history = [
            {"bucket": "60-65%", "date": "2024-06-01", "games": 20, "avg_predicted": 0.62, "actual_win_rate": 0.48},
            {"bucket": "60-65%", "date": "2024-06-05", "games": 20, "avg_predicted": 0.63, "actual_win_rate": 0.47},
        ]
        result = detect_persistent_miscalibration(history, "60-65%", current_date="2024-06-10")
        self.assertIsNotNone(result)
        self.assertLess(result["proposed_adjustment"], 0)
        self.assertFalse(result["production_update_allowed"])

    def test_detects_underconfidence(self) -> None:
        history = [
            {"bucket": "55-60%", "date": "2024-06-01", "games": 25, "avg_predicted": 0.57, "actual_win_rate": 0.68},
            {"bucket": "55-60%", "date": "2024-06-05", "games": 20, "avg_predicted": 0.58, "actual_win_rate": 0.70},
        ]
        result = detect_persistent_miscalibration(history, "55-60%", current_date="2024-06-10")
        self.assertIsNotNone(result)
        self.assertGreater(result["proposed_adjustment"], 0)

    def test_no_detection_when_calibrated(self) -> None:
        history = [
            {"bucket": "60-65%", "date": "2024-06-01", "games": 25, "avg_predicted": 0.62, "actual_win_rate": 0.61},
            {"bucket": "60-65%", "date": "2024-06-05", "games": 25, "avg_predicted": 0.63, "actual_win_rate": 0.62},
        ]
        result = detect_persistent_miscalibration(history, "60-65%", current_date="2024-06-10")
        self.assertIsNone(result)

    def test_adjustment_bounded(self) -> None:
        history = [
            {"bucket": "60-65%", "date": "2024-06-01", "games": 50, "avg_predicted": 0.62, "actual_win_rate": 0.30},
        ]
        result = detect_persistent_miscalibration(history, "60-65%", current_date="2024-06-10")
        self.assertIsNotNone(result)
        self.assertGreaterEqual(result["proposed_adjustment"], -0.02)
        self.assertLessEqual(result["proposed_adjustment"], 0.02)


class TestApplyCalibrationAdjustment(unittest.TestCase):
    def test_no_adjustment(self) -> None:
        thresholds = {"60-65%": 0.62}
        result = apply_calibration_adjustment(thresholds, None)
        self.assertEqual(result, thresholds)

    def test_insufficient_sample(self) -> None:
        thresholds = {"60-65%": 0.62}
        adjustment = {"bucket": "60-65%", "proposed_adjustment": -0.01, "sample_size": 10}
        result = apply_calibration_adjustment(thresholds, adjustment)
        self.assertEqual(result, thresholds)

    def test_applies_adjustment(self) -> None:
        thresholds = {"60-65%": 0.62}
        adjustment = {"bucket": "60-65%", "proposed_adjustment": -0.015, "sample_size": 50}
        result = apply_calibration_adjustment(thresholds, adjustment)
        self.assertAlmostEqual(result["60-65%"], 0.605, places=3)


class TestFindMiscalibratedBuckets(unittest.TestCase):
    def test_empty_history(self) -> None:
        result = find_miscalibrated_buckets([])
        self.assertEqual(result, [])

    def test_finds_multiple(self) -> None:
        history = [
            {"bucket": "60-65%", "date": "2024-06-01", "games": 40, "avg_predicted": 0.62, "actual_win_rate": 0.45},
            {"bucket": "55-60%", "date": "2024-06-01", "games": 40, "avg_predicted": 0.57, "actual_win_rate": 0.70},
        ]
        result = find_miscalibrated_buckets(history, current_date="2024-06-10")
        self.assertGreater(len(result), 0)


if __name__ == "__main__":
    unittest.main()
