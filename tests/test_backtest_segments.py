"""Tests for backtest segments and automation."""

import unittest

from src.backtest_segments import (
    filter_by_segment,
    segment_summary,
    tag_game_segments,
)


class TestTagGameSegments(unittest.TestCase):
    def test_home_pick(self) -> None:
        game = {"predicted_winner": "NYY", "home_team": "NYY", "away_team": "BOS", "win_probability": 0.62}
        tags = tag_game_segments(game)
        self.assertEqual(tags["venue"], "home")
        self.assertEqual(tags["role"], "favorite")

    def test_away_pick(self) -> None:
        game = {"predicted_winner": "BOS", "home_team": "NYY", "away_team": "BOS", "win_probability": 0.45}
        tags = tag_game_segments(game)
        self.assertEqual(tags["venue"], "away")
        self.assertEqual(tags["role"], "underdog")

    def test_division_tagging(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["division"], "AL_East")

    def test_total_range_low(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "market_total": 7.0, "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["total_range"], "low_6_7")

    def test_total_range_mid(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "market_total": 8.5, "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["total_range"], "mid_8_9")

    def test_total_range_high(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "market_total": 10.5, "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["total_range"], "high_10_plus")

    def test_confidence_tagging(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "confidence": "High", "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["confidence"], "high")

    def test_edge_size_large(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "model_edge": 0.08, "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["edge_size"], "large_7_plus")

    def test_edge_size_small(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "model_edge": 0.03, "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["edge_size"], "small_2_4")

    def test_day_game(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "game_time": "2024-06-01T14:00:00", "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["time"], "day")

    def test_night_game(self) -> None:
        game = {"home_team": "NYY", "away_team": "BOS", "game_time": "2024-06-01T19:00:00", "predicted_winner": "NYY"}
        tags = tag_game_segments(game)
        self.assertEqual(tags["time"], "night")


class TestFilterBySegment(unittest.TestCase):
    def test_filter(self) -> None:
        results = [
            {"segments": {"venue": "home"}, "result": "win"},
            {"segments": {"venue": "away"}, "result": "loss"},
            {"segments": {"venue": "home"}, "result": "loss"},
        ]
        filtered = filter_by_segment(results, "venue", "home")
        self.assertEqual(len(filtered), 2)

    def test_no_match(self) -> None:
        results = [{"segments": {"venue": "home"}}]
        filtered = filter_by_segment(results, "venue", "away")
        self.assertEqual(len(filtered), 0)


class TestSegmentSummary(unittest.TestCase):
    def test_summary(self) -> None:
        results = [
            {"segments": {"venue": "home"}, "result": "win", "profit_loss": 0.9},
            {"segments": {"venue": "home"}, "result": "loss", "profit_loss": -1.0},
            {"segments": {"venue": "away"}, "result": "win", "profit_loss": 1.2},
        ]
        summary = segment_summary(results, "venue")
        self.assertIn("home", summary)
        self.assertEqual(summary["home"]["games"], 2)
        self.assertEqual(summary["home"]["wins"], 1)
        self.assertIn("away", summary)
        self.assertEqual(summary["away"]["wins"], 1)

    def test_empty_results(self) -> None:
        summary = segment_summary([], "venue")
        self.assertEqual(summary, {})


if __name__ == "__main__":
    unittest.main()
