import unittest

from evolution_helpers import final_result, sample_trajectory
from src.evolution.language_loss import calculate_language_loss


class LanguageLossTests(unittest.TestCase):
    def test_overconfidence_creates_confidence_loss(self):
        loss = calculate_language_loss(sample_trajectory(), final_result(home_score=3, away_score=3))

        self.assertEqual(loss["loss_type"], "overconfidence")
        self.assertEqual(loss["affected_factor"], "confidence_calibration")
        self.assertEqual(loss["numeric_context"]["actual_total"], 6.0)


if __name__ == "__main__":
    unittest.main()
