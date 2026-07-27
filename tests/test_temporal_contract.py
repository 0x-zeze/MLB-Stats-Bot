"""Tests for UTC temporal contract and data freshness."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from src.data_freshness import check_data_freshness
from src.temporal_contract import (
    assert_pregame_eligible,
    filter_splits_before_date,
    parse_utc,
)


class TemporalContractTests(unittest.TestCase):
    def test_missing_timestamp(self) -> None:
        self.assertEqual(check_data_freshness(None, 15), "missing")
        self.assertEqual(check_data_freshness("", 15), "missing")

    def test_fresh_and_stale(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(
            check_data_freshness(now - timedelta(minutes=10), 15, now=now),
            "fresh",
        )
        self.assertEqual(
            check_data_freshness((now - timedelta(minutes=30)).isoformat(), 15, now=now),
            "stale",
        )

    def test_iso_z_timestamp(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(
            check_data_freshness("2026-04-28T11:55:00Z", 15, now=now),
            "fresh",
        )

    def test_future_timestamp_is_invalid_future(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(
            check_data_freshness("2026-04-28T13:00:00Z", 15, now=now),
            "invalid_future",
        )
        # Within clock skew still fresh
        self.assertEqual(
            check_data_freshness("2026-04-28T12:00:30Z", 15, now=now),
            "fresh",
        )

    def test_filter_splits_before_date(self) -> None:
        splits = [
            {"date": "2026-07-20"},
            {"date": "2026-07-27"},
            {"date": "2026-07-28"},
            {"date": "2026-07-10"},
        ]
        kept = filter_splits_before_date(splits, "2026-07-27")
        self.assertEqual([s["date"] for s in kept], ["2026-07-20", "2026-07-10"])
        self.assertEqual(filter_splits_before_date(splits, ""), [])

    def test_assert_pregame_eligible(self) -> None:
        ok = assert_pregame_eligible(
            observed_at="2026-07-27T16:00:00Z",
            as_of="2026-07-27T17:00:00Z",
            first_pitch="2026-07-27T18:00:00Z",
        )
        self.assertTrue(ok["ok"])
        bad = assert_pregame_eligible(
            observed_at="2026-07-27T17:30:00Z",
            as_of="2026-07-27T17:00:00Z",
            first_pitch="2026-07-27T18:00:00Z",
        )
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["reason"], "observed_at_after_as_of")

    def test_parse_utc_z(self) -> None:
        parsed = parse_utc("2026-07-27T12:00:00Z")
        assert parsed is not None
        self.assertEqual(parsed.tzinfo, timezone.utc)


if __name__ == "__main__":
    unittest.main()
