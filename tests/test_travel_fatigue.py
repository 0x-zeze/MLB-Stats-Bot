"""Tests for travel fatigue adjustments."""

import unittest

from src.travel_fatigue import (
    TravelContext,
    build_travel_context,
    compute_zones_crossed,
    day_after_night_penalty,
    travel_fatigue_adjustment,
)


class TestComputeZonesCrossed(unittest.TestCase):
    def test_same_timezone(self) -> None:
        zones, direction = compute_zones_crossed("ET", "ET")
        self.assertEqual(zones, 0)
        self.assertEqual(direction, "same")

    def test_west_to_east(self) -> None:
        zones, direction = compute_zones_crossed("PT", "ET")
        self.assertEqual(zones, 3)
        self.assertEqual(direction, "east")

    def test_east_to_west(self) -> None:
        zones, direction = compute_zones_crossed("ET", "PT")
        self.assertEqual(zones, 3)
        self.assertEqual(direction, "west")

    def test_one_zone(self) -> None:
        zones, direction = compute_zones_crossed("CT", "ET")
        self.assertEqual(zones, 1)
        self.assertEqual(direction, "east")


class TestTravelFatigueAdjustment(unittest.TestCase):
    def test_none_returns_zero(self) -> None:
        self.assertEqual(travel_fatigue_adjustment(None), 0.0)

    def test_no_travel(self) -> None:
        ctx = TravelContext(origin_timezone="ET", destination_timezone="ET", zones_crossed=0, direction="same")
        self.assertEqual(travel_fatigue_adjustment(ctx), 0.0)

    def test_cross_country_east(self) -> None:
        ctx = TravelContext(
            origin_timezone="PT",
            destination_timezone="ET",
            zones_crossed=3,
            direction="east",
        )
        result = travel_fatigue_adjustment(ctx)
        self.assertLess(result, -0.20)

    def test_cross_country_west(self) -> None:
        ctx = TravelContext(
            origin_timezone="ET",
            destination_timezone="PT",
            zones_crossed=3,
            direction="west",
        )
        result = travel_fatigue_adjustment(ctx)
        self.assertLess(result, 0.0)
        # West travel is less penalizing than east
        east_ctx = TravelContext(
            origin_timezone="PT",
            destination_timezone="ET",
            zones_crossed=3,
            direction="east",
        )
        self.assertGreater(result, travel_fatigue_adjustment(east_ctx))

    def test_day_after_night(self) -> None:
        ctx = TravelContext(
            origin_timezone="ET",
            destination_timezone="ET",
            zones_crossed=0,
            direction="same",
            day_game_after_night=True,
        )
        result = travel_fatigue_adjustment(ctx)
        self.assertLess(result, 0.0)

    def test_long_road_trip(self) -> None:
        ctx = TravelContext(
            origin_timezone="ET",
            destination_timezone="ET",
            zones_crossed=0,
            direction="same",
            consecutive_road_days=10,
        )
        result = travel_fatigue_adjustment(ctx)
        self.assertLess(result, 0.0)

    def test_clamped(self) -> None:
        ctx = TravelContext(
            origin_timezone="PT",
            destination_timezone="ET",
            zones_crossed=3,
            direction="east",
            day_game_after_night=True,
            consecutive_road_days=12,
        )
        result = travel_fatigue_adjustment(ctx)
        self.assertGreaterEqual(result, -0.40)


class TestDayAfterNightPenalty(unittest.TestCase):
    def test_not_day_game(self) -> None:
        self.assertEqual(day_after_night_penalty(False, True), 0.0)

    def test_not_after_night(self) -> None:
        self.assertEqual(day_after_night_penalty(True, False), 0.0)

    def test_day_after_night(self) -> None:
        result = day_after_night_penalty(True, True)
        self.assertAlmostEqual(result, -0.15)

    def test_late_finish(self) -> None:
        result = day_after_night_penalty(True, True, previous_game_ended_late=True)
        self.assertAlmostEqual(result, -0.23)


class TestBuildTravelContext(unittest.TestCase):
    def test_same_timezone(self) -> None:
        ctx = build_travel_context("NYY", "ET")
        self.assertEqual(ctx.zones_crossed, 0)
        self.assertEqual(ctx.direction, "same")

    def test_cross_country(self) -> None:
        ctx = build_travel_context("NYY", "PT")
        self.assertEqual(ctx.zones_crossed, 3)
        self.assertEqual(ctx.direction, "west")

    def test_with_schedule_data(self) -> None:
        ctx = build_travel_context("LAD", "ET", {"day_game_after_night": True, "consecutive_road_days": 5})
        self.assertTrue(ctx.day_game_after_night)
        self.assertEqual(ctx.consecutive_road_days, 5)


if __name__ == "__main__":
    unittest.main()
