import unittest

from evolution_helpers import isolated_evolution_store
from src.analyze_picks import analyze, render_markdown
from src.evolution.memory_store import append_prediction_outcome


class AnalyzePicksTests(unittest.TestCase):
    def test_moneyline_weekly_report_separates_yrfi(self):
        with isolated_evolution_store():
            for index, result in enumerate(["win", "win", "loss", "win"], start=1):
                append_prediction_outcome(
                    {
                        "game_id": f"ml-{index}",
                        "date": "2026-06-01",
                        "market": "moneyline",
                        "prediction": "Home Team",
                        "confidence": "low",
                        "result": result,
                        "profit_loss": 1.0 if result == "win" else -1.0,
                        "brier_score": 0.16 if result == "win" else 0.36,
                        "predicted_probability": 60,
                        "clv": 0.2,
                    }
                )
            append_prediction_outcome(
                {
                    "game_id": "yrfi-1",
                    "date": "2026-06-01",
                    "market": "yrfi",
                    "prediction": "YES",
                    "confidence": "low",
                    "result": "loss",
                    "profit_loss": -1.0,
                    "brier_score": 0.30,
                    "predicted_probability": 55,
                }
            )

            report = analyze(min_week_sample=4, segment_min_sample=2)
            markdown = render_markdown(report)

        moneyline = report["markets"]["moneyline"]
        yrfi = report["markets"]["yrfi"]
        self.assertEqual(4, moneyline["metrics"]["decided"])
        self.assertEqual(75.0, moneyline["metrics"]["win_rate"])
        self.assertEqual(1, yrfi["metrics"]["decided"])
        self.assertEqual(0.0, yrfi["metrics"]["win_rate"])
        self.assertEqual(1, len(moneyline["weekly"]))
        self.assertEqual("tembus target", markdown.split("2026-06-01→2026-06-07", 1)[1].split("|", 8)[7].strip())
        self.assertIn("Target 70% di sini", markdown)
        self.assertIn("### MONEYLINE", markdown)
        self.assertIn("### YRFI", markdown)


if __name__ == "__main__":
    unittest.main()
