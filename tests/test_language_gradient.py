import unittest

from src.evolution.language_gradient import generate_language_gradient


class LanguageGradientTests(unittest.TestCase):
    def test_language_gradient_is_generated_from_loss(self):
        gradient = generate_language_gradient({"loss_id": "loss-1", "loss_type": "overconfidence", "loss_summary": "Too confident."})

        self.assertEqual(gradient["target"], "confidence_rules")
        self.assertEqual(gradient["suggested_update_type"], "confidence_cap")
        self.assertIn("confidence", gradient["gradient"].lower())

    def test_record_bias_generates_no_bet_gradient(self):
        gradient = generate_language_gradient({"loss_id": "loss-2", "loss_type": "record_bias", "loss_summary": "Record context dominated."})

        self.assertEqual(gradient["target"], "no_bet_rules")
        self.assertEqual(gradient["suggested_update_type"], "no_bet_rule")
        self.assertIn("record", gradient["gradient"].lower())


if __name__ == "__main__":
    unittest.main()
