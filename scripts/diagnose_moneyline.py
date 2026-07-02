#!/usr/bin/env python3
"""Diagnose settled moneyline ledger ROI before/after safety gates."""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "data" / "state.sqlite"
GATE_SYMBOL = "MIN_TEAM_QUALITY_PCT"
GATE_FILE = "src/mlb.js"

ODDS_BUCKETS = [
    ("favorite <-150", lambda odds: odds < -150),
    ("-150 to -110", lambda odds: -150 <= odds < -110),
    ("-110 to +100", lambda odds: -110 <= odds <= 100),
    ("+100 to +150", lambda odds: 100 < odds <= 150),
    ("+150 to +200", lambda odds: 150 < odds <= 200),
    ("+200+", lambda odds: odds > 200),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Split settled moneyline bet_ledger ROI before/after MLB safety gates."
    )
    parser.add_argument(
        "--sqlite",
        default=os.environ.get("MLB_STORAGE_DB_PATH") or str(DEFAULT_DB),
        help="SQLite DB path (default: MLB_STORAGE_DB_PATH or data/state.sqlite)",
    )
    parser.add_argument(
        "--repo-root",
        default=str(REPO_ROOT),
        help="Repository root for git discovery (default: script parent)",
    )
    parser.add_argument(
        "--gate-date",
        default=None,
        help="Override gate split date as ISO timestamp if git discovery is unavailable",
    )
    return parser.parse_args()


def parse_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def format_datetime(dt: datetime | None) -> str:
    if dt is None:
        return "unknown"
    return dt.isoformat().replace("+00:00", "Z")


def run_git_log(repo_root: Path) -> str:
    command = [
        "git",
        "log",
        "--reverse",
        "--format=__COMMIT__%x09%H%x09%aI%x09%s",
        "-p",
        "--follow",
        "-S",
        GATE_SYMBOL,
        "--",
        GATE_FILE,
    ]
    try:
        return subprocess.check_output(
            command,
            cwd=repo_root,
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or str(exc)).strip()
        raise RuntimeError(f"git log failed: {message}") from exc


def discover_gate_commit(repo_root: Path) -> dict[str, object]:
    output = run_git_log(repo_root)
    for line in output.splitlines():
        if not line.startswith("__COMMIT__\t"):
            continue
        _, commit_hash, iso_date, subject = line.split("\t", 3)
        commit_date = parse_datetime(iso_date)
        if commit_date is None:
            raise RuntimeError(f"cannot parse git commit date: {iso_date}")
        return {
            "hash": commit_hash,
            "date": commit_date,
            "date_raw": iso_date,
            "subject": subject,
            "command": f'git log -p --follow -S "{GATE_SYMBOL}" {GATE_FILE}',
        }
    raise RuntimeError(f"no git commit found for {GATE_SYMBOL} in {GATE_FILE}")


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite DB not found: {db_path}")
    uri = f"file:{db_path.resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_bet_ledger(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bet_ledger'"
    ).fetchone()
    if row is None:
        raise RuntimeError("bet_ledger table not found")


def load_settled_moneyline_rows(db_path: Path) -> list[dict[str, object]]:
    conn = connect_readonly(db_path)
    try:
        ensure_bet_ledger(conn)
        rows = conn.execute(
            """
            SELECT
              game_pk,
              date_ymd,
              team,
              side,
              odds,
              model_prob,
              edge,
              units_staked,
              result,
              units_pl,
              recommended_at
            FROM bet_ledger
            WHERE market = 'moneyline'
              AND status = 'settled'
            ORDER BY recommended_at ASC, decision_id ASC
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def to_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def split_rows(rows: list[dict[str, object]], gate_date: datetime) -> dict[str, list[dict[str, object]]]:
    groups: dict[str, list[dict[str, object]]] = {
        "before": [],
        "after": [],
        "unknown": [],
    }
    for row in rows:
        recommended_at = parse_datetime(row.get("recommended_at"))
        row["_recommended_dt"] = recommended_at
        if recommended_at is None:
            groups["unknown"].append(row)
        elif recommended_at < gate_date:
            groups["before"].append(row)
        else:
            groups["after"].append(row)
    return groups


def metrics(rows: list[dict[str, object]]) -> dict[str, float | int]:
    wins = sum(1 for row in rows if str(row.get("result") or "").lower() == "win")
    losses = sum(1 for row in rows if str(row.get("result") or "").lower() == "loss")
    pushes = sum(1 for row in rows if str(row.get("result") or "").lower() == "push")
    graded = wins + losses
    units_staked = sum(to_float(row.get("units_staked")) or 0.0 for row in rows)
    units_pl = sum(to_float(row.get("units_pl")) or 0.0 for row in rows)
    return {
        "bets": len(rows),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "win_rate_pct": (wins / graded * 100.0) if graded else None,
        "units_staked": units_staked,
        "units_pl": units_pl,
        "roi_pct": (units_pl / units_staked * 100.0) if units_staked else None,
    }


def group_by_side(rows: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        side = str(row.get("side") or "unknown").lower()
        grouped[side].append(row)
    return dict(grouped)


def odds_bucket(odds_value: object) -> str:
    odds = to_float(odds_value)
    if odds is None:
        return "unknown"
    for label, predicate in ODDS_BUCKETS:
        if predicate(odds):
            return label
    return "unknown"


def group_by_odds_bucket(rows: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    grouped: dict[str, list[dict[str, object]]] = {label: [] for label, _ in ODDS_BUCKETS}
    grouped["unknown"] = []
    for row in rows:
        grouped[odds_bucket(row.get("odds"))].append(row)
    return grouped


def fmt_pct(value: object) -> str:
    if value is None:
        return "n/a"
    return f"{float(value):.1f}%"


def fmt_units(value: object) -> str:
    if value is None:
        return "n/a"
    return f"{float(value):.3f}"


def format_metrics(row_group: list[dict[str, object]]) -> str:
    m = metrics(row_group)
    record = f"{m['wins']}-{m['losses']}-{m['pushes']}"
    return (
        f"bets={m['bets']:>3}  W-L-P={record:>8}  "
        f"win%={fmt_pct(m['win_rate_pct']):>7}  "
        f"staked={fmt_units(m['units_staked']):>9}u  "
        f"P/L={fmt_units(m['units_pl']):>9}u  "
        f"ROI={fmt_pct(m['roi_pct']):>8}"
    )


def print_group_metrics(title: str, grouped: dict[str, list[dict[str, object]]], ordered_labels: list[str] | None = None) -> None:
    print(f"\n{title}")
    labels = ordered_labels or sorted(grouped)
    for label in labels:
        rows = grouped.get(label, [])
        print(f"  {label:<18} {format_metrics(rows)}")


def print_sample_rows(title: str, rows: list[dict[str, object]], limit: int = 12) -> None:
    print(f"\n{title}: {len(rows)}")
    for row in rows[:limit]:
        print(
            "  "
            f"{row.get('recommended_at') or 'unknown'}  "
            f"game={row.get('game_pk')}  "
            f"side={row.get('side') or 'unknown'}  "
            f"team={row.get('team') or 'unknown'}  "
            f"odds={row.get('odds')}  "
            f"model_prob={row.get('model_prob')}  "
            f"result={row.get('result')}  "
            f"P/L={row.get('units_pl')}"
        )
    if len(rows) > limit:
        print(f"  ... {len(rows) - limit} more")


def print_report(db_path: Path, gate: dict[str, object], rows: list[dict[str, object]]) -> None:
    gate_date = gate["date"]
    if not isinstance(gate_date, datetime):
        raise RuntimeError("gate date missing")
    split = split_rows(rows, gate_date)
    before = split["before"]
    after = split["after"]
    unknown = split["unknown"]

    print("Moneyline gate timeline diagnostic")
    print("===================================")
    print(f"SQLite source: {db_path}")
    print(f"Rows loaded: {len(rows)} settled moneyline bets")
    print(f"Gate search: {gate['command']}")
    print(f"Gate commit: {gate['hash']}")
    print(f"Gate date: {gate['date_raw']} ({format_datetime(gate_date)} UTC)")
    print(f"Gate subject: {gate['subject']}")

    print("\nTimeline split")
    print(f"  {'all settled':<18} {format_metrics(rows)}")
    print(f"  {'before gates':<18} {format_metrics(before)}")
    print(f"  {'after gates':<18} {format_metrics(after)}")
    print(f"  {'unknown timestamp':<18} {format_metrics(unknown)}")

    side_groups = group_by_side(after)
    side_order = ["home", "away", "unknown"]
    print_group_metrics("After gates — side distribution", side_groups, side_order)

    bucket_groups = group_by_odds_bucket(after)
    bucket_order = [label for label, _ in ODDS_BUCKETS] + ["unknown"]
    print_group_metrics("After gates — odds buckets", bucket_groups, bucket_order)

    away_over_limit = [
        row
        for row in after
        if str(row.get("side") or "").lower() == "away"
        and (to_float(row.get("odds")) is not None)
        and to_float(row.get("odds")) > 115
    ]
    low_conviction = [
        row
        for row in after
        if (to_float(row.get("model_prob")) is not None)
        and to_float(row.get("model_prob")) < 52
    ]
    missing_odds = [row for row in after if to_float(row.get("odds")) is None]
    missing_side = [row for row in after if not row.get("side")]

    print("\nAfter gates — sanity flags")
    print(f"  away odds > +115: {len(away_over_limit)}")
    print(f"  model_prob < 52:  {len(low_conviction)}")
    print(f"  missing odds:     {len(missing_odds)}")
    print(f"  missing side:     {len(missing_side)}")

    if unknown:
        print_sample_rows("Unknown timestamp rows", unknown)
    if away_over_limit:
        print_sample_rows("After-gate away odds > +115 rows", away_over_limit)
    if low_conviction:
        print_sample_rows("After-gate model_prob < 52 rows", low_conviction)


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    db_path = Path(args.sqlite).expanduser().resolve()

    try:
        if args.gate_date:
            gate_date = parse_datetime(args.gate_date)
            if gate_date is None:
                raise RuntimeError(f"cannot parse --gate-date: {args.gate_date}")
            gate = {
                "hash": "manual-override",
                "date": gate_date,
                "date_raw": args.gate_date,
                "subject": "manual gate date override",
                "command": f'git log -p --follow -S "{GATE_SYMBOL}" {GATE_FILE} (skipped)',
            }
        else:
            gate = discover_gate_commit(repo_root)
        rows = load_settled_moneyline_rows(db_path)
        print_report(db_path, gate, rows)
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI diagnostic should print clean failures.
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
