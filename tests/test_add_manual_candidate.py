import unittest

from tests.evolution_helpers import isolated_evolution_store

from src.evolution.add_manual_candidate import (
    VALID_TYPES,
    add_manual_candidate,
    build_manual_candidate,
    detect_unsafe_wording,
)
from src.evolution.memory_store import append_prediction_outcome, read_json, read_jsonl

CANONICAL_KEYS = {
    "candidate_id",
    "market",
    "type",
    "rule",
    "reason",
    "source_lessons",
    "source_losses",
    "required_backtest",
    "backtest_status",
    "status",
    "production_update_allowed",
    "source",
}


class BuildManualCandidateTests(unittest.TestCase):
    def test_schema_matches_generator_plus_source(self) -> None:
        candidate = build_manual_candidate(
            rule="NO BET when picked-team season win% is below 52%.",
            market="Moneyline",
            candidate_type="no_bet_rule",
            reason="Repeated thin-favorite losses.",
            source_lessons=["lesson-1", "lesson-2"],
            source_losses=["loss-9"],
        )
        # Canonical generator schema + the manual `source` discriminator.
        self.assertEqual(set(candidate.keys()), CANONICAL_KEYS)
        self.assertEqual(candidate["source"], "manual")
        self.assertEqual(candidate["market"], "moneyline")  # lowercased
        self.assertEqual(candidate["type"], "no_bet_rule")
        self.assertTrue(candidate["required_backtest"])
        self.assertEqual(candidate["backtest_status"], "pending")
        self.assertEqual(candidate["status"], "pending")
        self.assertFalse(candidate["production_update_allowed"])
        self.assertEqual(candidate["source_lessons"], ["lesson-1", "lesson-2"])
        self.assertEqual(candidate["source_losses"], ["loss-9"])

    def test_candidate_id_is_manual_prefixed(self) -> None:
        candidate = build_manual_candidate(rule="Some rule text.")
        self.assertTrue(
            candidate["candidate_id"].startswith("manual-"),
            candidate["candidate_id"],
        )

    def test_build_does_not_stamp_created_at(self) -> None:
        # append_jsonl stamps created_at; build must not, matching the generator.
        candidate = build_manual_candidate(rule="Some rule text.")
        self.assertNotIn("created_at", candidate)

    def test_empty_rule_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build_manual_candidate(rule="   ")

    def test_invalid_type_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build_manual_candidate(rule="x", candidate_type="not_a_real_type")

    def test_all_valid_types_accepted(self) -> None:
        for candidate_type in VALID_TYPES:
            candidate = build_manual_candidate(rule="x", candidate_type=candidate_type)
            self.assertEqual(candidate["type"], candidate_type)


class UnsafeWordingTests(unittest.TestCase):
    def test_flags_remove_no_bet(self) -> None:
        warning = detect_unsafe_wording("no_bet_rule", "remove no bet floor", "")
        self.assertIsNotNone(warning)

    def test_flags_high_confidence_without_calibration(self) -> None:
        warning = detect_unsafe_wording(
            "confidence_cap", "increase high confidence on favorites", ""
        )
        self.assertIsNotNone(warning)

    def test_safe_wording_passes(self) -> None:
        warning = detect_unsafe_wording(
            "no_bet_rule", "NO BET when team win% below 52%.", "thin favorites"
        )
        self.assertIsNone(warning)


class PersistAndGateTests(unittest.TestCase):
    def test_persist_writes_pending_candidate(self) -> None:
        with isolated_evolution_store():
            saved = add_manual_candidate(
                rule="NO BET when away underdog exceeds +115.",
                market="moneyline",
            )
            self.assertIn("created_at", saved)  # stamped by append_jsonl
            rows = read_jsonl("rule_candidates")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["candidate_id"], saved["candidate_id"])
            self.assertEqual(rows[0]["source"], "manual")
            self.assertEqual(rows[0]["status"], "pending")

    def test_persist_is_idempotent(self) -> None:
        with isolated_evolution_store():
            first = add_manual_candidate(rule="Identical rule text.")
            second = add_manual_candidate(rule="Identical rule text.")
            self.assertEqual(first["candidate_id"], second["candidate_id"])
            self.assertEqual(len(read_jsonl("rule_candidates")), 1)

    def test_manual_candidate_defers_through_gate_no_bypass(self) -> None:
        # A freshly-created candidate has ~0 post-creation outcomes, so the
        # engine must mark it insufficient_data/deferred and NEVER promote it.
        from src.evolution.evolution_engine import backtest_candidates

        with isolated_evolution_store():
            add_manual_candidate(
                rule="NO BET when model conviction is below 52%.",
                market="moneyline",
            )
            # Seed only PAST-dated outcomes -> all land in `before`, `after` empty.
            for index in range(25):
                append_prediction_outcome(
                    {
                        "game_id": f"2020-01-01-G{index}",
                        "date": "2020-01-01",
                        "market": "moneyline",
                        "prediction": "home",
                        "confidence": "Medium",
                        "result": "win" if index % 2 == 0 else "loss",
                        "profit_loss": "1.0" if index % 2 == 0 else "-1.0",
                    }
                )

            backtest_candidates()

            candidate = read_jsonl("rule_candidates")[0]
            self.assertEqual(candidate["backtest_status"], "insufficient_data")
            self.assertEqual(candidate["promotion_status"], "deferred")
            self.assertFalse(candidate["production_update_allowed"])

            # No bypass: nothing was written into approved_rules.
            approved = read_json("approved_rules").get("approved", [])
            manual_ids = {
                entry.get("candidate", {}).get("candidate_id") for entry in approved
            }
            self.assertNotIn(candidate["candidate_id"], manual_ids)


if __name__ == "__main__":
    unittest.main()
