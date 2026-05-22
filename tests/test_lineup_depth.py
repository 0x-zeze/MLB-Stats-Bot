"""Tests for lineup depth analysis."""

import unittest

from src.lineup_depth import (
    LineupDepthContext,
    batting_order_quality,
    catcher_impact_factor,
    enhanced_lineup_impact,
    top_of_order_concentration,
    war_replacement_penalty,
)


class TestWarReplacementPenalty(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(war_replacement_penalty(None), 0.0)

    def test_empty_returns_zero(self) -> None:
        self.assertEqual(war_replacement_penalty([]), 0.0)

    def test_single_star_missing(self) -> None:
        result = war_replacement_penalty([5.0])
        self.assertLess(result, 0.0)

    def test_multiple_missing(self) -> None:
        result = war_replacement_penalty([4.0, 3.0, 1.0])
        self.assertLess(result, war_replacement_penalty([4.0]))

    def test_replacement_level_player(self) -> None:
        result = war_replacement_penalty([0.0])
        self.assertEqual(result, 0.0)

    def test_clamped(self) -> None:
        result = war_replacement_penalty([8.0, 6.0, 5.0, 4.0])
        self.assertGreaterEqual(result, -0.45)


class TestBattingOrderQuality(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(batting_order_quality(None), 0.0)

    def test_too_few_slots(self) -> None:
        self.assertEqual(batting_order_quality([110, 120, 105]), 0.0)

    def test_average_lineup(self) -> None:
        order = [100.0] * 9
        result = batting_order_quality(order)
        self.assertAlmostEqual(result, 0.0, places=2)

    def test_elite_lineup(self) -> None:
        order = [140, 150, 145, 130, 120, 110, 105, 100, 95]
        result = batting_order_quality(order)
        self.assertGreater(result, 0.0)

    def test_weak_lineup(self) -> None:
        order = [80, 75, 85, 70, 65, 60, 55, 50, 45]
        result = batting_order_quality(order)
        self.assertLess(result, 0.0)

    def test_clamped(self) -> None:
        order = [200] * 9
        result = batting_order_quality(order)
        self.assertLessEqual(result, 1.0)


class TestCatcherImpactFactor(unittest.TestCase):
    def test_zero_framing(self) -> None:
        self.assertAlmostEqual(catcher_impact_factor(0.0), 0.0)

    def test_elite_framer(self) -> None:
        result = catcher_impact_factor(15.0)
        self.assertGreater(result, 0.0)
        self.assertLessEqual(result, 0.15)

    def test_poor_framer(self) -> None:
        result = catcher_impact_factor(-12.0)
        self.assertLess(result, 0.0)
        self.assertGreaterEqual(result, -0.12)


class TestTopOfOrderConcentration(unittest.TestCase):
    def test_none_returns_default(self) -> None:
        self.assertAlmostEqual(top_of_order_concentration(None), 0.5)

    def test_balanced_lineup(self) -> None:
        order = [110, 115, 112, 108, 105, 100, 98, 95, 90]
        result = top_of_order_concentration(order)
        self.assertGreater(result, 0.3)
        self.assertLess(result, 0.7)

    def test_top_heavy(self) -> None:
        order = [160, 155, 150, 80, 75, 70, 65, 60, 55]
        result = top_of_order_concentration(order)
        self.assertGreater(result, 0.7)


class TestEnhancedLineupImpact(unittest.TestCase):
    def test_default_context(self) -> None:
        ctx = LineupDepthContext()
        result = enhanced_lineup_impact(ctx)
        self.assertIn("impact_score", result)
        self.assertIn("total_adjustment", result)
        self.assertAlmostEqual(result["war_penalty"], 0.0)

    def test_strong_lineup(self) -> None:
        ctx = LineupDepthContext(
            batting_order_wrc_plus=[140, 135, 130, 120, 115, 110, 105, 100, 95],
            total_lineup_war=25.0,
            catcher_framing_runs=10.0,
        )
        result = enhanced_lineup_impact(ctx)
        self.assertGreater(result["impact_score"], 0.5)
        self.assertGreater(result["total_adjustment"], 0.0)

    def test_depleted_lineup(self) -> None:
        ctx = LineupDepthContext(
            batting_order_wrc_plus=[90, 85, 80, 75, 70, 65, 60, 55, 50],
            total_lineup_war=5.0,
            missing_player_wars=[5.0, 4.0, 3.0],
            catcher_framing_runs=-8.0,
        )
        result = enhanced_lineup_impact(ctx)
        self.assertLess(result["impact_score"], 0.5)
        self.assertLess(result["total_adjustment"], 0.0)

    def test_total_adjustment_clamped(self) -> None:
        ctx = LineupDepthContext(
            missing_player_wars=[8.0, 7.0, 6.0, 5.0],
            catcher_framing_runs=-15.0,
        )
        result = enhanced_lineup_impact(ctx)
        self.assertGreaterEqual(result["total_adjustment"], -0.60)
        self.assertLessEqual(result["total_adjustment"], 0.40)


if __name__ == "__main__":
    unittest.main()
