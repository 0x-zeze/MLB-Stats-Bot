"""Schema/invariant tests for data/rules/moneyline_rules.json (Python view).

Mirrors tests/test_rule_schema.js. Enforces the pinned version, well-typed
fields, globally-unique ids, unique (engine, order) pairs, and a strict
bijection between py-scoped rule handlers and PY_HANDLERS (no orphan rules, no
dead handlers).
"""

import unittest

from src.rule_engine import PY_HANDLERS, load_moneyline_rules

VALID_ACTIONS = {"NO_BET", "CAP", "ADJUST"}
VALID_ENGINES = {"js", "py"}


class RuleSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = load_moneyline_rules()
        self.rules = self.catalog["rules"]

    def test_pinned_version(self) -> None:
        self.assertEqual(self.catalog["version"], "moneyline-rules-v1")

    def test_every_rule_has_well_typed_fields(self) -> None:
        self.assertTrue(isinstance(self.rules, list) and len(self.rules) > 0)
        for rule in self.rules:
            rid = rule.get("id")
            self.assertIsInstance(rid, str, f"id missing on {rule}")
            self.assertTrue(
                isinstance(rule.get("engines"), list) and rule["engines"],
                f"engines missing on {rid}",
            )
            self.assertTrue(
                all(e in VALID_ENGINES for e in rule["engines"]),
                f"bad engine on {rid}",
            )
            self.assertIn(rule.get("tier"), (1, 2, 3), f"tier must be 1/2/3 on {rid}")
            self.assertIsInstance(rule.get("order"), (int, float), f"order missing on {rid}")
            self.assertIn(rule.get("action"), VALID_ACTIONS, f"bad action on {rid}")
            self.assertIsInstance(rule.get("handler"), str, f"handler missing on {rid}")
            self.assertIsInstance(rule.get("message"), str, f"message missing on {rid}")

    def test_rule_ids_are_globally_unique(self) -> None:
        ids = [rule["id"] for rule in self.rules]
        self.assertEqual(len(set(ids)), len(ids))

    def test_engine_order_pairs_unique_within_each_engine(self) -> None:
        for engine in VALID_ENGINES:
            orders = [rule["order"] for rule in self.rules if engine in rule["engines"]]
            self.assertEqual(
                len(set(orders)), len(orders), f"duplicate order in engine {engine}"
            )

    def test_py_rule_handlers_all_exist(self) -> None:
        for rule in self.rules:
            if "py" not in rule["engines"]:
                continue
            self.assertIn(
                rule["handler"],
                PY_HANDLERS,
                f"Python rule {rule['id']} references unregistered handler {rule['handler']}",
            )

    def test_every_registered_handler_is_referenced(self) -> None:
        referenced = {
            rule["handler"] for rule in self.rules if "py" in rule["engines"]
        }
        for name in PY_HANDLERS:
            self.assertIn(
                name, referenced, f"PY_HANDLERS.{name} is not referenced by any py rule"
            )


if __name__ == "__main__":
    unittest.main()
