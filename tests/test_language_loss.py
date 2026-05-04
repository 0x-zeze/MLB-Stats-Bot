import unittest

from evolution_helpers import final_result, sample_trajectory
from src.evolution.language_loss import calculate_language_loss


class LanguageLossTests(unittest.TestCase):
    def test_overconfidence_creates_confidence_loss(self):
        loss = calculate_language_loss(sample_trajectory(), final_result(home_score=3, away_score=3))

        self.assertEqual(loss["loss_type"], "overconfidence")
        self.assertEqual(loss["affected_factor"], "confidence_calibration")
        self.assertEqual(loss["numeric_context"]["actual_total"], 6.0)

    def test_record_dominated_moneyline_loss_creates_record_bias_loss(self):
        trajectory = sample_trajectory(
            market="moneyline",
            prediction={
                "final_lean": "Cleveland Guardians",
                "confidence": "Medium",
                "moneyline_probability": 58,
                "model_edge": 8,
            },
            model_breakdown={
                "matchupEdge": 0.04,
                "recordContextEdge": 0.22,
                "recordDominated": True,
            },
        )

        loss = calculate_language_loss(trajectory, final_result(home_score=2, away_score=5))

        self.assertEqual(loss["loss_type"], "record_bias")
        self.assertEqual(loss["affected_factor"], "record_context")


if __name__ == "__main__":
    unittest.main()
