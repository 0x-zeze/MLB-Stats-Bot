import unittest
from datetime import datetime, timedelta, timezone

from src.data_freshness import check_data_freshness


class DataFreshnessTests(unittest.TestCase):
    def test_missing_timestamp(self) -> None:
        self.assertEqual(check_data_freshness(None, 15), "missing")
        self.assertEqual(check_data_freshness("", 15), "missing")

    def test_fresh_timestamp(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        timestamp = now - timedelta(minutes=10)
        self.assertEqual(check_data_freshness(timestamp, 15, now=now), "fresh")

    def test_stale_timestamp(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        timestamp = (now - timedelta(minutes=30)).isoformat()
        self.assertEqual(check_data_freshness(timestamp, 15, now=now), "stale")

    def test_iso_z_timestamp(self) -> None:
        now = datetime(2026, 4, 28, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(check_data_freshness("2026-04-28T11:55:00Z", 15, now=now), "fresh")


if __name__ == "__main__":
    unittest.main()
