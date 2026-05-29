import csv
import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.evolution.llm_value_eval import evaluate


def _write_outcomes(path: Path, games):
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["game_id", "market", "result", "brier_score", "evaluation_json"])
        for gid, home_won in games:
            ej = json.dumps({
                "actual_home_score": 5 if home_won else 3,
                "actual_away_score": 3 if home_won else 5,
            })
            writer.writerow([gid, "moneyline", "win" if home_won else "loss", 0.25, ej])


def _write_state(path: Path, picks):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE picks (game_pk TEXT, payload TEXT)")
    for gid, baseline_home, final_home, applied in picks:
        payload = {
            "gamePk": gid,
            "home": {"winProbability": final_home},
            "away": {"winProbability": 100 - final_home},
            "agentShift": {
                "applied": applied,
                "shift": final_home - baseline_home,
                "baselineHomeProbability": baseline_home,
                "baselineAwayProbability": 100 - baseline_home,
            },
        }
        con.execute("INSERT INTO picks VALUES (?, ?)", (gid, json.dumps(payload)))
    con.commit()
    con.close()


class LlmValueEvalTests(unittest.TestCase):
    def test_no_data_when_no_shifts_applied(self):
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "o.csv"
            state = Path(tmp) / "s.sqlite"
            _write_outcomes(outcomes, [("g1", True)])
            _write_state(state, [("g1", 60, 62, False)])  # not applied
            result = evaluate(outcomes_path=outcomes, state_path=state)
            self.assertEqual(result["status"], "no_data")

    def test_detects_when_llm_helps(self):
        # Shift moves probability toward the correct outcome -> lower Brier.
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "o.csv"
            state = Path(tmp) / "s.sqlite"
            games = [(f"g{i}", i % 2 == 0) for i in range(20)]
            _write_outcomes(outcomes, games)
            picks = []
            for i in range(20):
                home_won = i % 2 == 0
                baseline = 55 if home_won else 45
                final = 65 if home_won else 35  # shifted toward truth
                picks.append((f"g{i}", baseline, final, True))
            _write_state(state, picks)
            result = evaluate(outcomes_path=outcomes, state_path=state)
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["paired_games"], 20)
            self.assertTrue(result["llm_helps"])
            self.assertGreater(result["improvement"], 0)

    def test_detects_when_llm_hurts(self):
        # Shift moves probability away from the correct outcome -> higher Brier.
        with TemporaryDirectory() as tmp:
            outcomes = Path(tmp) / "o.csv"
            state = Path(tmp) / "s.sqlite"
            games = [(f"g{i}", i % 2 == 0) for i in range(20)]
            _write_outcomes(outcomes, games)
            picks = []
            for i in range(20):
                home_won = i % 2 == 0
                baseline = 60 if home_won else 40
                final = 52 if home_won else 48  # shifted toward coinflip (away from truth)
                picks.append((f"g{i}", baseline, final, True))
            _write_state(state, picks)
            result = evaluate(outcomes_path=outcomes, state_path=state)
            self.assertEqual(result["status"], "success")
            self.assertFalse(result["llm_helps"])


if __name__ == "__main__":
    unittest.main()
