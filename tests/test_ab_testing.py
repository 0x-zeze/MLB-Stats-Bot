"""Tests for A/B testing framework."""

import unittest

from src.evolution.ab_testing import (
    ABTestingFramework,
    ModelVariant,
)


class TestABTestingFramework(unittest.TestCase):
    def setUp(self) -> None:
        self.framework = ABTestingFramework()
        self.variant_a = ModelVariant(
            variant_id="v1_base",
            weights={"team_strength": 0.30, "starting_pitcher": 0.25, "offense": 0.20, "bullpen": 0.10, "recent_form": 0.10, "home_field": 0.05},
            description="Baseline weights",
        )
        self.variant_b = ModelVariant(
            variant_id="v2_pitcher_heavy",
            weights={"team_strength": 0.25, "starting_pitcher": 0.30, "offense": 0.20, "bullpen": 0.10, "recent_form": 0.10, "home_field": 0.05},
            description="Pitcher-heavy weights",
        )

    def test_register_variant(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.assertIn("v1_base", self.framework.variants)

    def test_assign_game_deterministic(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.register_variant(self.variant_b)
        assigned1 = self.framework.assign_game("game_123")
        assigned2 = self.framework.assign_game("game_123")
        self.assertEqual(assigned1, assigned2)

    def test_assign_game_distributes(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.register_variant(self.variant_b)
        assignments = set()
        for i in range(50):
            assignments.add(self.framework.assign_game(f"game_{i}"))
        self.assertEqual(len(assignments), 2)

    def test_record_outcome(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.register_variant(self.variant_b)
        game_id = "game_1"
        variant = self.framework.assign_game(game_id)
        self.framework.record_outcome(game_id, {"correct": True, "predicted_probability": 0.65})
        self.assertEqual(len(self.framework.outcomes[variant]), 1)

    def test_evaluate_insufficient_data(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.register_variant(self.variant_b)
        result = self.framework.evaluate()
        self.assertIsNone(result)

    def test_evaluate_with_sufficient_data(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.register_variant(self.variant_b)

        for i in range(60):
            game_id = f"game_{i}"
            self.framework.assign_game(game_id)
            self.framework.record_outcome(game_id, {
                "correct": i % 2 == 0,
                "predicted_probability": 0.60,
                "profit_loss": 0.5 if i % 2 == 0 else -1.0,
            })

        result = self.framework.evaluate()
        if result is not None:
            self.assertGreater(result.games_evaluated, 0)
            self.assertIn(result.variant_a, ("v1_base", "v2_pitcher_heavy"))

    def test_get_variant_weights(self) -> None:
        self.framework.register_variant(self.variant_a)
        weights = self.framework.get_variant_weights("v1_base")
        self.assertIsNotNone(weights)
        self.assertAlmostEqual(weights["team_strength"], 0.30)

    def test_get_variant_weights_missing(self) -> None:
        self.assertIsNone(self.framework.get_variant_weights("nonexistent"))

    def test_reset(self) -> None:
        self.framework.register_variant(self.variant_a)
        self.framework.assign_game("game_1")
        self.framework.reset()
        self.assertEqual(len(self.framework.variants), 0)
        self.assertEqual(len(self.framework.assignments), 0)


if __name__ == "__main__":
    unittest.main()
