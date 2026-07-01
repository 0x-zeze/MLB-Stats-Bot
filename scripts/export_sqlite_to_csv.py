#!/usr/bin/env python3
"""Export live SQLite picks into evaluator-compatible CSV."""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.evaluate import build_prediction_log_rows_from_sqlite, prediction_log_fieldnames, settled_rows
from src.utils import data_path


def _count_ledger(sqlite_path: Path) -> dict[str, int]:
    counts = {"open": 0, "settled": 0, "push": 0}
    if not sqlite_path.exists():
        return counts
    try:
        conn = sqlite3.connect(str(sqlite_path))
        conn.row_factory = sqlite3.Row
        try:
            for row in conn.execute("SELECT status, result, COUNT(*) AS count FROM bet_ledger GROUP BY status, result"):
                status = str(row["status"] or "").lower()
                result = str(row["result"] or "").lower()
                count = int(row["count"] or 0)
                if status == "open":
                    counts["open"] += count
                if status == "settled":
                    counts["settled"] += count
                if result == "push":
                    counts["push"] += count
        finally:
            conn.close()
    except sqlite3.Error:
        return counts
    return counts


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = prediction_log_fieldnames()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export live state.sqlite predictions for src.evaluate.")
    parser.add_argument("--sqlite", default=str(data_path("state.sqlite")), help="SQLite state database")
    parser.add_argument("--output", default=str(data_path("predictions_log_live.csv")), help="Output CSV path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sqlite_path = Path(args.sqlite)
    output_path = Path(args.output)
    rows = build_prediction_log_rows_from_sqlite(sqlite_path)
    _write_csv(output_path, rows)

    ledger_counts = _count_ledger(sqlite_path)
    settled = settled_rows(rows)
    yrfi_rows = [row for row in rows if str(row.get("market_type") or "").lower() == "yrfi"]
    moneyline_rows = [row for row in rows if str(row.get("market_type") or "").lower() != "yrfi"]

    print(f"SQLite source: {sqlite_path}")
    print(f"CSV output: {output_path}")
    print(f"Rows exported: {len(rows)}")
    print(f"Moneyline rows: {len(moneyline_rows)}")
    print(f"YRFI rows: {len(yrfi_rows)}")
    print(f"Settled rows exported: {len(settled)}")
    print(f"Open ledger bets: {ledger_counts['open']}")
    print(f"Settled ledger bets: {ledger_counts['settled']}")
    print(f"Skipped pushes: {ledger_counts['push']}")


if __name__ == "__main__":
    main()
