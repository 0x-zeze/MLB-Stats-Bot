"""Golden/characterization parity for the Python moneyline engine.

The goldens in fixtures/moneyline_py_goldens.json were captured from the
pre-refactor apply_confidence_downgrade(). After the refactor delegates its
middle block to src.rule_engine.evaluate_moneyline(), this suite proves the
full output dict is byte-identical for every corpus case. If a golden ever
needs to change, it must be because production behavior INTENTIONALLY changed
-- never to paper over a refactor regression.
"""

import json
import os
import unittest

from src.quality_control import apply_confidence_downgrade

_FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")

with open(os.path.join(_FIXTURES, "moneyline_py_goldens.json"), encoding="utf-8") as _f:
    GOLDENS = json.load(_f)


class MoneylineParityTest(unittest.TestCase):
    def test_output_matches_captured_goldens_for_whole_corpus(self) -> None:
        import sys

        if _FIXTURES not in sys.path:
            sys.path.insert(0, os.path.dirname(__file__))
        from fixtures.moneyline_py_corpus import CORPUS

        self.assertEqual(
            set(CORPUS.keys()),
            set(GOLDENS.keys()),
            "corpus and goldens must cover the same cases",
        )

        for name, factory in CORPUS.items():
            with self.subTest(case=name):
                prediction, report = factory()
                actual = apply_confidence_downgrade(prediction, report)
                self.assertEqual(
                    actual, GOLDENS[name], f"parity mismatch on case '{name}'"
                )


if __name__ == "__main__":
    unittest.main()
