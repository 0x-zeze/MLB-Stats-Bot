"""Tests for new precision enhancement modules."""

import unittest

from src.elo_rating import (
    EloHistory,
    build_elo_from_schedule,
    elo_strength_adjustment,
    elo_to_win_probability,
    expected_probability,
    update_ratings,
)
from src.stuff_plus import (
    PitcherStuffProfile,
    PitchTypeStats,
    build_pitcher_stuff_profile,
    platoon_stuff_adjustment,
    stuff_plus_score,
)
from src.clv_tracking import (
    CLVRecord,
    clv_cents,
    clv_confidence_multiplier,
    clv_segment_report,
    should_downgrade_on_clv,
    should_upgrade_on_clv,
    summarize_clv,
)
from src.bayesian_shrinkage import (
    PitcherBayesianPrior,
    shrink_era,
    shrink_k_rate,
    shrink_pitcher_stats,
    shrink_umpire_adjustment,
    pitcher_variance_from_sample,
)
from src.market_efficiency import (
    LineSnapshot,
    MarketEfficiencyProfile,
    build_market_profile,
    market_signal_weight,
    movement_risk_factor,
)
from src.lineup_markov import (
    BatterProfile,
    build_batter_profile,
    lineup_order_efficiency,
    lineup_run_expectancy,
)
from src.walk_forward_backtest import (
    WalkForwardResult,
    generate_walk_forward_dates,
    run_walk_forward,
    walk_forward_summary,
)
from src.parlay_correlation import (
    adjust_stakes_for_correlation,
    aggregate_correlation_risk,
    detect_pick_correlation,
)
from src.pitcher_variance import (
    PitcherVarianceProfile,
    build_variance_profile,
    variance_profile_to_context,
    volatility_warning,
)
from src.live_game_markov import (
    LiveGameState,
    live_win_probability,
    parse_boxscore_state,
    run_expectancy,
)
from src.dynamic_variance import VarianceContext, compute_dynamic_variance
from src.rolling_expected_stats import (
    RollingExpectedStats,
    xstats_offense_adjustment,
    xstats_platoon_adjustment,
)
from src.weather import WeatherContext, weather_adjustment
from src.bullpen import BullpenUsage, bullpen_fatigue_adjustment
from src.travel_fatigue import TravelContext, travel_fatigue_adjustment
from src.risk_management import apply_risk_framework


class TestEloRating(unittest.TestCase):
    def test_expected_probability_bounds(self):
        prob = expected_probability(1500, 1500)
        self.assertAlmostEqual(prob, 0.531, places=1)  # home advantage shifts above 0.5
        prob_high = expected_probability(1600, 1400)
        self.assertGreater(prob_high, 0.6)

    def test_update_ratings_moves_winner_up(self):
        history = EloHistory()
        update_ratings("NYY", "BOS", 5, 2, history, game_date="2024-06-01")
        self.assertGreater(history.ratings["NYY"].rating, 1500)
        self.assertLess(history.ratings["BOS"].rating, 1500)

    def test_elo_to_win_probability_requires_min_games(self):
        history = EloHistory()
        update_ratings("NYY", "BOS", 5, 2, history)
        self.assertIsNone(elo_to_win_probability("NYY", "BOS", history))

    def test_build_elo_from_schedule(self):
        games = [
            {"home_team": "NYY", "away_team": "BOS", "home_score": 5, "away_score": 2, "date": "2024-06-01"},
            {"home_team": "BOS", "away_team": "NYY", "home_score": 3, "away_score": 1, "date": "2024-06-02"},
        ]
        history = build_elo_from_schedule(games)
        self.assertIn("NYY", history.ratings)
        self.assertIn("BOS", history.ratings)

    def test_elo_strength_adjustment(self):
        history = EloHistory()
        for _ in range(10):
            update_ratings("NYY", "BOS", 5, 2, history)
        adj = elo_strength_adjustment("NYY", "BOS", history)
        self.assertGreater(adj, 0)


class TestStuffPlus(unittest.TestCase):
    def test_stuff_plus_score_no_profile(self):
        self.assertEqual(stuff_plus_score(None), 0.0)

    def test_stuff_plus_score_small_sample(self):
        profile = PitcherStuffProfile(pitcher_id="p1", sample_pitches=20)
        self.assertEqual(stuff_plus_score(profile), 0.0)

    def test_stuff_plus_score_above_average(self):
        profile = PitcherStuffProfile(pitcher_id="p1", overall_stuff_plus=115, sample_pitches=200)
        score = stuff_plus_score(profile)
        self.assertGreater(score, 0)

    def test_platoon_stuff_adjustment(self):
        profile = PitcherStuffProfile(
            pitcher_id="p1",
            stuff_vs_lhh=110,
            stuff_vs_rhh=95,
            sample_pitches=200,
        )
        adj = platoon_stuff_adjustment(profile, "lhh_heavy")
        self.assertGreater(adj, 0)
        adj_rhh = platoon_stuff_adjustment(profile, "rhh_heavy")
        self.assertLess(adj_rhh, 0)

    def test_build_profile_from_rows(self):
        rows = [
            {"pitch_type": "FF", "stuff_plus": 110, "game_date": "2024-05-01", "stand": "R"},
            {"pitch_type": "FF", "stuff_plus": 105, "game_date": "2024-05-02", "stand": "L"},
            {"pitch_type": "SL", "stuff_plus": 120, "game_date": "2024-05-01", "stand": "R"},
        ]
        profile = build_pitcher_stuff_profile("p1", rows, as_of_date="2024-06-01", window_days=60)
        self.assertGreater(profile.overall_stuff_plus, 100)
        self.assertIn("FF", profile.pitch_types)


class TestCLVTracking(unittest.TestCase):
    def test_clv_cents_positive(self):
        # Bet at -130, closed at -150: we got a better number
        clv = clv_cents(-130, -150)
        self.assertGreater(clv, 0)

    def test_clv_cents_negative(self):
        clv = clv_cents(-150, -130)
        self.assertLess(clv, 0)

    def test_summarize_clv(self):
        records = [
            CLVRecord("d1", "moneyline", "NYY", -130, -150, 0.05, "high", "win"),
            CLVRecord("d2", "moneyline", "BOS", -120, -110, 0.04, "medium", "loss"),
            CLVRecord("d3", "moneyline", "LAD", -140, -160, 0.06, "high", "win"),
        ]
        summary = summarize_clv(records)
        self.assertEqual(summary.sample_size, 3)
        self.assertGreater(summary.avg_clv_cents, 0)

    def test_confidence_multiplier_strong_clv(self):
        summary = summarize_clv([
            CLVRecord(f"d{i}", "moneyline", "T", -130, -155, 0.05, "high", "win")
            for i in range(25)
        ])
        mult = clv_confidence_multiplier(summary)
        self.assertGreater(mult, 1.0)

    def test_should_downgrade_on_clv(self):
        records = [
            CLVRecord(f"d{i}", "moneyline", "T", -150, -130, 0.05, "high", "loss")
            for i in range(25)
        ]
        summary = summarize_clv(records)
        should, reason = should_downgrade_on_clv(summary)
        self.assertTrue(should)
        self.assertIn("negative CLV", reason)


class TestBayesianShrinkage(unittest.TestCase):
    def test_shrink_era_toward_prior_small_sample(self):
        # Observed ERA of 2.00 in 5 IP → should shrink toward 4.20
        shrunk = shrink_era(2.00, 5.0)
        self.assertGreater(shrunk, 2.00)
        self.assertLess(shrunk, 4.20)

    def test_shrink_era_large_sample(self):
        # 200 IP: minimal shrinkage toward 4.20
        shrunk = shrink_era(3.00, 200.0)
        # weight = 30/(30+200) = 0.13 → 0.13*4.20 + 0.87*3.00 = 3.156
        self.assertLess(abs(shrunk - 3.156), 0.5)

    def test_shrink_k_rate(self):
        shrunk = shrink_k_rate(0.35, 10.0)  # small sample, extreme value
        self.assertLess(shrunk, 0.35)
        self.assertGreater(shrunk, 0.22)

    def test_shrink_pitcher_stats(self):
        result = shrink_pitcher_stats(3.00, 1.10, 3.20, 0.30, 0.06, innings=20, batters_faced=80)
        self.assertGreater(result["era"], 3.00)
        self.assertLess(result["k_rate"], 0.30)
        self.assertGreater(result["bb_rate"], 0.06)

    def test_shrink_umpire_adjustment(self):
        k_adj, bb_adj = shrink_umpire_adjustment(0.05, -0.03, 5)
        self.assertLess(abs(k_adj), 0.05)
        self.assertLess(abs(bb_adj), 0.03)

    def test_pitcher_variance_from_sample(self):
        stddev = pitcher_variance_from_sample([3.0, 5.0, 2.0, 7.0, 4.0], 30)
        self.assertGreater(stddev, 0.5)
        self.assertLess(stddev, 3.0)


class TestMarketEfficiency(unittest.TestCase):
    def test_build_market_profile(self):
        snapshots = [
            LineSnapshot(odds=-140, hours_before_game=24),
            LineSnapshot(odds=-145, hours_before_game=12),
            LineSnapshot(odds=-150, hours_before_game=6),
            LineSnapshot(odds=-155, hours_before_game=1),
        ]
        profile = build_market_profile(snapshots)
        self.assertEqual(profile.opening_odds, -140)
        self.assertEqual(profile.closing_odds, -155)
        self.assertIn("early", profile.windows)
        self.assertIn("late", profile.windows)

    def test_sharp_confirmation(self):
        snapshots = [
            LineSnapshot(odds=-140, hours_before_game=24),
            LineSnapshot(odds=-145, hours_before_game=6),
            LineSnapshot(odds=-150, hours_before_game=0.5),
            LineSnapshot(odds=-155, hours_before_game=0.2),
        ]
        profile = build_market_profile(snapshots)
        self.assertTrue(profile.sharp_confirmation)

    def test_market_signal_weight(self):
        snapshots = [
            LineSnapshot(odds=-140, hours_before_game=24),
            LineSnapshot(odds=-145, hours_before_game=6),
            LineSnapshot(odds=-150, hours_before_game=0.5),
            LineSnapshot(odds=-155, hours_before_game=0.2),
        ]
        profile = build_market_profile(snapshots)
        weight = market_signal_weight(profile)
        self.assertGreater(weight, 0.3)

    def test_movement_risk_factor_against_pick(self):
        snapshots = [
            LineSnapshot(odds=-140, hours_before_game=24),
            LineSnapshot(odds=-130, hours_before_game=0.5),
            LineSnapshot(odds=-125, hours_before_game=0.2),
        ]
        profile = build_market_profile(snapshots)
        risk = movement_risk_factor(profile, model_pick_is_favorite=True)
        self.assertGreater(risk, 0)


class TestLineupMarkov(unittest.TestCase):
    def test_lineup_run_expectancy_basic(self):
        lineup = [build_batter_profile(f"Batter{i}") for i in range(9)]
        runs = lineup_run_expectancy(lineup)
        self.assertGreater(runs, 1.0)
        self.assertLess(runs, 15.0)

    def test_lineup_order_efficiency(self):
        lineup = [build_batter_profile(f"B{i}", {"obp": 0.35, "slg": 0.45}) for i in range(9)]
        efficiency = lineup_order_efficiency(lineup)
        self.assertGreater(efficiency, 0.0)
        self.assertLessEqual(efficiency, 1.0)

    def test_better_lineup_scores_more(self):
        good_lineup = [
            build_batter_profile(f"Star{i}", {"obp": 0.40, "slg": 0.50, "hr_rate": 0.05})
            for i in range(9)
        ]
        bad_lineup = [
            build_batter_profile(f"Weak{i}", {"obp": 0.28, "slg": 0.30, "hr_rate": 0.01})
            for i in range(9)
        ]
        good_runs = lineup_run_expectancy(good_lineup)
        bad_runs = lineup_run_expectancy(bad_lineup)
        self.assertGreater(good_runs, bad_runs)


class TestWalkForwardBacktest(unittest.TestCase):
    def test_generate_walk_forward_dates(self):
        folds = generate_walk_forward_dates("2024-04-01", "2024-10-01", step_days=30)
        self.assertGreater(len(folds), 0)
        self.assertEqual(folds[0][0], "2024-04-01")

    def test_run_walk_forward_empty(self):
        result = run_walk_forward([], lambda train, test: [])
        self.assertEqual(len(result.folds), 0)

    def test_walk_forward_summary(self):
        result = WalkForwardResult()
        summary = walk_forward_summary(result)
        self.assertEqual(summary["folds"], 0)


class TestParlayCorrelation(unittest.TestCase):
    def test_detect_same_game_correlation(self):
        pick_a = {"decision_id": "a", "game_pk": "12345"}
        pick_b = {"decision_id": "b", "game_pk": "12345"}
        corr = detect_pick_correlation(pick_a, pick_b)
        self.assertIsNotNone(corr)
        self.assertEqual(corr.correlation_type, "same_game")

    def test_detect_same_park_correlation(self):
        pick_a = {"decision_id": "a", "game_pk": "1", "home_team": "NYY"}
        pick_b = {"decision_id": "b", "game_pk": "2", "home_team": "NYY"}
        corr = detect_pick_correlation(pick_a, pick_b)
        self.assertIsNotNone(corr)
        self.assertEqual(corr.correlation_type, "same_park")

    def test_no_correlation(self):
        pick_a = {"decision_id": "a", "game_pk": "1", "home_team": "NYY", "division": "AL_East"}
        pick_b = {"decision_id": "b", "game_pk": "2", "home_team": "LAD", "division": "NL_West"}
        corr = detect_pick_correlation(pick_a, pick_b)
        self.assertIsNone(corr)

    def test_aggregate_correlation_risk(self):
        picks = [
            {"decision_id": "a", "game_pk": "1", "home_team": "NYY"},
            {"decision_id": "b", "game_pk": "1", "home_team": "NYY"},
        ]
        result = aggregate_correlation_risk(picks)
        self.assertLess(result["aggregate_stake_multiplier"], 1.0)

    def test_adjust_stakes(self):
        picks = [
            {"decision_id": "a", "game_pk": "1", "home_team": "NYY", "stake_units": 2.0},
            {"decision_id": "b", "game_pk": "1", "home_team": "NYY", "stake_units": 1.5},
        ]
        adjusted = adjust_stakes_for_correlation(picks)
        self.assertLess(adjusted[0]["adjusted_stake_units"], 2.0)


class TestPitcherVariance(unittest.TestCase):
    def test_build_variance_profile_small_sample(self):
        profile = build_variance_profile("p1", [])
        self.assertEqual(profile.start_count, 0)

    def test_build_variance_profile_from_logs(self):
        logs = [
            {"date": "2024-05-01", "era": 1.0, "whip": 0.8, "innings_pitched": 6.0},
            {"date": "2024-05-07", "era": 7.0, "whip": 2.0, "innings_pitched": 3.0},
            {"date": "2024-05-13", "era": 2.0, "whip": 1.0, "innings_pitched": 7.0},
            {"date": "2024-05-19", "era": 8.0, "whip": 2.2, "innings_pitched": 2.0},
            {"date": "2024-05-25", "era": 3.0, "whip": 1.2, "innings_pitched": 6.0},
            {"date": "2024-06-01", "era": 6.0, "whip": 1.8, "innings_pitched": 4.0},
        ]
        profile = build_variance_profile("p1", logs, as_of_date="2024-06-15")
        self.assertGreaterEqual(profile.start_count, 5)
        self.assertGreater(profile.era_stddev, 0)

    def test_volatility_warning(self):
        profile = PitcherVarianceProfile(pitcher_id="p1", era_stddev=3.0, start_count=10, volatility_label="high")
        warning = volatility_warning(profile)
        self.assertIn("High-variance", warning)


class TestLiveGameMarkov(unittest.TestCase):
    def test_run_expectancy_empty_bases(self):
        re = run_expectancy(False, False, False, 0)
        self.assertGreater(re, 0.3)
        self.assertLess(re, 0.6)

    def test_run_expectancy_loaded_bases(self):
        re = run_expectancy(True, True, True, 0)
        self.assertGreater(re, 2.0)

    def test_live_win_probability(self):
        state = LiveGameState(inning=5, is_top=True, home_score=3, away_score=1)
        prob = live_win_probability(state, pre_game_home_prob=0.55)
        self.assertGreater(prob, 0.5)
        self.assertLess(prob, 0.95)

    def test_parse_boxscore_state(self):
        state = parse_boxscore_state(7, True, 1, [True, False, True], 2, 4)
        self.assertEqual(state.inning, 7)
        self.assertTrue(state.first)
        self.assertTrue(state.third)
        self.assertFalse(state.second)


class TestEnhancedDynamicVariance(unittest.TestCase):
    def test_variance_with_pitcher_volatility(self):
        ctx = VarianceContext(
            projected_total=8.8,
            home_pitcher_era_stddev=2.0,
            away_pitcher_era_stddev=1.0,
            home_pitcher_volatility=1.2,
            away_pitcher_volatility=1.0,
        )
        variance = compute_dynamic_variance(ctx)
        self.assertGreater(variance, 8.8 * 1.05)

    def test_neutral_park_no_effect(self):
        ctx = VarianceContext(projected_total=8.8, park_volatility=1.0)
        variance = compute_dynamic_variance(ctx)
        # Neutral park should not inflate variance beyond base
        self.assertLess(variance, 8.8 * 1.5)


class TestEnhancedWeather(unittest.TestCase):
    def test_wind_out_boost(self):
        weather = WeatherContext(home_team="CHC", away_team="STL", wind_speed=15, wind_direction="out")
        adj = weather_adjustment(weather)
        self.assertGreater(adj, 0.3)

    def test_wind_in_suppresses(self):
        weather = WeatherContext(home_team="CHC", away_team="STL", wind_speed=15, wind_direction="in")
        adj = weather_adjustment(weather)
        self.assertLess(adj, -0.3)

    def test_dome_neutralizes(self):
        weather = WeatherContext(home_team="TOR", away_team="NYY", temperature=90, wind_speed=20, roof="dome")
        adj = weather_adjustment(weather)
        self.assertLess(abs(adj), 0.1)

    def test_hot_and_wind_out_interaction(self):
        weather = WeatherContext(
            home_team="TEX", away_team="HOU",
            temperature=95, wind_speed=15, wind_direction="out"
        )
        adj = weather_adjustment(weather)
        self.assertGreater(adj, 0.5)


class TestEnhancedBullpen(unittest.TestCase):
    def test_pitch_count_fatigue(self):
        bullpen = BullpenUsage(
            team="NYY",
            closer_pitch_count_yesterday=30,
            consecutive_appearances=3,
            rest_hours_last_appearance=12,
        )
        adj = bullpen_fatigue_adjustment(bullpen)
        self.assertGreater(adj, 0.10)

    def test_well_rested_bullpen(self):
        bullpen = BullpenUsage(team="NYY")
        adj = bullpen_fatigue_adjustment(bullpen)
        self.assertEqual(adj, 0.0)


class TestEnhancedTravelFatigue(unittest.TestCase):
    def test_coast_to_coast(self):
        ctx = TravelContext(
            zones_crossed=3,
            direction="east",
            miles_traveled_last_3_days=2500,
            coast_to_coast=True,
        )
        adj = travel_fatigue_adjustment(ctx)
        self.assertLess(adj, -0.25)

    def test_late_arrival(self):
        ctx = TravelContext(
            zones_crossed=1,
            arrival_hour_local=3,
        )
        adj = travel_fatigue_adjustment(ctx)
        self.assertLess(adj, -0.05)


class TestEnhancedRiskManagement(unittest.TestCase):
    def test_correlation_adjustment_reduces_stake(self):
        prediction = {
            "decision": "VALUE",
            "model_probability": 0.60,
            "american_odds": -130,
        }
        quality = {"score": 85}
        settings = {
            "stake_mode": "flat",
            "flat_stake_units": 2.0,
            "correlation_adjustment": True,
            "active_slate_picks": [
                {"decision_id": "x", "game_pk": "1", "home_team": "NYY"}
            ],
        }
        result = apply_risk_framework(prediction, quality, settings)
        self.assertIn("correlation_multiplier", result["risk_framework"])


class TestXStatsPlatoon(unittest.TestCase):
    def test_platoon_adjustment_vs_rhp(self):
        stats = RollingExpectedStats(
            xwoba_vs_rhp=0.350,
            barrel_rate_vs_rhp=0.12,
            sample_size=50,
        )
        adj = xstats_platoon_adjustment(stats, "RHP")
        self.assertGreater(adj, 0)

    def test_platoon_adjustment_vs_lhp(self):
        stats = RollingExpectedStats(
            xwoba_vs_lhp=0.280,
            barrel_rate_vs_lhp=0.05,
            sample_size=50,
        )
        adj = xstats_platoon_adjustment(stats, "LHP")
        self.assertLess(adj, 0)

    def test_xstats_offense_with_sweet_spot(self):
        stats = RollingExpectedStats(
            xwoba=0.340,
            xslg=0.450,
            barrel_rate=0.12,
            hard_hit_rate=0.45,
            avg_exit_velocity=91.0,
            sweet_spot_rate=0.20,
            avg_distance=220.0,
            sample_size=50,
        )
        adj = xstats_offense_adjustment(stats)
        self.assertGreater(adj, 0.1)


if __name__ == "__main__":
    unittest.main()
