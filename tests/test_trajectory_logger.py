import json
import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.memory_store import read_jsonl
from src.evolution.trajectory_logger import log_prediction_trajectory, trajectory_dedupe_key


class TrajectoryLoggerTests(unittest.TestCase):
    def test_trajectory_is_stored_without_final_score_before_game(self):
        with isolated_evolution_store():
            record = log_prediction_trajectory(
                {
                    "id": "game-1",
                    "date": "2026-04-30",
                    "away_team": "Tampa Bay Rays",
                    "home_team": "Cleveland Guardians",
                    "actual_home_score": 4,
                    "actual_away_score": 2,
                    "result": "loss",
                    "data_quality": {"score": 77, "lineup": "Projected", "weather": "Missing"},
                    "yrfi": {"pick": "YES", "probability": 55},
                }
            )
            stored = read_jsonl("trajectories")

        serialized = json.dumps(record)
        self.assertEqual(len(stored), 1)
        self.assertNotIn("actual_home_score", serialized)
        self.assertNotIn("actual_away_score", serialized)
        self.assertNotIn('"result"', serialized)
        self.assertEqual(record["prediction"]["final_lean"], "YES")
        self.assertEqual(record["trajectory_key"], trajectory_dedupe_key(record))

    def test_duplicate_trajectory_is_not_appended_twice(self):
        with isolated_evolution_store():
            context = {
                "id": "game-1",
                "date": "2026-04-30",
                "away_team": "Tampa Bay Rays",
                "home_team": "Cleveland Guardians",
                "yrfi": {"pick": "YES", "probability": 55},
            }
            first = log_prediction_trajectory(context)
            second = log_prediction_trajectory(context)
            stored = read_jsonl("trajectories")

        self.assertEqual(len(stored), 1)
        self.assertEqual(first["trajectory_key"], second["trajectory_key"])
        self.assertEqual(stored[0]["trajectory_key"], first["trajectory_key"])

    def test_materially_different_prediction_gets_new_trajectory(self):
        with isolated_evolution_store():
            context = {
                "id": "game-1",
                "date": "2026-04-30",
                "away_team": "Tampa Bay Rays",
                "home_team": "Cleveland Guardians",
                "yrfi": {"pick": "YES", "probability": 55},
            }
            log_prediction_trajectory(context)
            changed = dict(context)
            changed["yrfi"] = {"pick": "NO", "probability": 45}
            log_prediction_trajectory(changed)
            stored = read_jsonl("trajectories")

        self.assertEqual(len(stored), 2)
        self.assertNotEqual(stored[0]["trajectory_key"], stored[1]["trajectory_key"])


if __name__ == "__main__":
    unittest.main()
