import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.memory_store import read_json
from src.evolution.promotion_gate import run_promotion_gate


class PromotionGateTests(unittest.TestCase):
    def metrics(self, **overrides):
        base = {"sample_size": 80, "roi": 0.02, "log_loss": 0.62, "brier_score": 0.21, "average_clv": 0.01, "no_bet_accuracy": 0.7, "max_drawdown": -6}
        base.update(overrides)
        return base

    def test_low_sample_candidate_is_rejected(self):
        result = run_promotion_gate({"candidate_id": "cand-low", "type": "confidence_cap"}, self.metrics(), self.metrics(sample_size=10, roi=0.05), persist=False)

        self.assertEqual(result["status"], "rejected")
        self.assertIn("Sample size", result["reason"])

    def test_bad_backtest_candidate_is_rejected(self):
        result = run_promotion_gate({"candidate_id": "cand-bad", "type": "threshold_update"}, self.metrics(), self.metrics(roi=-0.01, log_loss=0.7), persist=False)

        self.assertEqual(result["status"], "rejected")

    def test_good_candidate_is_approved_and_rules_are_versioned(self):
        with isolated_evolution_store():
            result = run_promotion_gate({"candidate_id": "cand-good", "type": "no_bet_rule"}, self.metrics(), self.metrics(roi=0.04, log_loss=0.6, brier_score=0.205))
            approved = read_json("approved_rules")

        self.assertEqual(result["status"], "approved")
        self.assertEqual(approved["active_rule_version"], "rules-v1.1")

    def test_no_bet_protections_cannot_be_removed_automatically(self):
        result = run_promotion_gate({"candidate_id": "cand-unsafe", "rule": "Remove NO BET protections for totals."}, self.metrics(), self.metrics(roi=0.08, log_loss=0.58), persist=False)

        self.assertEqual(result["status"], "rejected")
        self.assertIn("NO BET", result["reason"])


if __name__ == "__main__":
    unittest.main()
