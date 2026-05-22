"""Tests for sharp money detection."""

import unittest

from src.sharp_money import (
    LineMovementSignal,
    detect_sharp_money_signal,
    sharp_money_confidence_adjustment,
    sharp_money_risk_factor,
)


class TestDetectSharpMoneySignal(unittest.TestCase):
    def test_no_odds_returns_default(self) -> None:
        result = detect_sharp_money_signal("NYY", 0.60, None, None)
        self.assertEqual(result.movement_direction, "neutral")
        self.assertIsNone(result.opening_line)

    def test_no_movement(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -150, "BOS": 130},
            closing_odds={"NYY": -150, "BOS": 130},
        )
        self.assertEqual(result.movement_direction, "neutral")
        self.assertAlmostEqual(result.movement_magnitude, 0.0)

    def test_movement_toward_model(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -140, "BOS": 120},
            closing_odds={"NYY": -160, "BOS": 140},
        )
        self.assertEqual(result.movement_direction, "toward_model")
        self.assertEqual(result.movement_magnitude, 20)

    def test_movement_against_model(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -160, "BOS": 140},
            closing_odds={"NYY": -140, "BOS": 120},
        )
        self.assertEqual(result.movement_direction, "against_model")
        self.assertEqual(result.movement_magnitude, 20)

    def test_steam_move_detected(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -150, "BOS": 130},
            closing_odds={"NYY": -125, "BOS": 105},
        )
        self.assertTrue(result.steam_move_detected)

    def test_reverse_line_movement(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -150, "BOS": 130},
            closing_odds={"NYY": -140, "BOS": 120},
            public_betting_pct={"NYY": 0.70, "BOS": 0.30},
        )
        self.assertTrue(result.reverse_line_movement)
        self.assertEqual(result.sharp_money_direction, "against_model")

    def test_no_rlm_when_public_agrees(self) -> None:
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -150, "BOS": 130},
            closing_odds={"NYY": -140, "BOS": 120},
            public_betting_pct={"NYY": 0.40, "BOS": 0.60},
        )
        self.assertFalse(result.reverse_line_movement)

    def test_multi_book_consensus(self) -> None:
        books = [
            {"opening": -150, "closing": -140},
            {"opening": -148, "closing": -138},
            {"opening": -152, "closing": -142},
        ]
        result = detect_sharp_money_signal(
            "NYY", 0.60,
            opening_odds={"NYY": -150, "BOS": 130},
            closing_odds={"NYY": -140, "BOS": 120},
            multi_book_lines=books,
        )
        self.assertGreater(result.multi_book_consensus, 0.5)


class TestSharpMoneyRiskFactor(unittest.TestCase):
    def test_neutral_returns_zero(self) -> None:
        signal = LineMovementSignal()
        self.assertEqual(sharp_money_risk_factor(signal), 0.0)

    def test_against_model_increases_risk(self) -> None:
        signal = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=15,
        )
        result = sharp_money_risk_factor(signal)
        self.assertGreater(result, 0.0)

    def test_rlm_adds_risk(self) -> None:
        base = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=10,
        )
        with_rlm = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=10,
            reverse_line_movement=True,
        )
        self.assertGreater(
            sharp_money_risk_factor(with_rlm),
            sharp_money_risk_factor(base),
        )

    def test_steam_against_adds_risk(self) -> None:
        signal = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=25,
            steam_move_detected=True,
        )
        result = sharp_money_risk_factor(signal)
        self.assertGreater(result, 0.4)

    def test_toward_model_reduces_risk(self) -> None:
        signal = LineMovementSignal(
            movement_direction="toward_model",
            movement_magnitude=15,
        )
        result = sharp_money_risk_factor(signal)
        self.assertEqual(result, 0.0)

    def test_clamped(self) -> None:
        signal = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=50,
            reverse_line_movement=True,
            steam_move_detected=True,
            multi_book_consensus=0.90,
        )
        result = sharp_money_risk_factor(signal)
        self.assertLessEqual(result, 1.0)
        self.assertGreaterEqual(result, 0.0)


class TestSharpMoneyConfidenceAdjustment(unittest.TestCase):
    def test_no_change(self) -> None:
        signal = LineMovementSignal()
        self.assertEqual(sharp_money_confidence_adjustment(signal), "no_change")

    def test_downgrade_one(self) -> None:
        signal = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=20,
            reverse_line_movement=True,
        )
        result = sharp_money_confidence_adjustment(signal)
        self.assertIn(result, ("downgrade_one", "downgrade_two"))

    def test_downgrade_two(self) -> None:
        signal = LineMovementSignal(
            movement_direction="against_model",
            movement_magnitude=30,
            reverse_line_movement=True,
            steam_move_detected=True,
            multi_book_consensus=0.90,
        )
        self.assertEqual(sharp_money_confidence_adjustment(signal), "downgrade_two")


if __name__ == "__main__":
    unittest.main()
