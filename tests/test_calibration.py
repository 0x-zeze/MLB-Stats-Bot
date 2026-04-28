import unittest

from src.calibration import (
    brier_score,
    calibration_by_confidence,
    calibration_table,
    confidence_bucket,
    log_loss,
    probability_bucket,
)


class CalibrationTests(unittest.TestCase):
    def test_brier_score(self) -> None:
        score = brier_score([0.7, 0.4], [1, 0])
        self.assertAlmostEqual(score, 0.125)

    def test_log_loss(self) -> None:
        score = log_loss([0.8, 0.2], [1, 0])
        self.assertGreater(score, 0.0)
        self.assertLess(score, 0.3)

    def test_probability_bucket(self) -> None:
        self.assertEqual(probability_bucket(0.57), "55-60%")

    def test_confidence_bucket(self) -> None:
        self.assertEqual(confidence_bucket(0.52), "low")
        self.assertEqual(confidence_bucket(0.57), "medium")
        self.assertEqual(confidence_bucket(0.64), "high")

    def test_calibration_table(self) -> None:
        rows = [
            {"probability": 0.55, "won": 1},
            {"probability": 0.58, "won": 0},
            {"probability": 0.64, "won": 1},
        ]
        table = calibration_table(rows)
        self.assertTrue(any(row["bucket"] == "55-60%" for row in table))

    def test_calibration_by_confidence(self) -> None:
        rows = [{"probability": 0.55, "won": 1}, {"probability": 0.63, "won": 1}]
        table = calibration_by_confidence(rows)
        self.assertEqual([row["confidence"] for row in table], ["low", "medium", "high"])


if __name__ == "__main__":
    unittest.main()

