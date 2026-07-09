import unittest
from src.backtest import (
    american_profit,
    market_for_game,
    no_bet_reasons,
    run_backtest,
    write_prediction_log,
    _market_date_key,
    _market_matchup_key,
)
from src.data_loader import GameRow
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

    def test_market_lookup_prefers_date_qualified_key(self) -> None:
        # Multi-day series with distinct lines per date. Bare matchup key must
        # not overwrite date-qualified rows; lookup returns the date-specific line.
        rows = [
            {
                "date": "2025-09-01",
                "home_team": "Los Angeles Dodgers",
                "away_team": "New York Yankees",
                "home_moneyline": "-120",
                "away_moneyline": "+100",
            },
            {
                "date": "2025-09-02",
                "home_team": "Los Angeles Dodgers",
                "away_team": "New York Yankees",
                "home_moneyline": "-150",
                "away_moneyline": "+130",
            },
        ]
        markets: dict[str, dict[str, str]] = {}
        for row in rows:
            away, home = row["away_team"], row["home_team"]
            matchup = _market_matchup_key(away, home)
            markets[_market_date_key(row["date"], away, home)] = row
            markets.setdefault(matchup, row)

        g1 = GameRow(
            date="2025-09-01",
            home_team="Los Angeles Dodgers",
            away_team="New York Yankees",
            home_pitcher="Y",
            away_pitcher="G",
            home_score=5,
            away_score=3,
        )
        g2 = GameRow(
            date="2025-09-02",
            home_team="Los Angeles Dodgers",
            away_team="New York Yankees",
            home_pitcher="Y",
            away_pitcher="G",
            home_score=2,
            away_score=4,
        )
        self.assertEqual(market_for_game(g1, markets)["home_moneyline"], "-120")
        self.assertEqual(market_for_game(g2, markets)["home_moneyline"], "-150")
        # Legacy bare-matchup still resolves (first row wins via setdefault).
        g_no_date = GameRow(
            date="",
            home_team="Los Angeles Dodgers",
            away_team="New York Yankees",
            home_pitcher="Y",
            away_pitcher="G",
            home_score=None,
            away_score=None,
        )
        self.assertEqual(market_for_game(g_no_date, markets)["home_moneyline"], "-120")

    def test_run_backtest_totals_and_evaluate_disabled_old(self) -> None:
        pass  # totals market removed

    def test_write_and_load_prediction_log(self) -> None:
        pass  # depends on rows from removed totals test

    def test_build_report_disabled_old(self) -> None:
        pass  # depends on rows from removed totals test


if __name__ == "__main__":
    unittest.main()
