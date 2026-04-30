import os
import unittest
from contextlib import redirect_stderr
from io import StringIO
from unittest.mock import patch

from fastapi.testclient import TestClient

_PREVIOUS_NODE_ENV = os.environ.get("NODE_ENV")
_PREVIOUS_DASHBOARD_API_TOKEN = os.environ.get("DASHBOARD_API_TOKEN")

os.environ["NODE_ENV"] = "test"
os.environ["DASHBOARD_API_TOKEN"] = _PREVIOUS_DASHBOARD_API_TOKEN or ""

import src.dashboard_api as dashboard_api

if _PREVIOUS_NODE_ENV is None:
    os.environ.pop("NODE_ENV", None)
else:
    os.environ["NODE_ENV"] = _PREVIOUS_NODE_ENV

if _PREVIOUS_DASHBOARD_API_TOKEN is None:
    os.environ.pop("DASHBOARD_API_TOKEN", None)
else:
    os.environ["DASHBOARD_API_TOKEN"] = _PREVIOUS_DASHBOARD_API_TOKEN


class DashboardApiAuthTests(unittest.TestCase):
    def test_dev_mode_allows_api_without_token(self) -> None:
        with patch.dict(os.environ, {"NODE_ENV": "development", "DASHBOARD_API_TOKEN": ""}, clear=False):
            client = TestClient(dashboard_api.app)
            response = client.get("/api/backtest/mock")

        self.assertEqual(response.status_code, 200)

    def test_configured_token_requires_authorization_bearer_header(self) -> None:
        with patch.dict(os.environ, {"DASHBOARD_API_TOKEN": "secret-token"}, clear=False):
            client = TestClient(dashboard_api.app)

            missing = client.get("/api/backtest/mock")
            legacy_header = client.get("/api/backtest/mock", headers={"X-Dashboard-Token": "secret-token"})
            valid = client.get("/api/backtest/mock", headers={"Authorization": "Bearer secret-token"})

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(legacy_header.status_code, 401)
        self.assertEqual(valid.status_code, 200)

    def test_production_refuses_to_start_without_token(self) -> None:
        error = StringIO()

        with patch.dict(os.environ, {"NODE_ENV": "production", "DASHBOARD_API_TOKEN": ""}, clear=False):
            with redirect_stderr(error):
                with self.assertRaises(RuntimeError) as raised:
                    dashboard_api.ensure_dashboard_token_in_production()

        self.assertEqual(str(raised.exception), "DASHBOARD_API_TOKEN must be set in production")
        self.assertIn("DASHBOARD_API_TOKEN must be set in production", error.getvalue())


if __name__ == "__main__":
    unittest.main()
