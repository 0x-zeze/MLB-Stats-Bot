import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.memory_store import append_jsonl, ensure_evolution_storage, path_for, retrieve_similar_lessons


class MemoryStoreTests(unittest.TestCase):
    def test_storage_files_are_created_and_similar_lessons_are_retrieved(self):
        with isolated_evolution_store():
            ensure_evolution_storage()
            append_jsonl(
                "lessons",
                {
                    "lesson_id": "lesson-1",
                    "market": "totals",
                    "lesson_type": "overconfidence",
                    "supporting_data": {"market_total": 8.5, "projected_total_difference": 0.4, "data_quality": 74, "lineup_status": "projected"},
                },
            )
            result = retrieve_similar_lessons({"market": "totals", "market_total": 8.5, "projected_total_difference": 0.3, "data_quality": 72, "lineup_status": "projected"})

            self.assertTrue(path_for("prediction_outcomes").exists())

        self.assertEqual(len(result["lessons"]), 1)
        self.assertTrue(result["recommended_caution_notes"])


if __name__ == "__main__":
    unittest.main()
