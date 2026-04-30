import json
import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.memory_store import read_jsonl
from src.evolution.trajectory_logger import log_prediction_trajectory


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
                    "totals": {"lean": "Under 8.5", "projected_total": 7.9, "market_total": 8.5},
                }
            )
            stored = read_jsonl("trajectories")

        serialized = json.dumps(record)
        self.assertEqual(len(stored), 1)
        self.assertNotIn("actual_home_score", serialized)
        self.assertNotIn("actual_away_score", serialized)
        self.assertNotIn('"result"', serialized)
        self.assertEqual(record["prediction"]["final_lean"], "Under 8.5")


if __name__ == "__main__":
    unittest.main()
