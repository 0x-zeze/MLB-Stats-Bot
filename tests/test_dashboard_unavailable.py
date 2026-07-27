"""Live dashboard failures must not look like real mock betting data."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from src.dashboard_service import get_today_dashboard


class DashboardUnavailableTests(unittest.TestCase):
    def test_live_failure_returns_unavailable_not_mock_games(self) -> None:
        with patch(
            "src.dashboard_service._live_today",
            side_effect=RuntimeError("node pipeline crashed"),
        ):
            payload = get_today_dashboard(date_ymd="2026-07-27", source="live")

        self.assertEqual(payload.get("status"), "unavailable")
        self.assertEqual(payload.get("source"), "live")
        self.assertEqual(payload.get("summary", {}).get("total_games"), 0)
        self.assertEqual(payload.get("games"), [])
        self.assertIn("unavailable", str(payload.get("reason", "")).lower())
        # Must not synthesize BET decisions from mock.
        self.assertNotIn("BET", [g.get("decision") for g in payload.get("games", [])])

    def test_explicit_mock_source_still_works(self) -> None:
        payload = get_today_dashboard(source="mock")
        self.assertNotEqual(payload.get("status"), "unavailable")
        self.assertGreaterEqual(payload["summary"]["total_games"], 1)


if __name__ == "__main__":
    unittest.main()
