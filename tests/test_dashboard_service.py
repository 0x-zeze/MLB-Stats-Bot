import json
import unittest
from pathlib import Path
from unittest.mock import patch

import src.dashboard_service as dashboard_service
from src.dashboard_service import (
    DEFAULT_DASHBOARD_SETTINGS,
    _decision_from_game,
    get_model_performance,
    get_prediction_history,
    get_today_dashboard,
    rows_to_csv,
)


class DashboardServiceTests(unittest.TestCase):
    def test_mock_today_dashboard_shape(self):
        payload = get_today_dashboard(source="mock")

        self.assertGreaterEqual(payload["summary"]["total_games"], 1)
        self.assertIn(payload["games"][0]["decision"], {"BET", "LEAN", "NO BET"})
        self.assertIn("data_quality", payload["games"][0])
        self.assertIn("moneyline", payload["games"][0])
        self.assertIn("totals", payload["games"][0])

    def test_history_and_performance_available(self):
        history = get_prediction_history()
        performance = get_model_performance()

        self.assertIsInstance(history, list)
        self.assertIn("overall", performance)

    def test_rows_to_csv(self):
        text = rows_to_csv([{"date": "2026-04-29", "edge": 3.2}])

        self.assertIn("date", text)
        self.assertIn("2026-04-29", text)

    def test_moneyline_edge_uses_moneyline_threshold(self):
        settings = {
            **DEFAULT_DASHBOARD_SETTINGS,
            "minimum_moneyline_edge": 0.05,
            "minimum_total_edge": 0.02,
        }
        game = {
            "data_quality": {"score": 90},
            "probable_pitchers": {"status": "Confirmed"},
            "moneyline": {"edge": 3.0, "confidence": "Medium"},
            "totals": {"edge": 0.0, "difference": 1.0},
        }

        decision, reason = _decision_from_game(game, settings)

        self.assertEqual("NO BET", decision)
        self.assertEqual("Model edge below minimum threshold", reason)

    def test_total_edge_uses_total_threshold(self):
        settings = {
            **DEFAULT_DASHBOARD_SETTINGS,
            "minimum_moneyline_edge": 0.05,
            "minimum_total_edge": 0.02,
        }
        game = {
            "data_quality": {"score": 90},
            "probable_pitchers": {"status": "Confirmed"},
            "moneyline": {"edge": 0.0, "confidence": "Medium"},
            "totals": {"edge": 3.0, "difference": 1.0},
        }

        decision, reason = _decision_from_game(game, settings)

        self.assertEqual("LEAN", decision)
        self.assertEqual("", reason)

    def test_mock_today_includes_predicted_winner(self):
        payload = get_today_dashboard(source="mock")

        self.assertIn("predicted_winner", payload["games"][0])
        self.assertIn("predicted_winner_probability", payload["games"][0])

    def test_history_prefers_telegram_state(self):
        original_path = dashboard_service._TELEGRAM_STATE_PATH
        original_sqlite = dashboard_service._SQLITE_PATH
        state_path = Path("data/tmp_test_telegram_state.json")
        try:
            dashboard_service._SQLITE_PATH = Path("data/nonexistent_test.sqlite")
            state_path.write_text(
                json.dumps(
                    {
                        "predictions": {
                            "1": {
                                "gamePk": 1,
                                "dateYmd": "2026-04-29",
                                "matchup": "Away @ Home",
                                "away": {"name": "Away"},
                                "home": {"name": "Home"},
                                "pick": {"name": "Home", "winProbability": 61, "confidence": "high"},
                            }
                        },
                        "memory": {
                            "learningLog": [
                                {
                                    "gamePk": 1,
                                    "correct": True,
                                    "score": "Away 2 - Home 4",
                                    "note": "Pick benar",
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            dashboard_service._TELEGRAM_STATE_PATH = state_path
            history = get_prediction_history()
        finally:
            dashboard_service._TELEGRAM_STATE_PATH = original_path
            dashboard_service._SQLITE_PATH = original_sqlite
            state_path.unlink(missing_ok=True)

        self.assertEqual("telegram", history[0]["source"])
        self.assertEqual("Home", history[0]["prediction"])
        self.assertEqual("Win", history[0]["result"])
        self.assertEqual(1.0, history[0]["profit_loss"])

    def test_performance_prefers_telegram_memory(self):
        original_path = dashboard_service._TELEGRAM_STATE_PATH
        original_sqlite = dashboard_service._SQLITE_PATH
        state_path = Path("data/tmp_test_telegram_state.json")
        try:
            dashboard_service._SQLITE_PATH = Path("data/nonexistent_test.sqlite")
            state_path.write_text(
                json.dumps(
                    {
                        "predictions": {},
                        "memory": {
                            "totalPicks": 4,
                            "correctPicks": 3,
                            "wrongPicks": 1,
                            "byConfidence": {"high": {"total": 4, "correct": 3}},
                            "firstInning": {"totalPicks": 2, "correctPicks": 1},
                            "learningLog": [],
                        },
                    }
                ),
                encoding="utf-8",
            )
            dashboard_service._TELEGRAM_STATE_PATH = state_path
            performance = get_model_performance()
        finally:
            dashboard_service._TELEGRAM_STATE_PATH = original_path
            dashboard_service._SQLITE_PATH = original_sqlite
            state_path.unlink(missing_ok=True)

        self.assertEqual("telegram", performance["overall"]["source"])
        self.assertEqual(4, performance["overall"]["bets_taken"])
        self.assertEqual(75.0, performance["overall"]["win_rate"])
        self.assertEqual(50.0, performance["overall"]["roi"])

    def test_run_dashboard_backtest_supports_all_market_dashboard_shape(self):
        moneyline_row = {
            "date": "2026-05-04",
            "away_team": "Away",
            "home_team": "Home",
            "final_lean": "Home ML",
            "result": "win",
            "model_edge": 0.05,
            "profit_loss": 1.0,
            "model_probability": 0.6,
        }
        totals_row = {
            "date": "2026-05-04",
            "away_team": "Away",
            "home_team": "Home",
            "final_lean": "Over",
            "result": "loss",
            "model_edge": 0.02,
            "profit_loss": -1.0,
            "model_probability": 0.55,
        }

        def fake_run_backtest(*, market, **_kwargs):
            return [moneyline_row] if market == "moneyline" else [totals_row]

        with patch("src.dashboard_service.run_backtest", side_effect=fake_run_backtest):
            payload = dashboard_service.run_dashboard_backtest({"market": "all", "start_date": "2026-05-04", "end_date": "2026-05-25"})

        self.assertEqual(2, payload["summary"]["totalBets"])
        self.assertEqual(["Moneyline", "Totals"], [row["market"] for row in payload["byMarket"]])
        self.assertIn("winRate", payload["byMarket"][0])
        self.assertIn("predicted", payload["calibration"][0])
        self.assertEqual({"moneyline", "totals"}, {row["market"] for row in payload["rows"]})

    def test_run_evolve_cycle_uses_engine_directly(self):
        result = {"summary": {"total_predictions_evaluated": 3}, "symbolic_candidates": 1}

        with patch("src.dashboard_service.subprocess.run", side_effect=AssertionError("subprocess not expected")):
            with patch("src.evolution.evolution_engine.run_evolution_cycle", return_value=result):
                payload = dashboard_service.run_evolve_cycle()

        self.assertEqual("ok", payload["status"])
        self.assertEqual(result, payload["result"])
        self.assertIn("total_predictions_evaluated", payload["output"])

    def test_run_audit_cycle_uses_engine_and_audit_directly(self):
        ingest = {"history_rows": 4, "evaluated": 2}
        audit = {"summary": {"evaluated": 2}, "applied_updates": {"rules_added": []}}

        with patch("src.dashboard_service.subprocess.run", side_effect=AssertionError("subprocess not expected")):
            with patch("src.evolution.evolution_engine.ingest_bot_history", return_value=ingest):
                with patch("src.evolution.evolution_audit.build_evolution_audit", return_value=audit):
                    payload = dashboard_service.run_audit_cycle()

        self.assertEqual("ok", payload["status"])
        self.assertEqual(ingest, payload["learning_ingest"])
        self.assertEqual(audit, payload["result"])
        self.assertIn("applied_updates", payload["output"])


if __name__ == "__main__":
    unittest.main()
