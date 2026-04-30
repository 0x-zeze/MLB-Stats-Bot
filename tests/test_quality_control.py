import unittest
from datetime import datetime, timedelta, timezone

from src.quality_control import (
    apply_confidence_downgrade,
    calculate_data_quality_score,
    check_prediction_inputs,
    generate_quality_report,
)


def _fresh_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_timestamp() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()


def _context() -> dict:
    timestamp = _fresh_timestamp()
    return {
        "probable_pitchers": {
            "home": {"pitcher": "Home Ace", "confirmed": True},
            "away": {"pitcher": "Away Ace", "confirmed": True},
        },
        "lineup": {
            "home": {"team": "Home", "confirmed": True},
            "away": {"team": "Away", "confirmed": True},
        },
        "weather": {"available": True, "data_timestamp": timestamp, "roof": "open"},
        "market": {
            "available": True,
            "home_moneyline": "-120",
            "away_moneyline": "+110",
            "market_total": 8.5,
            "opening_total": 8.0,
            "current_total": 8.5,
            "over_odds": "-110",
            "under_odds": "-110",
            "data_timestamp": timestamp,
        },
        "bullpen": {
            "home": {"available": True},
            "away": {"available": True},
        },
        "park": {"available": True, "park": "Sample Park"},
        "injury_news": {"available": True},
        "calibration": {"supports_high_confidence": True},
    }


def _prediction(**overrides) -> dict:
    payload = {
        "confidence": "High",
        "model_edge": 0.05,
        "final_lean": "Home Team",
        "market_type": "moneyline",
    }
    payload.update(overrides)
    return payload


class QualityControlTests(unittest.TestCase):
    def test_good_quality_score(self) -> None:
        context = _context()
        checks = check_prediction_inputs(context)
        self.assertEqual(checks["probable_pitchers"], "Confirmed")
        self.assertEqual(calculate_data_quality_score(context), 100)

    def test_high_confidence_opener_reduces_quality_score(self) -> None:
        context = _context()
        context["opener_situation"] = {
            "away": {"is_opener": True, "pitcher_role": "opener", "confidence": "high"},
            "home": {"is_opener": False, "pitcher_role": "starter", "confidence": "low"},
        }

        report = generate_quality_report(context)

        self.assertEqual(report["score"], 90)
        self.assertEqual(report["opener_situation"], "high")
        self.assertIn("opener_situation", report["no_bet_considerations"])

    def test_medium_confidence_opener_reduces_quality_score(self) -> None:
        context = _context()
        context["opener_situation"] = {
            "away": {"is_opener": True, "pitcher_role": "opener", "confidence": "medium"},
        }

        report = generate_quality_report(context)

        self.assertEqual(report["score"], 95)
        self.assertEqual(report["opener_situation"], "medium")

    def test_missing_probable_pitcher_returns_no_bet(self) -> None:
        context = _context()
        context["probable_pitchers"]["away"] = None
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("probable pitcher missing", result["decision_reason"])

    def test_stale_odds_downgrades_confidence(self) -> None:
        context = _context()
        context["market"]["data_timestamp"] = _stale_timestamp()
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["confidence"], "Medium")
        self.assertIn("odds stale", result["confidence_adjustments"][0])

    def test_missing_lineup_caps_confidence_at_medium(self) -> None:
        context = _context()
        context["lineup"]["home"] = None
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["confidence"], "Medium")

    def test_low_edge_returns_no_bet(self) -> None:
        result = apply_confidence_downgrade(_prediction(model_edge=0.01), generate_quality_report(_context()))
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("model edge below 2%", result["decision_reason"])

    def test_low_data_quality_score_returns_no_bet(self) -> None:
        context = _context()
        context["weather"] = {"available": False}
        context["market"] = {"available": False}
        context["bullpen"] = {"home": {"available": False}, "away": {"available": False}}
        report = generate_quality_report(context)
        self.assertLess(report["score"], 60)
        result = apply_confidence_downgrade(_prediction(), report)
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("data quality score below 60", result["decision_reason"])

    def test_good_quality_data_allows_normal_prediction(self) -> None:
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(_context()))
        self.assertEqual(result["decision"], "BET")
        self.assertEqual(result["confidence"], "High")
        self.assertFalse(result["no_bet"])

    def test_totals_small_market_difference_returns_no_bet(self) -> None:
        prediction = _prediction(
            market_type="totals",
            projected_total_runs=8.7,
            market_total=8.5,
            final_lean="Over 8.5",
        )
        result = apply_confidence_downgrade(prediction, generate_quality_report(_context()))
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("projected total difference below 0.4 runs", result["decision_reason"])


if __name__ == "__main__":
    unittest.main()
