import unittest

from src.data_collection import collect_game_data
from src.feature_engineering_layer import build_moneyline_features


class FeatureEngineeringOpenerTests(unittest.TestCase):
    def test_opener_situation_neutralizes_starting_pitcher_component(self) -> None:
        collected = collect_game_data(0)
        collected["context"]["probable_pitchers"]["home"].update(
            {
                "game_note": "Tampa Bay Rays-style opener/bulk plan expected.",
                "gamesStarted": 2,
                "gamesPitched": 40,
            }
        )
        collected["context"]["probable_pitchers"]["away"].update(
            {
                "game_note": "Tampa Bay Rays-style opener/bulk plan expected.",
                "gamesStarted": 1,
                "gamesPitched": 35,
            }
        )

        features = build_moneyline_features(collected)

        self.assertTrue(features["opener_flag"])
        self.assertAlmostEqual(features["components"]["starting_pitcher"], 0.0)
        self.assertIn("SP role unclear", " ".join(features["notes"]))
        self.assertTrue(collected["context"]["opener_situation"]["home"]["is_opener"])
        self.assertTrue(collected["context"]["opener_situation"]["away"]["is_opener"])


if __name__ == "__main__":
    unittest.main()
