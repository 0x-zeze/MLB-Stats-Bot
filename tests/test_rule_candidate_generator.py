import unittest

from src.evolution.rule_candidate_generator import generate_rule_candidates


class RuleCandidateGeneratorTests(unittest.TestCase):
    def test_repeated_pattern_generates_rule_candidate(self):
        lessons = [
            {
                "lesson_id": f"lesson-{index}",
                "lesson_type": "overconfidence",
                "category": "confidence",
                "suggested_adjustment": "Cap totals confidence when projected total difference is below 0.5 and lineup is not confirmed.",
            }
            for index in range(5)
        ]

        candidates = generate_rule_candidates(lessons, [], persist=False)

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["type"], "confidence_cap")
        self.assertTrue(candidates[0]["required_backtest"])
        self.assertFalse(candidates[0]["production_update_allowed"])


if __name__ == "__main__":
    unittest.main()
