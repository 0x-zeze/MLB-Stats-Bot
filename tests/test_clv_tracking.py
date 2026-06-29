import unittest

from src.evolution.evolution_engine import _closing_odds_from_snapshots
from src.evolution.prediction_evaluator import _clv, evaluate_prediction


def moneyline_trajectory(**overrides):
    trajectory = {
        "game_id": "2026-05-04-SEA-LAA",
        "date": "2026-05-04",
        "market": "moneyline",
        "matchup": "Seattle Mariners @ Los Angeles Angels",
        "home_team": "Los Angeles Angels",
        "away_team": "Seattle Mariners",
        "prediction": {
            "final_lean": "Seattle Mariners",
            "confidence": "Medium",
            # Opening odds for the pick (away) at +120 -> implied 45.45%
            "market_odds": {"awayMoneyline": "+120", "homeMoneyline": "-140"},
            "model_edge": 3.0,
        },
    }
    trajectory.update(overrides)
    return trajectory


class ClvTrackingTests(unittest.TestCase):
    def test_clv_positive_when_closing_shorter_than_opening(self):
        # Pick (away) opened +120 (45.45%) and closed -110 (52.38%).
        # We beat the close: positive CLV ~ +6.9 points.
        trajectory = moneyline_trajectory()
        final = {
            "home_score": 5,
            "away_score": 4,
            "closing_away_moneyline": "-110",
            "closing_home_moneyline": "-110",
        }
        clv = _clv(trajectory, final, "Seattle Mariners")
        self.assertIsNotNone(clv)
        self.assertGreater(clv, 6.0)
        self.assertLess(clv, 8.0)

    def test_clv_is_none_without_closing_odds(self):
        trajectory = moneyline_trajectory()
        final = {"home_score": 5, "away_score": 4}
        self.assertIsNone(_clv(trajectory, final, "Seattle Mariners"))

    def test_evaluate_prediction_threads_clv(self):
        trajectory = moneyline_trajectory()
        final = {
            "home_score": 4,
            "away_score": 5,
            "closing_away_moneyline": "-105",
        }
        evaluation = evaluate_prediction(trajectory, final)
        self.assertEqual(evaluation["result"], "win")
        self.assertIsNotNone(evaluation["clv"])

    def test_snapshot_mapping_prefers_dedicated_closing(self):
        snapshots = {
            "closing_home": -150.0,
            "moneyline_home": -120.0,
            "closing_away": 130.0,
            "moneyline_away": 110.0,
        }
        mapped = _closing_odds_from_snapshots(snapshots)
        self.assertEqual(mapped["closing_home_moneyline"], -150.0)
        self.assertEqual(mapped["closing_away_moneyline"], 130.0)

    def test_snapshot_mapping_falls_back_to_live_lines(self):
        # No dedicated closing_* captured; use last-seen live monitor snapshot.
        snapshots = {"moneyline_home": -120.0, "moneyline_away": 110.0}
        mapped = _closing_odds_from_snapshots(snapshots)
        self.assertEqual(mapped["closing_home_moneyline"], -120.0)
        self.assertEqual(mapped["closing_away_moneyline"], 110.0)

    def test_snapshot_mapping_empty_returns_empty(self):
        self.assertEqual(_closing_odds_from_snapshots({}), {})

    def test_snapshot_mapping_rejects_in_game_garbage(self):
        # Stale/in-game prices (-20000, +3300) and an inflated total must be
        # dropped so CLV stays null rather than being corrupted.
        snapshots = {"moneyline_home": 3300.0, "moneyline_away": -20000.0}
        self.assertEqual(_closing_odds_from_snapshots(snapshots), {})

    def test_snapshot_mapping_rejects_dead_zone_moneyline(self):
        # American odds inside (-100, 100) are impossible pre-game.
        snapshots = {"moneyline_home": 50.0, "moneyline_away": -80.0}
        mapped = _closing_odds_from_snapshots(snapshots)
        self.assertNotIn("closing_home_moneyline", mapped)
        self.assertNotIn("closing_away_moneyline", mapped)
        self.assertEqual(mapped, {})


if __name__ == "__main__":
    unittest.main()
