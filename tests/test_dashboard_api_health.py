import os
import unittest
from unittest.mock import patch

_PREVIOUS_NODE_ENV = os.environ.get("NODE_ENV")
_PREVIOUS_DASHBOARD_API_TOKEN = os.environ.get("DASHBOARD_API_TOKEN")

os.environ["NODE_ENV"] = "test"
os.environ["DASHBOARD_API_TOKEN"] = ""

import src.dashboard_api as dashboard_api

if _PREVIOUS_NODE_ENV is None:
    os.environ.pop("NODE_ENV", None)
else:
    os.environ["NODE_ENV"] = _PREVIOUS_NODE_ENV

if _PREVIOUS_DASHBOARD_API_TOKEN is None:
    os.environ.pop("DASHBOARD_API_TOKEN", None)
else:
    os.environ["DASHBOARD_API_TOKEN"] = _PREVIOUS_DASHBOARD_API_TOKEN


class DashboardApiHealthTests(unittest.TestCase):
    def test_health_status_reports_operational_sections_without_auth(self) -> None:
        with patch.dict(os.environ, {"DASHBOARD_API_TOKEN": "secret-token"}, clear=False):
            payload = dashboard_api.health()

        self.assertEqual(payload["status"], "ok")
        self.assertIn("last_successful_mlb_data_fetch", payload)
        self.assertIn("last_odds_fetch", payload)
        self.assertIn("last_prediction_run", payload)
        self.assertIn("storage", payload)
        self.assertIn("bot", payload)

    def test_rate_limit_returns_429_for_repeated_authenticated_api_calls(self) -> None:
        with patch.dict(
            os.environ,
            {"DASHBOARD_API_TOKEN": "secret-token", "DASHBOARD_RATE_LIMIT_PER_MINUTE": "1"},
            clear=False,
        ):
            dashboard_api.clear_rate_limit_state()
            first = dashboard_api.rate_limit_exceeded("test-client:/api/backtest/mock", now=100.0)
            second = dashboard_api.rate_limit_exceeded("test-client:/api/backtest/mock", now=101.0)

        self.assertFalse(first)
        self.assertTrue(second)


if __name__ == "__main__":
    unittest.main()
