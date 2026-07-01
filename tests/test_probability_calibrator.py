import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import src.probability_calibrator as pc


class PerMarketCalibratorTests(unittest.TestCase):
    def setUp(self):
        # Each test runs against an isolated cache so the real maps are untouched.
        pc._cached_maps = None

    def tearDown(self):
        pc._cached_maps = None

    def test_calibrate_passthrough_when_no_map(self):
        with patch.object(pc, "_cached_maps", {}):
            self.assertEqual(pc.calibrate(0.62, market="yrfi"), 0.62)

    def test_calibrate_uses_market_specific_map(self):
        maps = {
            "moneyline": [(0.4, 0.35), (0.6, 0.55)],
            "yrfi": [(0.4, 0.50), (0.6, 0.50)],  # flat -> always 0.50
        }
        with patch.object(pc, "_cached_maps", maps):
            # totals map collapses everything toward 0.50
            self.assertAlmostEqual(pc.calibrate(0.55, market="yrfi"), 0.50, places=4)
            # moneyline map interpolates 0.5 -> 0.45
            self.assertAlmostEqual(pc.calibrate(0.5, market="moneyline"), 0.45, places=4)

    def test_calibrate_clamps_output(self):
        maps = {"moneyline": [(0.1, 0.0), (0.9, 1.0)]}
        with patch.object(pc, "_cached_maps", maps):
            self.assertGreaterEqual(pc.calibrate(0.95, market="moneyline"), 0.05)
            self.assertLessEqual(pc.calibrate(0.95, market="moneyline"), 0.95)

    def test_normalize_probability_accepts_decimal_percent_and_rejects_bad(self):
        self.assertEqual(pc._normalize_probability(0.59), 0.59)
        self.assertEqual(pc._normalize_probability(59), 0.59)
        self.assertEqual(pc._normalize_probability("59%"), 0.59)
        self.assertIsNone(pc._normalize_probability(""))
        self.assertIsNone(pc._normalize_probability("bad"))
        self.assertIsNone(pc._normalize_probability(101))
        self.assertIsNone(pc._normalize_probability(-1))

    def test_retrain_builds_per_market_maps(self):
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "prediction_outcomes.csv"
            rows = ["game_id,market,result,brier_score,evaluation_json"]
            # 60 moneyline rows spread across probability bins, win-rate tracks prob.
            for i in range(60):
                prob = 0.40 + (i % 6) * 0.04
                won = 1 if (i % 10) < int(prob * 10) else 0
                ej = json.dumps({"model_probability": prob})
                rows.append(f"g{i},moneyline,{'win' if won else 'loss'},0.2,\"{ej.replace(chr(34), chr(34)*2)}\"")
            outcomes.write_text("\n".join(rows))

            maps_path = Path(tmp) / "calibration_maps.json"
            legacy_path = Path(tmp) / "calibration_map.json"
            with patch.object(pc, "_OUTCOMES_PATH", outcomes), \
                 patch.object(pc, "_CALIBRATION_MAPS_PATH", maps_path), \
                 patch.object(pc, "_CALIBRATION_MAP_PATH", legacy_path):
                pc._cached_maps = None
                result = pc.retrain()

            self.assertEqual(result["status"], "success")
            self.assertIn("moneyline", result["calibrated_markets"])
            # yrfi had no samples -> skipped, not crashed
            self.assertEqual(result["markets"]["yrfi"]["status"], "skipped")
            self.assertTrue(maps_path.exists())
            # legacy file kept in sync for older readers
            self.assertTrue(legacy_path.exists())

    def test_retrain_from_sqlite_uses_ledger_model_prob_without_edge_fallback(self):
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "state.sqlite"
            conn = sqlite3.connect(db_path)
            conn.execute(
                """
                CREATE TABLE bet_ledger (
                    market TEXT,
                    model_prob REAL,
                    edge REAL,
                    status TEXT,
                    result TEXT
                )
                """
            )
            rows = []
            for i in range(60):
                prob = 0.36 + (i % 8) * 0.04
                outcome = "win" if (i % 8) >= 4 else "loss"
                rows.append(("moneyline", prob, 30.0, "settled", outcome))
            rows.append(("moneyline", None, 50.0, "settled", "win"))
            conn.executemany("INSERT INTO bet_ledger VALUES (?, ?, ?, ?, ?)", rows)
            conn.commit()
            conn.close()

            maps_path = Path(tmp) / "calibration_maps.json"
            legacy_path = Path(tmp) / "calibration_map.json"
            with patch.object(pc, "_CALIBRATION_MAPS_PATH", maps_path), \
                 patch.object(pc, "_CALIBRATION_MAP_PATH", legacy_path):
                pc._cached_maps = None
                result = pc.retrain_from_sqlite(db_path)

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["source"], "SQLite bet_ledger")
            self.assertIn("moneyline", result["calibrated_markets"])
            self.assertGreater(result["markets"]["moneyline"]["map_points"], 4)
            saved = json.loads(maps_path.read_text())
            self.assertGreater(len(saved["moneyline"]), 4)
            # Edge fallback would create a 0.8 probability point from edge=30; SQLite path must not.
            self.assertLess(max(point[0] for point in saved["moneyline"]), 0.7)
            self.assertTrue(legacy_path.exists())

    def test_retrain_default_prefers_sqlite_when_available(self):
        with TemporaryDirectory() as tmp:
            sqlite_path = Path(tmp) / "state.sqlite"
            sqlite_path.write_bytes(b"")
            with patch.object(pc, "_SQLITE_PATH", sqlite_path), \
                 patch.object(pc, "retrain_from_sqlite", return_value={"status": "ok", "source": "SQLite bet_ledger"}) as sqlite_retrain, \
                 patch.object(pc, "retrain", return_value={"status": "csv"}) as csv_retrain:
                result = pc.retrain_default()

            self.assertEqual(result["source"], "SQLite bet_ledger")
            sqlite_retrain.assert_called_once_with(sqlite_path)
            csv_retrain.assert_not_called()

    def test_retrain_calibrates_totals_from_predicted_probability_disabled(self):
        pass  # totals market removed


if __name__ == "__main__":
    unittest.main()
