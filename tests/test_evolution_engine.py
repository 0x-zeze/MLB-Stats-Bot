import unittest
import json

from evolution_helpers import final_result, isolated_evolution_store, sample_trajectory
from src.evolution.evolution_engine import evaluate_completed_prediction, ingest_bot_history, run_evolution_cycle
from src.evolution.memory_store import read_json, read_jsonl, read_prediction_outcomes


class EvolutionEngineTests(unittest.TestCase):
    def test_full_chain_logs_auditable_artifacts_without_applying_rules(self):
        with isolated_evolution_store():
            result = evaluate_completed_prediction(sample_trajectory(), final_result(home_score=3, away_score=3))
            outcomes = read_prediction_outcomes()
            losses = read_jsonl("language_losses")
            lessons = read_jsonl("lessons")
            approved = read_json("approved_rules")

        self.assertEqual(result["evaluation"]["result"], "loss")
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(len(losses), 1)
        self.assertEqual(len(lessons), 1)
        self.assertFalse(lessons[0]["production_update_allowed"])
        self.assertEqual(approved["active_rule_version"], "rules-v1.0")

    def test_bot_history_ingest_builds_lessons_once(self):
        with isolated_evolution_store() as root:
            state_path = root / "state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "predictions": {
                            "123": {
                                "gamePk": 123,
                                "dateYmd": "2026-05-01",
                                "matchup": "Alpha Aces @ Beta Bats",
                                "away": {"id": 1, "name": "Alpha Aces", "abbreviation": "AAA", "winProbability": 62},
                                "home": {"id": 2, "name": "Beta Bats", "abbreviation": "BBB", "winProbability": 38},
                                "pick": {
                                    "id": 1,
                                    "name": "Alpha Aces",
                                    "abbreviation": "AAA",
                                    "winProbability": 62,
                                    "confidence": "medium",
                                },
                                "reasons": ["Stored model liked Alpha."],
                            }
                        },
                        "memory": {
                            "learningLog": [
                                {
                                    "gamePk": 123,
                                    "matchup": "Alpha Aces @ Beta Bats",
                                    "winner": "Beta Bats",
                                    "score": "AAA 2 - 5 BBB",
                                    "correct": False,
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )

            first = ingest_bot_history(state_path)
            second = ingest_bot_history(state_path)
            cycle = run_evolution_cycle(state_path)
            outcomes = read_prediction_outcomes()
            lessons = read_jsonl("lessons")

        self.assertEqual(first["evaluated"], 1)
        self.assertEqual(second["evaluated"], 0)
        self.assertEqual(second["skipped_duplicates"], 1)
        self.assertEqual(cycle["ingest"]["evaluated"], 0)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(len(lessons), 1)


if __name__ == "__main__":
    unittest.main()
