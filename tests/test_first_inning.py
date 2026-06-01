"""Tests for first-inning deterministic model."""

import unittest

from src.first_inning import (
    FirstInningContext,
    predict_first_inning,
)


class TestPredictFirstInning(unittest.TestCase):
    def test_default_context(self) -> None:
        ctx = FirstInningContext()
        result = predict_first_inning(ctx)
        self.assertAlmostEqual(result.yrfi_probability + result.nrfi_probability, 1.0, places=4)
        self.assertGreater(result.yrfi_probability, 0.0)
        self.assertGreater(result.nrfi_probability, 0.0)

    def test_default_context_centers_on_empirical_base_rate(self) -> None:
        # A run scores in the 1st in ~55% of games. A league-average context must
        # center near that, not below 50% — the old 0.27 prior biased it to ~47%
        # and made the model pick NRFI on games that actually scored.
        result = predict_first_inning(FirstInningContext())
        self.assertGreaterEqual(result.yrfi_probability, 0.52)
        self.assertLessEqual(result.yrfi_probability, 0.60)

    def test_high_scoring_teams_favor_yrfi(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.38,
            home_first_inning_scoring_rate=0.35,
            away_first_inning_allowed_rate=0.32,
            home_first_inning_allowed_rate=0.33,
            away_pitcher_first_inning_era=5.80,
            home_pitcher_first_inning_era=5.50,
            away_leadoff_obp=0.390,
            home_leadoff_obp=0.380,
            venue_yrfi_rate=0.54,
            park_run_factor=110,
        )
        result = predict_first_inning(ctx)
        self.assertGreater(result.yrfi_probability, 0.55)
        self.assertEqual(result.lean, "YRFI")

    def test_strong_pitchers_favor_nrfi(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.20,
            home_first_inning_scoring_rate=0.22,
            away_first_inning_allowed_rate=0.20,
            home_first_inning_allowed_rate=0.18,
            away_pitcher_first_inning_era=2.50,
            home_pitcher_first_inning_era=2.80,
            away_pitcher_first_inning_whip=1.00,
            home_pitcher_first_inning_whip=1.05,
            away_leadoff_obp=0.290,
            home_leadoff_obp=0.300,
            away_pitcher_first_pitch_strike_rate=0.70,
            home_pitcher_first_pitch_strike_rate=0.68,
            venue_yrfi_rate=0.38,
            park_run_factor=92,
        )
        result = predict_first_inning(ctx)
        self.assertGreater(result.nrfi_probability, 0.55)
        self.assertEqual(result.lean, "NRFI")

    def test_probabilities_sum_to_one(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.30,
            home_first_inning_scoring_rate=0.25,
            away_pitcher_first_inning_era=4.00,
            home_pitcher_first_inning_era=3.80,
        )
        result = predict_first_inning(ctx)
        self.assertAlmostEqual(result.yrfi_probability + result.nrfi_probability, 1.0, places=4)

    def test_half_inning_probabilities_bounded(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.50,
            home_first_inning_scoring_rate=0.50,
            away_pitcher_first_inning_era=9.00,
            home_pitcher_first_inning_era=9.00,
            away_leadoff_obp=0.450,
            home_leadoff_obp=0.450,
        )
        result = predict_first_inning(ctx)
        self.assertLessEqual(result.top_first_run_probability, 0.55)
        self.assertLessEqual(result.bottom_first_run_probability, 0.55)
        self.assertGreaterEqual(result.top_first_run_probability, 0.08)

    def test_confidence_high_for_strong_lean(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.40,
            home_first_inning_scoring_rate=0.38,
            away_pitcher_first_inning_era=6.50,
            home_pitcher_first_inning_era=6.00,
            away_leadoff_obp=0.400,
            home_leadoff_obp=0.395,
            venue_yrfi_rate=0.58,
            park_run_factor=112,
        )
        result = predict_first_inning(ctx)
        self.assertEqual(result.confidence, "High")

    def test_confidence_low_for_close_game(self) -> None:
        ctx = FirstInningContext()
        result = predict_first_inning(ctx)
        self.assertIn(result.confidence, ("Low", "Medium"))

    def test_no_lean_when_close(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.27,
            home_first_inning_scoring_rate=0.27,
            venue_yrfi_rate=0.46,
        )
        result = predict_first_inning(ctx)
        self.assertEqual(result.lean, "NO BET")

    def test_main_factors_populated(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.35,
            home_pitcher_first_inning_era=6.00,
            away_leadoff_obp=0.400,
            venue_yrfi_rate=0.55,
        )
        result = predict_first_inning(ctx)
        self.assertGreater(len(result.main_factors), 0)
        self.assertLessEqual(len(result.main_factors), 4)

    def test_yrfi_probability_clamped(self) -> None:
        ctx = FirstInningContext(
            away_first_inning_scoring_rate=0.60,
            home_first_inning_scoring_rate=0.60,
            away_pitcher_first_inning_era=10.0,
            home_pitcher_first_inning_era=10.0,
            venue_yrfi_rate=0.80,
            park_run_factor=120,
        )
        result = predict_first_inning(ctx)
        self.assertLessEqual(result.yrfi_probability, 0.75)
        self.assertGreaterEqual(result.nrfi_probability, 0.25)


if __name__ == "__main__":
    unittest.main()
