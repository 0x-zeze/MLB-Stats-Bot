"""Tests for time decay of evolution lessons."""

import unittest
from datetime import datetime, timedelta

from src.evolution.time_decay import (
    apply_time_decay_to_lessons,
    decay_lesson_weight,
    weighted_lesson_relevance,
)


class TestDecayLessonWeight(unittest.TestCase):
    def test_fresh_lesson_full_weight(self) -> None:
        now = datetime.now().isoformat()
        result = decay_lesson_weight(now, now)
        self.assertAlmostEqual(result, 1.0, places=2)

    def test_half_life_gives_half_weight(self) -> None:
        now = datetime.now()
        lesson_date = (now - timedelta(days=90)).isoformat()
        result = decay_lesson_weight(lesson_date, now.isoformat(), half_life_days=90)
        self.assertAlmostEqual(result, 0.5, places=1)

    def test_very_old_lesson_near_zero(self) -> None:
        now = datetime.now()
        lesson_date = (now - timedelta(days=365)).isoformat()
        result = decay_lesson_weight(lesson_date, now.isoformat(), half_life_days=90)
        self.assertLess(result, 0.1)

    def test_none_date_returns_default(self) -> None:
        result = decay_lesson_weight(None)
        self.assertEqual(result, 0.5)

    def test_minimum_weight(self) -> None:
        now = datetime.now()
        lesson_date = (now - timedelta(days=1000)).isoformat()
        result = decay_lesson_weight(lesson_date, now.isoformat())
        self.assertGreaterEqual(result, 0.01)

    def test_custom_half_life(self) -> None:
        now = datetime.now()
        lesson_date = (now - timedelta(days=30)).isoformat()
        result_short = decay_lesson_weight(lesson_date, now.isoformat(), half_life_days=30)
        result_long = decay_lesson_weight(lesson_date, now.isoformat(), half_life_days=180)
        self.assertLess(result_short, result_long)


class TestApplyTimeDecayToLessons(unittest.TestCase):
    def test_empty_lessons(self) -> None:
        result = apply_time_decay_to_lessons([])
        self.assertEqual(result, [])

    def test_adds_decay_weight(self) -> None:
        now = datetime.now()
        lessons = [
            {"date": now.isoformat(), "pattern": "overconfidence"},
            {"date": (now - timedelta(days=90)).isoformat(), "pattern": "weak_edge"},
        ]
        result = apply_time_decay_to_lessons(lessons, now.isoformat())
        self.assertEqual(len(result), 2)
        self.assertIn("decay_weight", result[0])
        self.assertGreater(result[0]["decay_weight"], result[1]["decay_weight"])

    def test_filters_below_min_weight(self) -> None:
        now = datetime.now()
        lessons = [
            {"date": (now - timedelta(days=1000)).isoformat(), "pattern": "old"},
        ]
        result = apply_time_decay_to_lessons(lessons, now.isoformat(), min_weight=0.1)
        self.assertEqual(len(result), 0)

    def test_no_date_gets_default_weight(self) -> None:
        lessons = [{"pattern": "no_date"}]
        result = apply_time_decay_to_lessons(lessons)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]["decay_weight"], 0.5)


class TestWeightedLessonRelevance(unittest.TestCase):
    def test_no_matching_lessons(self) -> None:
        lessons = [{"pattern": "other", "date": datetime.now().isoformat()}]
        result = weighted_lesson_relevance(lessons, "overconfidence")
        self.assertEqual(result, 0.0)

    def test_recent_lessons_high_relevance(self) -> None:
        now = datetime.now()
        lessons = [
            {"pattern": "overconfidence", "date": now.isoformat()},
            {"pattern": "overconfidence", "date": (now - timedelta(days=5)).isoformat()},
        ]
        result = weighted_lesson_relevance(lessons, "overconfidence", now.isoformat())
        self.assertGreater(result, 0.8)

    def test_old_lessons_low_relevance(self) -> None:
        now = datetime.now()
        lessons = [
            {"pattern": "overconfidence", "date": (now - timedelta(days=200)).isoformat()},
        ]
        result = weighted_lesson_relevance(lessons, "overconfidence", now.isoformat())
        self.assertLess(result, 0.3)


if __name__ == "__main__":
    unittest.main()
