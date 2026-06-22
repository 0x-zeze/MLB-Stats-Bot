import unittest

from evolution_helpers import final_result, sample_trajectory
from src.evolution.language_loss import calculate_language_loss


class LanguageLossTests(unittest.TestCase):
    def test_high_conviction_loss_does_not_use_tautological_overconfidence(self):
        # A High-confidence pick (72%) that loses must NOT be labelled
        # "overconfidence". That label was defined as (loss AND prob>0.65), so it
        # merely restated the outcome and poisoned the evolution signal with a
        # circular "100% loss" pattern. It must now fall through to a substantive,
        # non-circular loss_type instead.
        trajectory = sample_trajectory(
            prediction={
                "final_lean": "Over 8.5",
                "confidence": "High",
                "projected_total": 10.5,
                "market_total": 8.5,
                "over_probability": 72,
                "under_probability": 28,
                "model_edge": 4.0,
                "market_odds": {"over": "-110", "under": "-110"},
            },
        )

        loss = calculate_language_loss(trajectory, final_result(home_score=3, away_score=3))

        self.assertNotIn(loss["loss_type"], ("overconfidence", "underconfidence"))
        self.assertNotEqual(loss["affected_factor"], "confidence_calibration")
        self.assertEqual(loss["numeric_context"]["actual_total"], 6.0)

    def test_low_conviction_win_is_not_tautological_underconfidence(self):
        # A cautious winning pick must stay a correct_pick, never a manufactured
        # "underconfidence" loss (which was win AND prob<0.55 by definition).
        trajectory = sample_trajectory(
            market="moneyline",
            prediction={
                "final_lean": "Cleveland Guardians",
                "confidence": "Low",
                "moneyline_probability": 52,
                "model_edge": 3,
                "market_odds": {"home": "-120", "away": "+100"},
            },
        )

        loss = calculate_language_loss(trajectory, final_result(home_score=2, away_score=5))

        self.assertNotIn(loss["loss_type"], ("overconfidence", "underconfidence"))

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
