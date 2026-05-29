import csv
import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.evolution.ml_model_eval import (
    FEATURE_COLUMNS,
    _build_dataset,
    evaluate,
)


def _write_outcomes(path: Path, n: int):
    header = ["game_id", "market", "result", "brier_score", "evaluation_json"]
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for i in range(n):
            home_won = i % 2 == 0
            ej = json.dumps({
                "actual_home_score": 5 if home_won else 3,
                "actual_away_score": 3 if home_won else 5,
            })
            writer.writerow([f"g{i}", "moneyline", "win" if home_won else "loss", 0.25, ej])


def _write_state(path: Path, n: int):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE picks (game_pk TEXT, payload TEXT)")
    for i in range(n):
        home_won = i % 2 == 0
        # Make matchupEdge weakly correlate with the label so models can learn.
        breakdown = {col: 0.0 for col in FEATURE_COLUMNS}
        breakdown["matchupEdge"] = 0.2 if home_won else -0.2
        payload = {
            "gamePk": f"g{i}",
            "dateYmd": f"2026-05-{(i % 28) + 1:02d}",
            "modelBreakdown": breakdown,
            "home": {"winProbability": 60 if home_won else 40},
            "away": {"winProbability": 40 if home_won else 60},
        }
        con.execute("INSERT INTO picks VALUES (?, ?)", (f"g{i}", json.dumps(payload)))
    con.commit()
    con.close()


class MlModelEvalTests(unittest.TestCase):
    def test_skips_gracefully_on_thin_data(self):
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "outcomes.csv"
            state = Path(tmp) / "state.sqlite"
            _write_outcomes(outcomes, 10)
            _write_state(state, 10)
            result = evaluate(outcomes_path=outcomes, state_path=state)
            self.assertEqual(result["status"], "skipped")
            self.assertEqual(result["joined_rows"], 10)

    def test_builds_chronologically_sorted_joined_dataset(self):
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "outcomes.csv"
            state = Path(tmp) / "state.sqlite"
            _write_outcomes(outcomes, 40)
            _write_state(state, 40)
            dataset = _build_dataset(outcomes, state)
            self.assertEqual(len(dataset), 40)
            dates = [row["date"] for row in dataset]
            self.assertEqual(dates, sorted(dates))
            self.assertIn("home_win", dataset[0])

    def test_evaluate_reports_baseline_and_models(self):
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "outcomes.csv"
            state = Path(tmp) / "state.sqlite"
            _write_outcomes(outcomes, 160)
            _write_state(state, 160)
            result = evaluate(outcomes_path=outcomes, state_path=state)
            # sklearn may be unavailable; tolerate that path.
            if result["status"] == "error":
                self.skipTest(result["reason"])
            self.assertEqual(result["status"], "success")
            self.assertIn("baseline_brier", result)
            self.assertIn("best", result)
            self.assertTrue(result["models"])


if __name__ == "__main__":
    unittest.main()
