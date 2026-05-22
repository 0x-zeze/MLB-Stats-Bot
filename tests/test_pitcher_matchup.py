"""Tests for enhanced pitcher matchup analysis."""

import unittest

from src.data_loader import PitcherStats
from src.pitcher_matchup import (
    PitcherMatchupContext,
    classify_lineup_handedness,
    enhanced_pitcher_score,
    pitch_count_trajectory_signal,
    pitch_mix_quality,
    platoon_adjustment,
    tto_penalty,
)


def _make_pitcher(**kwargs) -> PitcherStats:
    defaults = {"pitcher": "Test", "team": "TST", "era": 3.50, "whip": 1.15}
    defaults.update(kwargs)
    return PitcherStats(**defaults)


class TestPlatoonAdjustment(unittest.TestCase):
    def test_balanced_returns_zero(self) -> None:
        p = _make_pitcher()
        self.assertEqual(platoon_adjustment(p, "balanced"), 0.0)

    def test_no_split_data_returns_zero(self) -> None:
        p = _make_pitcher()
        self.assertEqual(platoon_adjustment(p, "lhh_heavy"), 0.0)

    def test_strong_vs_lhh(self) -> None:
        p = _make_pitcher(era_vs_lhh=2.80, whip_vs_lhh=1.00, woba_vs_lhh=0.270)
        result = platoon_adjustment(p, "lhh_heavy")
        self.assertGreater(result, 0.0)

    def test_weak_vs_rhh(self) -> None:
        p = _make_pitcher(era_vs_rhh=5.50, whip_vs_rhh=1.55, woba_vs_rhh=0.380)
        result = platoon_adjustment(p, "rhh_heavy")
        self.assertLess(result, 0.0)

    def test_clamped(self) -> None:
        p = _make_pitcher(era_vs_lhh=1.00, whip_vs_lhh=0.70, woba_vs_lhh=0.200)
        result = platoon_adjustment(p, "lhh_heavy")
        self.assertLessEqual(result, 0.25)
        self.assertGreaterEqual(result, -0.25)


class TestTtoPenalty(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(tto_penalty(None), 0.0)

    def test_average_tto(self) -> None:
        result = tto_penalty(0.340)
        self.assertAlmostEqual(result, 0.0, places=3)

    def test_high_tto_penalty(self) -> None:
        result = tto_penalty(0.400)
        self.assertLess(result, 0.0)

    def test_low_tto_bonus(self) -> None:
        result = tto_penalty(0.290)
        self.assertLessEqual(result, 0.0)

    def test_clamped(self) -> None:
        result = tto_penalty(0.500)
        self.assertGreaterEqual(result, -0.25)


class TestPitchCountTrajectorySignal(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(pitch_count_trajectory_signal(None), 0.0)

    def test_too_few_starts(self) -> None:
        self.assertEqual(pitch_count_trajectory_signal([90, 85]), 0.0)

    def test_trending_up(self) -> None:
        counts = [80, 82, 95, 98, 100]
        result = pitch_count_trajectory_signal(counts)
        self.assertGreater(result, 0.0)

    def test_trending_down(self) -> None:
        counts = [100, 98, 80, 75, 70]
        result = pitch_count_trajectory_signal(counts)
        self.assertLess(result, 0.0)

    def test_stable(self) -> None:
        counts = [90, 88, 91, 89, 90]
        result = pitch_count_trajectory_signal(counts)
        self.assertEqual(result, 0.0)


class TestPitchMixQuality(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(pitch_mix_quality(None, None), 0.0)

    def test_elite_stuff(self) -> None:
        result = pitch_mix_quality(0.35, 0.38)
        self.assertGreater(result, 0.0)

    def test_poor_stuff(self) -> None:
        result = pitch_mix_quality(0.15, 0.18)
        self.assertLess(result, 0.0)

    def test_partial_data(self) -> None:
        result = pitch_mix_quality(0.30, None)
        self.assertGreater(result, 0.0)

    def test_clamped(self) -> None:
        result = pitch_mix_quality(0.50, 0.50)
        self.assertLessEqual(result, 0.30)


class TestEnhancedPitcherScore(unittest.TestCase):
    def test_basic_pitcher(self) -> None:
        p = _make_pitcher()
        ctx = PitcherMatchupContext(pitcher=p)
        result = enhanced_pitcher_score(ctx)
        self.assertGreater(result, -1.0)
        self.assertLess(result, 1.0)

    def test_elite_pitcher_with_good_matchup(self) -> None:
        p = _make_pitcher(
            era=2.50, whip=0.95, fip=2.80, k_bb_ratio=4.5,
            era_vs_lhh=2.20, whip_vs_lhh=0.85, woba_vs_lhh=0.250,
            tto_woba=0.300, whiff_rate=0.35, chase_rate=0.35,
        )
        ctx = PitcherMatchupContext(
            pitcher=p,
            opponent_lineup_handedness="lhh_heavy",
            pitch_count_trend=[90, 92, 95, 98, 100],
        )
        result = enhanced_pitcher_score(ctx)
        self.assertGreater(result, 0.3)

    def test_struggling_pitcher_bad_matchup(self) -> None:
        p = _make_pitcher(
            era=5.50, whip=1.55, fip=5.20, k_bb_ratio=1.5,
            era_vs_rhh=6.00, whip_vs_rhh=1.70, woba_vs_rhh=0.400,
            tto_woba=0.420, whiff_rate=0.18, chase_rate=0.20,
        )
        ctx = PitcherMatchupContext(
            pitcher=p,
            opponent_lineup_handedness="rhh_heavy",
            pitch_count_trend=[95, 90, 80, 72, 65],
        )
        result = enhanced_pitcher_score(ctx)
        self.assertLess(result, -0.3)

    def test_clamped_range(self) -> None:
        p = _make_pitcher(era=1.00, whip=0.60, fip=1.50, k_bb_ratio=8.0)
        ctx = PitcherMatchupContext(
            pitcher=p,
            whiff_rate=0.50,
            chase_rate=0.50,
        )
        result = enhanced_pitcher_score(ctx)
        self.assertLessEqual(result, 1.0)
        self.assertGreaterEqual(result, -1.0)


class TestClassifyLineupHandedness(unittest.TestCase):
    def test_none_returns_balanced(self) -> None:
        self.assertEqual(classify_lineup_handedness(None), "balanced")

    def test_empty_returns_balanced(self) -> None:
        self.assertEqual(classify_lineup_handedness([]), "balanced")

    def test_lhh_heavy(self) -> None:
        batters = [{"bats": "L"}] * 6 + [{"bats": "R"}] * 3
        self.assertEqual(classify_lineup_handedness(batters), "lhh_heavy")

    def test_rhh_heavy(self) -> None:
        batters = [{"bats": "R"}] * 7 + [{"bats": "L"}] * 2
        self.assertEqual(classify_lineup_handedness(batters), "rhh_heavy")

    def test_balanced(self) -> None:
        batters = [{"bats": "L"}] * 4 + [{"bats": "R"}] * 5
        self.assertEqual(classify_lineup_handedness(batters), "balanced")

    def test_dict_format(self) -> None:
        data = {"batters": [{"bats": "L"}] * 6 + [{"bats": "R"}] * 3}
        self.assertEqual(classify_lineup_handedness(data), "lhh_heavy")


if __name__ == "__main__":
    unittest.main()
