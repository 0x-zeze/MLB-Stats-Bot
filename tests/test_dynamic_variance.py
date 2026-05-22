"""Tests for dynamic variance calculation."""

import unittest

from src.dynamic_variance import (
    VarianceContext,
    blowout_correlation_adjustment,
    compute_dynamic_variance,
    monte_carlo_total_probability,
)


class TestComputeDynamicVariance(unittest.TestCase):
    def test_default_context(self) -> None:
        ctx = VarianceContext(projected_total=8.8)
        result = compute_dynamic_variance(ctx)
        self.assertGreater(result, 8.8)
        self.assertLess(result, 8.8 * 2.0)

    def test_high_bullpen_fatigue_increases_variance(self) -> None:
        base = compute_dynamic_variance(VarianceContext(projected_total=9.0))
        fatigued = compute_dynamic_variance(VarianceContext(
            projected_total=9.0,
            home_bullpen_fatigue=0.8,
            away_bullpen_fatigue=0.6,
        ))
        self.assertGreater(fatigued, base)

    def test_high_park_volatility_increases_variance(self) -> None:
        base = compute_dynamic_variance(VarianceContext(projected_total=9.0, park_volatility=1.0))
        volatile = compute_dynamic_variance(VarianceContext(projected_total=9.0, park_volatility=2.0))
        self.assertGreater(volatile, base)

    def test_weather_uncertainty_increases_variance(self) -> None:
        base = compute_dynamic_variance(VarianceContext(projected_total=9.0, weather_uncertainty=0.0))
        uncertain = compute_dynamic_variance(VarianceContext(projected_total=9.0, weather_uncertainty=0.8))
        self.assertGreater(uncertain, base)

    def test_inconsistent_pitchers_increase_variance(self) -> None:
        base = compute_dynamic_variance(VarianceContext(projected_total=9.0))
        inconsistent = compute_dynamic_variance(VarianceContext(
            projected_total=9.0,
            home_pitcher_era_stddev=1.5,
            away_pitcher_era_stddev=1.2,
        ))
        self.assertGreater(inconsistent, base)

    def test_clamped_lower_bound(self) -> None:
        ctx = VarianceContext(projected_total=7.0)
        result = compute_dynamic_variance(ctx)
        self.assertGreaterEqual(result, 7.0 * 1.05)

    def test_clamped_upper_bound(self) -> None:
        ctx = VarianceContext(
            projected_total=9.0,
            home_bullpen_fatigue=1.2,
            away_bullpen_fatigue=1.2,
            park_volatility=3.0,
            weather_uncertainty=1.0,
            home_pitcher_era_stddev=3.0,
            away_pitcher_era_stddev=3.0,
            win_probability_edge=0.30,
        )
        result = compute_dynamic_variance(ctx)
        self.assertLessEqual(result, 9.0 * 2.0)


class TestBlowoutCorrelationAdjustment(unittest.TestCase):
    def test_small_edge_no_adjustment(self) -> None:
        self.assertEqual(blowout_correlation_adjustment(9.0, 0.05), 0.0)

    def test_moderate_edge(self) -> None:
        result = blowout_correlation_adjustment(9.0, 0.15)
        self.assertGreater(result, 0.0)

    def test_large_edge(self) -> None:
        result = blowout_correlation_adjustment(9.0, 0.25)
        self.assertGreater(result, blowout_correlation_adjustment(9.0, 0.15))

    def test_clamped(self) -> None:
        result = blowout_correlation_adjustment(9.0, 0.90)
        self.assertLessEqual(result, 1.5)

    def test_negative_edge_uses_absolute(self) -> None:
        result = blowout_correlation_adjustment(9.0, -0.20)
        self.assertGreater(result, 0.0)


class TestMonteCarloTotalProbability(unittest.TestCase):
    def test_basic_over(self) -> None:
        prob = monte_carlo_total_probability(4.5, 4.5, 12.0, 8.5, "over", iterations=500, seed=42)
        self.assertGreater(prob, 0.3)
        self.assertLess(prob, 0.7)

    def test_basic_under(self) -> None:
        prob = monte_carlo_total_probability(4.5, 4.5, 12.0, 8.5, "under", iterations=500, seed=42)
        self.assertGreater(prob, 0.3)
        self.assertLess(prob, 0.7)

    def test_over_plus_under_equals_one(self) -> None:
        over = monte_carlo_total_probability(4.5, 4.0, 11.0, 8.5, "over", iterations=1000, seed=123)
        under = monte_carlo_total_probability(4.5, 4.0, 11.0, 8.5, "under", iterations=1000, seed=123)
        self.assertAlmostEqual(over + under, 1.0, places=5)

    def test_high_expected_favors_over(self) -> None:
        prob = monte_carlo_total_probability(6.0, 5.5, 15.0, 8.5, "over", iterations=500, seed=42)
        self.assertGreater(prob, 0.5)

    def test_low_expected_favors_under(self) -> None:
        prob = monte_carlo_total_probability(3.0, 3.0, 8.0, 8.5, "under", iterations=500, seed=42)
        self.assertGreater(prob, 0.5)

    def test_deterministic_with_seed(self) -> None:
        p1 = monte_carlo_total_probability(4.5, 4.5, 12.0, 8.5, "over", iterations=200, seed=99)
        p2 = monte_carlo_total_probability(4.5, 4.5, 12.0, 8.5, "over", iterations=200, seed=99)
        self.assertEqual(p1, p2)


if __name__ == "__main__":
    unittest.main()
