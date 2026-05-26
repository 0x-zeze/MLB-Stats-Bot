import unittest

from src.risk_management import apply_risk_framework


def _quality(**overrides):
    payload = {
        "score": 92,
        "probable_pitchers": "Confirmed",
        "lineup": "Confirmed",
        "odds": "Fresh",
        "stale_fields": [],
        "missing_fields": [],
    }
    payload.update(overrides)
    return payload


def _prediction(**overrides):
    payload = {
        "decision": "BET",
        "confidence": "High",
        "model_probability": 0.58,
        "model_edge": 0.05,
        "american_odds": -110,
        "raw_lean": "Home Team",
    }
    payload.update(overrides)
    return payload


class RiskManagementTests(unittest.TestCase):
    def test_flat_stake_keeps_qualified_bet_small_and_explicit(self) -> None:
        result = apply_risk_framework(
            _prediction(),
            _quality(),
            {
                "stake_mode": "flat",
                "flat_stake_units": 1.0,
                "max_daily_exposure_units": 3.0,
                "max_pick_confidence": 0.64,
            },
        )

        self.assertEqual(result["decision"], "BET")
        self.assertEqual(result["risk_framework"]["stake_mode"], "flat")
        self.assertEqual(result["risk_framework"]["stake_units"], 1.0)
        self.assertEqual(result["risk_framework"]["max_daily_exposure_units"], 3.0)
        self.assertIn("not guaranteed betting advice", result["risk_framework"]["risk_warning"].lower())

    def test_fractional_kelly_is_optional_and_capped(self) -> None:
        result = apply_risk_framework(
            _prediction(model_probability=0.60, american_odds=120),
            _quality(),
            {
                "stake_mode": "fractional_kelly",
                "kelly_fraction": 0.25,
                "max_stake_units": 1.5,
                "bankroll_units": 100.0,
            },
        )

        self.assertEqual(result["decision"], "BET")
        self.assertEqual(result["risk_framework"]["stake_mode"], "fractional_kelly")
        self.assertGreater(result["risk_framework"]["stake_units"], 0)
        self.assertLessEqual(result["risk_framework"]["stake_units"], 1.5)

    def test_low_data_quality_forces_no_bet_and_zero_stake(self) -> None:
        result = apply_risk_framework(_prediction(), _quality(score=55))

        self.assertEqual(result["decision"], "NO BET")
        self.assertEqual(result["risk_framework"]["stake_units"], 0.0)
        self.assertIn("data quality below minimum", result["decision_reason"].lower())

    def test_stale_lineup_pitcher_or_odds_forces_no_bet(self) -> None:
        for field in ("lineup", "probable_pitchers", "odds"):
            with self.subTest(field=field):
                result = apply_risk_framework(_prediction(), _quality(**{field: "Stale"}))

                self.assertEqual(result["decision"], "NO BET")
                self.assertEqual(result["risk_framework"]["stake_units"], 0.0)
                self.assertIn("stale", result["decision_reason"].lower())

    def test_confidence_probability_is_capped_without_hiding_raw_value(self) -> None:
        result = apply_risk_framework(
            _prediction(model_probability=0.82),
            _quality(),
            {"max_pick_confidence": 0.64},
        )

        self.assertEqual(result["risk_framework"]["raw_model_probability"], 0.82)
        self.assertEqual(result["risk_framework"]["capped_model_probability"], 0.64)
        self.assertTrue(any("confidence cap" in item.lower() for item in result["risk_framework"]["warnings"]))


if __name__ == "__main__":
    unittest.main()
