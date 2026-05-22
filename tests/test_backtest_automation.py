"""Tests for backtest automation."""

import unittest

from src.backtest_automation import (
    BacktestWindow,
    run_rolling_backtest,
    schedule_weekly_backtest,
)
from src.backtest_report import (
    format_report_text,
    generate_performance_report,
)


class TestRunRollingBacktest(unittest.TestCase):
    def test_empty_log(self) -> None:
        result = run_rolling_backtest([], lookback_days=14, end_date="2024-06-15")
        self.assertEqual(result.games, 0)
        self.assertEqual(result.start_date, "2024-06-01")
        self.assertEqual(result.end_date, "2024-06-15")

    def test_filters_by_date(self) -> None:
        log = [
            {"date": "2024-06-10", "result": "win", "profit_loss": 0.9, "home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY", "win_probability": 0.60},
            {"date": "2024-06-12", "result": "loss", "profit_loss": -1.0, "home_team": "LAD", "away_team": "SF", "predicted_winner": "LAD", "win_probability": 0.55},
            {"date": "2024-05-01", "result": "win", "profit_loss": 0.8, "home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY", "win_probability": 0.62},
        ]
        result = run_rolling_backtest(log, lookback_days=14, end_date="2024-06-15")
        self.assertEqual(result.games, 2)
        self.assertEqual(result.wins, 1)
        self.assertEqual(result.losses, 1)

    def test_computes_roi(self) -> None:
        log = [
            {"date": "2024-06-10", "result": "win", "profit_loss": 0.9, "home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY", "win_probability": 0.60},
            {"date": "2024-06-11", "result": "loss", "profit_loss": -1.0, "home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY", "win_probability": 0.58},
        ]
        result = run_rolling_backtest(log, lookback_days=14, end_date="2024-06-15")
        self.assertAlmostEqual(result.total_profit_loss, -0.1, places=2)
        self.assertAlmostEqual(result.roi, -0.05, places=2)

    def test_includes_segments(self) -> None:
        log = [
            {"date": "2024-06-10", "result": "win", "profit_loss": 0.9, "home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY", "win_probability": 0.60, "confidence": "High", "model_edge": 0.05},
        ]
        result = run_rolling_backtest(log, lookback_days=14, end_date="2024-06-15")
        self.assertIn("venue", result.segments)


class TestScheduleWeeklyBacktest(unittest.TestCase):
    def test_returns_config(self) -> None:
        config = schedule_weekly_backtest()
        self.assertEqual(config["frequency"], "weekly")
        self.assertEqual(config["lookback_days"], 14)
        self.assertIn("moneyline", config["markets"])


class TestGeneratePerformanceReport(unittest.TestCase):
    def test_basic_report(self) -> None:
        window = BacktestWindow(
            start_date="2024-06-01",
            end_date="2024-06-15",
            games=20,
            wins=11,
            losses=9,
            no_bets=3,
            total_profit_loss=1.5,
            roi=0.075,
            brier_score=0.23,
            log_loss=0.65,
            clv_avg=0.012,
            segments={"venue": {"home": {"games": 12, "wins": 7, "losses": 5, "win_rate": 0.583, "total_profit_loss": 1.2, "roi": 0.1}}},
        )
        report = generate_performance_report(window)
        self.assertEqual(report["overall"]["games"], 20)
        self.assertEqual(report["health"]["status"], "healthy")
        self.assertIn("clv_analysis", report)

    def test_degraded_health(self) -> None:
        window = BacktestWindow(
            start_date="2024-06-01",
            end_date="2024-06-15",
            games=20,
            wins=8,
            losses=12,
            no_bets=2,
            total_profit_loss=-3.0,
            roi=-0.15,
            brier_score=0.28,
            log_loss=0.75,
            clv_avg=-0.02,
        )
        report = generate_performance_report(window)
        self.assertEqual(report["health"]["status"], "critical")
        self.assertGreater(len(report["health"]["issues"]), 0)

    def test_format_report_text(self) -> None:
        window = BacktestWindow(
            start_date="2024-06-01",
            end_date="2024-06-15",
            games=20,
            wins=11,
            losses=9,
            no_bets=3,
            total_profit_loss=1.5,
            roi=0.075,
            brier_score=0.23,
            log_loss=0.65,
            clv_avg=0.012,
        )
        report = generate_performance_report(window)
        text = format_report_text(report)
        self.assertIn("Performance Report", text)
        self.assertIn("HEALTHY", text)


if __name__ == "__main__":
    unittest.main()
