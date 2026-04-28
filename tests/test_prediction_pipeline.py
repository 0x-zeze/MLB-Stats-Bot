import unittest

from src.prediction_pipeline import run_prediction_pipeline


class PredictionPipelineTests(unittest.TestCase):
    def test_pipeline_stages_are_explicit(self) -> None:
        result = run_prediction_pipeline(0)
        self.assertEqual(result["stages"]["data_collection"], "complete")
        self.assertEqual(result["stages"]["feature_engineering"], "complete")
        self.assertEqual(result["stages"]["prediction"], "complete")
        self.assertEqual(result["stages"]["market_comparison"], "complete")
        self.assertEqual(result["stages"]["quality_control"], "complete")
        self.assertEqual(result["stages"]["explanation"], "complete")

    def test_signal_priority_tiers_are_available(self) -> None:
        result = run_prediction_pipeline(0)
        tiers = result["features"]["signal_priority"]
        self.assertIn("probable_pitchers", tiers["tier_1"])
        self.assertIn("recent_form", tiers["tier_2"])
        self.assertIn("head_to_head_trends", tiers["tier_3"])

    def test_final_explanation_uses_required_sections(self) -> None:
        output = run_prediction_pipeline(0)["explanation"]
        self.assertIn("1. Prediction Summary", output)
        self.assertIn("2. Moneyline Probability", output)
        self.assertIn("3. Total Runs Projection", output)
        self.assertIn("4. Market Comparison", output)
        self.assertIn("5. Data Quality Report", output)
        self.assertIn("8. Final Decision:", output)
        self.assertIn("9. Confidence:", output)

    def test_numeric_predictions_are_deterministic_payloads(self) -> None:
        result = run_prediction_pipeline(0)
        self.assertEqual(result["moneyline"]["source"], "deterministic_python_model")
        self.assertEqual(result["totals"]["source"], "deterministic_python_model")
        self.assertGreater(result["moneyline"]["home_win_probability"], 0)
        self.assertGreater(result["totals"]["projected_total_runs"], 0)


if __name__ == "__main__":
    unittest.main()
