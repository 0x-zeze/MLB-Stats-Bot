"""Unit tests for offseason CLI scripts and Shadow Tournament Dashboard API."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import src.dashboard_api as dashboard_api
from src.dashboard_service import get_shadow_tournament_dashboard

REPO_ROOT = Path(__file__).resolve().parents[1]


class OffseasonCliAndDashboardApiTest(unittest.TestCase):
    def test_shadow_tournament_dashboard_service_handles_empty_db_and_discovers_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            art_dir = Path(tmpdir) / "models"
            art_dir.mkdir(parents=True, exist_ok=True)
            sample_art = {
                "status": "trained",
                "artifact": {
                    "model_id": "market_residual_gbdt_v2",
                    "feature_schema_version": "mlb-feature-vector-v2.0",
                    "artifact_hash": "a" * 64,
                },
            }
            (art_dir / "market_residual_gbdt_v2-trained-aaaaaaaaaaaa.json").write_text(
                json.dumps(sample_art), encoding="utf-8"
            )
            missing_db = Path(tmpdir) / "missing.sqlite"
            payload = get_shadow_tournament_dashboard(
                db_path=missing_db, min_common_games=200, artifacts_dir=art_dir
            )
            self.assertEqual(payload["verdict"], "INSUFFICIENT_DATA")
            self.assertEqual(payload["common_games"], 0)
            self.assertEqual(payload["progress_pct"], 0.0)
            self.assertFalse(payload["rule_simplification_eligible"])
            self.assertTrue(payload["artifacts_present"]["market_residual_gbdt_v2"]["present"])
            self.assertEqual(
                payload["artifacts_present"]["market_residual_gbdt_v2"]["feature_schema_version"],
                "mlb-feature-vector-v2.0",
            )
            self.assertFalse(payload["artifacts_present"]["market_residual_v2"]["present"])

    def test_dashboard_api_shadow_tournament_endpoint_and_auth(self) -> None:
        # Verify route registration and bearer-auth dependency on FastAPI app.
        matched = [r for r in dashboard_api.app.routes if getattr(r, "path", None) == "/api/shadow-tournament"]
        self.assertEqual(len(matched), 1)
        route = matched[0]
        dep_fns = [d.call for d in getattr(route, "dependant", None).dependencies]
        self.assertIn(dashboard_api.verify_token, dep_fns)

        class _FakeReq:
            def __init__(self, headers=None):
                self.headers = headers or {}

        prev_token = os.environ.get("DASHBOARD_API_TOKEN")
        try:
            os.environ["DASHBOARD_API_TOKEN"] = "test-secret-token-phase4"
            with self.assertRaises(HTTPException) as unauth:
                dashboard_api.verify_token(_FakeReq())
            self.assertEqual(unauth.exception.status_code, 401)
            dashboard_api.verify_token(_FakeReq({"authorization": "Bearer test-secret-token-phase4"}))

            body = dashboard_api.api_shadow_tournament(min_games=200)
            self.assertIn("verdict", body)
            self.assertIn("progress_pct", body)
            self.assertIn("runtime_config", body)
            self.assertIn("artifacts_present", body)
            self.assertEqual(body["min_common_games"], 200)
        finally:
            if prev_token is None:
                os.environ.pop("DASHBOARD_API_TOKEN", None)
            else:
                os.environ["DASHBOARD_API_TOKEN"] = prev_token

    def test_cli_scripts_emit_valid_json(self) -> None:
        # 1. benchmark_calibration.py --json
        p_cal = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "benchmark_calibration.py"), "--json"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        cal_json = json.loads(p_cal.stdout)
        self.assertEqual(cal_json["status"], "ok")
        self.assertEqual(cal_json["best_by_brier"], "platt")
        self.assertEqual(cal_json["best_by_log_loss"], "platt")

        # 2. shadow_tournament.py --json
        p_st = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "shadow_tournament.py"), "--json"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        st_json = json.loads(p_st.stdout)
        self.assertIn("verdict", st_json)
        self.assertIn("rule_simplification_eligible", st_json)

        # 3. train_challengers.py --dry-run --json
        p_tr = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "train_challengers.py"), "--dry-run", "--json"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        tr_json = json.loads(p_tr.stdout)
        self.assertEqual(tr_json["status"], "ok")
        self.assertIn("market_residual_gbdt_v2", tr_json["results"])


if __name__ == "__main__":
    unittest.main()
