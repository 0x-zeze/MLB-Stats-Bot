import unittest

from evolution_helpers import final_result, sample_trajectory
from src.evolution.lesson_generator import attribute_prediction_result
from src.evolution.prediction_evaluator import evaluate_prediction


class PredictionEvaluatorTests(unittest.TestCase):
    def test_final_score_is_only_attached_after_game(self):
        trajectory = sample_trajectory()
        self.assertNotIn("actual_total", trajectory)

        evaluation = evaluate_prediction(trajectory, final_result(home_score=3, away_score=3))

        self.assertEqual(evaluation["actual_total"], 6)
        self.assertEqual(evaluation["result"], "loss")

    def test_correct_prediction_generates_positive_attribution(self):
        trajectory = sample_trajectory(prediction={**sample_trajectory()["prediction"], "final_lean": "Under 8.5"})
        evaluation = evaluate_prediction(trajectory, final_result(home_score=3, away_score=3))
        attribution = attribute_prediction_result(trajectory, evaluation)

        self.assertEqual(evaluation["result"], "win")
        self.assertTrue(any(item["impact"] == "positive" for item in attribution["attribution"]))


if __name__ == "__main__":
    unittest.main()
