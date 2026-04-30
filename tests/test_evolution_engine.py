import unittest

from evolution_helpers import final_result, isolated_evolution_store, sample_trajectory
from src.evolution.evolution_engine import evaluate_completed_prediction
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


if __name__ == "__main__":
    unittest.main()
