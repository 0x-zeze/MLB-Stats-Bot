import unittest

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


if __name__ == "__main__":
    unittest.main()
