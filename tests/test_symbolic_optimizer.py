import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.memory_store import read_json
from src.evolution.symbolic_optimizer import propose_symbolic_updates


class SymbolicOptimizerTests(unittest.TestCase):
    def test_symbolic_optimizer_creates_candidate_but_does_not_auto_apply_it(self):
        with isolated_evolution_store():
            before = read_json("approved_rules")
            candidates = propose_symbolic_updates(
                [
                    {
                        "gradient_id": "grad-1",
                        "source_loss_id": "loss-1",
                        "target": "confidence_rules",
                        "gradient": "Cap confidence on low-edge totals.",
                        "reason": "Repeated low-edge losses.",
                    }
                ]
            )
            after = read_json("approved_rules")

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["status"], "pending")
        self.assertEqual(before["active_rule_version"], after["active_rule_version"])


if __name__ == "__main__":
    unittest.main()
