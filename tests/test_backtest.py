import unittest
from src.backtest import american_profit, no_bet_reasons, run_backtest, write_prediction_log
from src.evaluate import build_report, calculate_metrics, load_prediction_log, performance_by_confidence
from src.utils import data_path


class BacktestTests(unittest.TestCase):
    def test_american_profit(self) -> None:
        self.assertAlmostEqual(american_profit("-110", True), 100 / 110)
        self.assertAlmostEqual(american_profit("+150", True), 1.5)
        self.assertAlmostEqual(american_profit("-110", False), -1.0)

    def test_no_bet_low_edge(self) -> None:
        reasons = no_bet_reasons(
            model_edge=0.01,
            confidence="Low",
            projected_total_difference=0.2,
            weather=None,
            home_bullpen=None,
            away_bullpen=None,
        )
        self.assertIn("model edge below 2%", reasons)
        self.assertIn("confidence below threshold", reasons)

    def test_run_backtest_moneyline(self) -> None:
        rows = run_backtest(season=2025, market="moneyline")
        self.assertGreaterEqual(len(rows), 1)
        self.assertIn("home_win_probability", rows[0])
        self.assertIn(rows[0]["result"], {"win", "loss", "no_bet"})

    def test_run_backtest_totals_and_evaluate(self) -> None:
        rows = run_backtest(start_date="2025-09-01", end_date="2025-09-30", market="totals")
        metrics = calculate_metrics(rows)
        self.assertIn("roi", metrics)
        self.assertIn("high", performance_by_confidence(rows))

    def test_write_and_load_prediction_log(self) -> None:
        rows = run_backtest(season=2025, market="totals")
        path = data_path("tmp_test_predictions_log.csv")
        write_prediction_log(rows, path)
        loaded = load_prediction_log(path)
        self.assertEqual(len(loaded), len(rows))

    def test_build_report(self) -> None:
        rows = run_backtest(season=2025, market="totals")
        report = build_report(rows)
        self.assertIn("MLB Evaluation Report", report)
        self.assertIn("Calibration", report)


if __name__ == "__main__":
    unittest.main()
