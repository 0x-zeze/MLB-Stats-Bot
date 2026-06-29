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
        self.assertIn("yrfi", payload["games"][0])

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
            "yrfi": {"edge": 0.0, "difference": 1.0},
        }

        decision, reason = _decision_from_game(game, settings)

        self.assertEqual("NO BET", decision)
        self.assertEqual("Moneyline edge below minimum threshold", reason)

    def test_yrfi_edge_does_not_override_moneyline_decision(self):
        settings = {
            **DEFAULT_DASHBOARD_SETTINGS,
            "minimum_moneyline_edge": 0.05,
        }
        game = {
            "data_quality": {"score": 90},
            "probable_pitchers": {"status": "Confirmed"},
            "moneyline": {"edge": 6.0, "confidence": "Medium"},
            "yrfi": {"edge": 5.0, "difference": 1.0},
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

    def test_run_dashboard_backtest_replays_history_filtered_by_date(self):
        import json as _json

        def outcome(date, market, prediction, result, edge, pl, winner):
            return {
                "game_id": f"{date}-{prediction}",
                "date": date,
                "market": market,
                "prediction": prediction,
                "confidence": "medium",
                "result": result,
                "profit_loss": pl,
                "clv": "",
                "brier_score": "0.21",
                "evaluation_json": _json.dumps(
                    {"predicted_probability": 60.0, "edge": edge, "actual_winner": winner}
                ),
            }

        history = [
            outcome("2026-05-04", "moneyline", "Home", "win", 5.0, 1.0, "Home"),
            outcome("2026-05-04", "yrfi", "YES", "loss", 2.0, -1.0, None),
            # Outside the requested window — must be filtered out.
            outcome("2026-05-30", "moneyline", "Away", "win", 4.0, 1.0, "Away"),
        ]

        with patch("src.evolution.memory_store.read_prediction_outcomes", return_value=history):
            payload = dashboard_service.run_dashboard_backtest(
                {"market": "all", "start_date": "2026-05-04", "end_date": "2026-05-25"}
            )

        # Only the two 2026-05-04 rows fall in the window; 2026-05-30 is excluded.
        self.assertEqual(2, payload["summary"]["totalBets"])
        self.assertEqual(["Moneyline", "Yrfi"], [row["market"] for row in payload["byMarket"]])
        self.assertIn("winRate", payload["byMarket"][0])
        self.assertIn("predicted", payload["calibration"][0])
        self.assertEqual({"moneyline", "yrfi"}, {row["market"] for row in payload["rows"]})

    def test_run_dashboard_backtest_different_windows_differ(self):
        import json as _json

        def outcome(date, result):
            return {
                "game_id": f"{date}",
                "date": date,
                "market": "moneyline",
                "prediction": "Home",
                "confidence": "medium",
                "result": result,
                "profit_loss": 1.0 if result == "win" else -1.0,
                "clv": "",
                "brier_score": "0.21",
                "evaluation_json": _json.dumps({"predicted_probability": 60.0, "edge": 3.0}),
            }

        history = [outcome("2026-05-04", "win"), outcome("2026-05-30", "loss")]
        with patch("src.evolution.memory_store.read_prediction_outcomes", return_value=history):
            early = dashboard_service.run_dashboard_backtest(
                {"market": "moneyline", "start_date": "2026-05-01", "end_date": "2026-05-10"}
            )
            late = dashboard_service.run_dashboard_backtest(
                {"market": "moneyline", "start_date": "2026-05-25", "end_date": "2026-05-31"}
            )

        # The reported bug: numbers were identical across windows. They must differ now.
        self.assertEqual(1, early["summary"]["totalBets"])
        self.assertEqual(1, late["summary"]["totalBets"])
        self.assertNotEqual(early["summary"]["winRate"], late["summary"]["winRate"])

    def test_run_evolve_cycle_runs_cycle_and_audit(self):
        cycle = {"summary": {"total_predictions_evaluated": 3}, "symbolic_candidates": 1}
        audit = {"summary": {"evaluated": 3, "accuracy": 70.0}, "applied_updates": {"rules_added": []}}

        with patch("src.dashboard_service.subprocess.run", side_effect=AssertionError("subprocess not expected")):
            with patch("src.evolution.evolution_engine.run_evolution_cycle", return_value=cycle):
                with patch("src.evolution.evolution_audit.build_evolution_audit", return_value=audit):
                    payload = dashboard_service.run_evolve_cycle()

        self.assertEqual("ok", payload["status"])
        # Consolidated pipeline: cycle result plus the audit nested under "audit".
        self.assertEqual(audit, payload["result"]["audit"])
        self.assertEqual(1, payload["result"]["symbolic_candidates"])
        self.assertIn("total_predictions_evaluated", payload["output"])

    def test_run_audit_cycle_is_alias_for_evolve(self):
        cycle = {"summary": {"total_predictions_evaluated": 2}, "symbolic_candidates": 0}
        audit = {"summary": {"evaluated": 2}, "applied_updates": {"rules_added": []}}

        with patch("src.dashboard_service.subprocess.run", side_effect=AssertionError("subprocess not expected")):
            with patch("src.evolution.evolution_engine.run_evolution_cycle", return_value=cycle):
                with patch("src.evolution.evolution_audit.build_evolution_audit", return_value=audit):
                    payload = dashboard_service.run_audit_cycle()

        self.assertEqual("ok", payload["status"])
        self.assertEqual(audit, payload["result"]["audit"])
        self.assertIn("applied_updates", payload["output"])


if __name__ == "__main__":
    unittest.main()
