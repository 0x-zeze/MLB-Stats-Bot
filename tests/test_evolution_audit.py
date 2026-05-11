import unittest

from evolution_helpers import isolated_evolution_store
from src.evolution.evolution_audit import build_evolution_audit
from src.evolution.memory_store import append_jsonl, append_prediction_outcome, read_jsonl


class EvolutionAuditTests(unittest.TestCase):
    def test_audit_ranks_weak_segments_root_causes_and_candidates(self):
        with isolated_evolution_store():
            append_prediction_outcome(
                {
                    "game_id": "game-1",
                    "date": "2026-05-01",
                    "market": "moneyline",
                    "prediction": "Home Team",
                    "confidence": "high",
                    "result": "loss",
                    "edge": 1.4,
                    "data_quality": 72,
                    "brier_score": 0.36,
                }
            )
            append_prediction_outcome(
                {
                    "game_id": "game-2",
                    "date": "2026-05-01",
                    "market": "moneyline",
                    "prediction": "Away Team",
                    "confidence": "high",
                    "result": "loss",
                    "edge": 1.8,
                    "data_quality": 70,
                    "brier_score": 0.32,
                }
            )
            append_prediction_outcome(
                {
                    "game_id": "game-3",
                    "date": "2026-05-02",
                    "market": "moneyline",
                    "prediction": "Away Team",
                    "confidence": "medium",
                    "result": "win",
                    "edge": 4.2,
                    "data_quality": 82,
                    "brier_score": 0.12,
                }
            )
            append_jsonl(
                "language_losses",
                {
                    "loss_id": "loss-1",
                    "game_id": "game-1",
                    "market": "moneyline",
                    "loss_type": "weak_edge",
                    "affected_factor": "market_edge",
                    "severity": "medium",
                    "loss_summary": "Weak edge lost.",
                },
            )
            append_jsonl(
                "language_losses",
                {
                    "loss_id": "loss-2",
                    "game_id": "game-2",
                    "market": "moneyline",
                    "loss_type": "weak_edge",
                    "affected_factor": "market_edge",
                    "severity": "high",
                    "loss_summary": "Weak edge lost again.",
                },
            )
            append_jsonl(
                "lessons",
                {
                    "lesson_id": "lesson-1",
                    "lesson_type": "weak_edge",
                    "category": "market_movement",
                    "result": "loss",
                },
            )
            append_jsonl(
                "language_gradients",
                {
                    "gradient_id": "grad-1",
                    "source_loss_id": "loss-1",
                    "target": "market_edge_threshold",
                    "gradient": "Require stronger edge.",
                },
            )
            append_jsonl(
                "rule_candidates",
                {
                    "candidate_id": "cand-1",
                    "type": "no_bet_rule",
                    "rule": "Return NO BET when edge is weak.",
                    "source_losses": ["loss-1", "loss-2"],
                    "status": "pending",
                    "backtest_status": "pending",
                },
            )

            audit = build_evolution_audit(min_segment_sample=2, persist=True)
            reports = read_jsonl("audit_reports")

        self.assertEqual(audit["summary"]["evaluated"], 3)
        self.assertEqual(audit["summary"]["losses"], 2)
        self.assertEqual(audit["root_causes"][0]["loss_type"], "weak_edge")
        self.assertTrue(any(item["segment"] == "confidence:high" for item in audit["weakest_segments"]))
        self.assertEqual(audit["candidate_priorities"][0]["candidate_id"], "cand-1")
        self.assertTrue(audit["priority_recommendations"])
        self.assertEqual(len(reports), 1)


if __name__ == "__main__":
    unittest.main()
