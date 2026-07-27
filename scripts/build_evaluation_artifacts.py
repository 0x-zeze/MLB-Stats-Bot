#!/usr/bin/env python3
"""Build reproducible, schema-stable evaluation artifacts from SQLite.

This builder is deliberately conservative:
- stake-weighted ROI only;
- missing metrics remain null;
- provenance/identity coverage is reported;
- mixed legacy rows are labelled partial/unaudited;
- output is atomic (temp file + replace).

It does not fit models or claim out-of-sample performance.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "state.sqlite"
DEFAULT_JSON = ROOT / "reports" / "latest_metrics.json"
DEFAULT_MD = ROOT / "reports" / "latest_evaluation.md"


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _probability(value: Any) -> float | None:
    number = _number(value)
    if number is None:
        return None
    if abs(number) > 1:
        number /= 100.0
    if not 0 <= number <= 1:
        return None
    return min(1 - 1e-15, max(1e-15, number))


def _brier(pairs: list[tuple[float, int]]) -> float | None:
    if not pairs:
        return None
    return sum((p - y) ** 2 for p, y in pairs) / len(pairs)


def _log_loss(pairs: list[tuple[float, int]]) -> float | None:
    if not pairs:
        return None
    return -sum(y * math.log(p) + (1 - y) * math.log(1 - p) for p, y in pairs) / len(pairs)


def _ece(pairs: list[tuple[float, int]], bins: int = 10) -> tuple[float | None, float | None]:
    if not pairs:
        return None, None
    groups: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for p, y in pairs:
        index = min(bins - 1, int(p * bins))
        groups[index].append((p, y))
    total = len(pairs)
    errors: list[tuple[float, int]] = []
    for group in groups:
        if not group:
            continue
        predicted = sum(p for p, _ in group) / len(group)
        actual = sum(y for _, y in group) / len(group)
        errors.append((abs(predicted - actual), len(group)))
    ece = sum(error * count / total for error, count in errors)
    mce = max((error for error, _ in errors), default=None)
    return ece, mce


def _git_revision(root: Path) -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _rows(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]


def _market_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    settled = [row for row in rows if str(row.get("status") or "").lower() == "settled"]
    scored = [
        row
        for row in settled
        if str(row.get("result") or "").lower() in {"win", "loss"}
    ]
    wins = sum(1 for row in scored if str(row.get("result")).lower() == "win")
    losses = len(scored) - wins
    stakes = [value for row in settled if (value := _number(row.get("units_staked"))) is not None and value > 0]
    profits = [value for row in settled if (value := _number(row.get("units_pl"))) is not None]
    total_stake = sum(stakes) if stakes else None
    total_profit = sum(profits) if profits else None
    roi = (
        total_profit / total_stake
        if total_stake is not None and total_stake > 0 and total_profit is not None
        else None
    )
    edges = [value for row in settled if (value := _number(row.get("edge"))) is not None]
    clvs = [value for row in settled if (value := _number(row.get("clv"))) is not None]
    pairs = [
        (probability, 1 if str(row.get("result")).lower() == "win" else 0)
        for row in scored
        if (probability := _probability(row.get("model_prob"))) is not None
    ]
    ece, mce = _ece(pairs)
    return {
        "n_settled": len(settled),
        "n_scored": len(scored),
        "wins": wins,
        "losses": losses,
        "win_rate": wins / len(scored) if scored else None,
        "total_units_staked": total_stake,
        "total_units_pl": total_profit,
        "roi_stake_weighted": roi,
        "average_edge": sum(edges) / len(edges) if edges else None,
        "edge_coverage": len(edges),
        "average_clv": sum(clvs) / len(clvs) if clvs else None,
        "clv_coverage": len(clvs),
        "brier_score": _brier(pairs),
        "log_loss": _log_loss(pairs),
        "ece": ece,
        "mce": mce,
        "probability_coverage": len(pairs),
    }


def build(db_path: Path) -> dict[str, Any]:
    if not db_path.exists():
        return {
            "status": "unavailable",
            "reason": f"database not found: {db_path}",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        ledger_rows = _rows(conn, "bet_ledger")
        ledger_columns = _table_columns(conn, "bet_ledger")
        pick_count = conn.execute("SELECT COUNT(*) FROM picks").fetchone()[0]
        snapshot_count = 0
        run_count = 0
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature_snapshots'"
        ).fetchone():
            snapshot_count = conn.execute(
                "SELECT COUNT(*) FROM feature_snapshots WHERE feature_group='prediction_decision_snapshot'"
            ).fetchone()[0]
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='prediction_runs'"
        ).fetchone():
            run_count = conn.execute("SELECT COUNT(*) FROM prediction_runs").fetchone()[0]
    finally:
        conn.close()

    by_market = {
        market: _market_metrics(
            [row for row in ledger_rows if str(row.get("market") or "moneyline").lower() == market]
        )
        for market in sorted({str(row.get("market") or "moneyline").lower() for row in ledger_rows})
    }

    reasons: Counter[str] = Counter()
    for row in ledger_rows:
        if not row.get("date_ymd"):
            reasons["missing_date_ymd"] += 1
        if "selected_team_id" not in ledger_columns or not row.get("selected_team_id"):
            reasons["missing_selected_team_id"] += 1
        if "bookmaker" not in ledger_columns or not row.get("bookmaker"):
            reasons["missing_bookmaker"] += 1
        if "quote_id" not in ledger_columns or not row.get("quote_id"):
            reasons["missing_quote_id"] += 1
        if "calibration_version" not in ledger_columns or not row.get("calibration_version"):
            reasons["missing_calibration_version"] += 1
        if row.get("status") == "open":
            reasons["open_unsettled"] += 1

    historical_complete = sum(1 for row in ledger_rows if all(
        row.get(field)
        for field in ("date_ymd", "selected_team_id", "bookmaker", "quote_id", "calibration_version")
    ))
    status = "production_replay" if ledger_rows and historical_complete == len(ledger_rows) and run_count else "partial"

    return {
        "status": status,
        "report_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_revision": _git_revision(ROOT),
        "database": str(db_path),
        "population": {
            "label": "immutable_live_ledger" if status == "production_replay" else "mixed_legacy_live_ledger",
            "ledger_rows": len(ledger_rows),
            "picks_rows": pick_count,
            "prediction_runs": run_count,
            "decision_snapshots": snapshot_count,
            "historically_complete_rows": historical_complete,
            "usable_for_promotion": status == "production_replay",
        },
        "provenance_gaps": dict(reasons),
        "markets": by_market,
        "baselines": {
            "always_home": None,
            "market_favorite": None,
            "no_vig_market": None,
            "regularized_logistic": None,
            "reason_unavailable": "Full chronological canonical-core replay baseline not yet available.",
        },
        "limitations": [
            "Legacy rows may lack prediction timestamp, book/quote identity, or calibration version.",
            "Snapshot replay currently projects frozen decisions; full pure-core replay remains incomplete.",
            "Metrics are descriptive ledger evaluation, not a new model-performance claim.",
        ],
    }


def _fmt(value: Any, percent: bool = False) -> str:
    if value is None:
        return "unavailable"
    if percent:
        return f"{float(value) * 100:.2f}%"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Latest Evaluation",
        "",
        f"**Status:** `{report.get('status')}`  ",
        f"**Generated:** {report.get('generated_at')}  ",
        f"**Git:** `{report.get('git_revision') or 'unknown'}`",
        "",
        "This artifact is generated reproducibly from SQLite. It is not a profitability claim.",
        "",
        "## Population",
        "",
    ]
    for key, value in (report.get("population") or {}).items():
        lines.append(f"- **{key}:** {value}")
    lines.extend(["", "## Markets", ""])
    for market, metrics in (report.get("markets") or {}).items():
        lines.extend(
            [
                f"### {market}",
                "",
                f"- Settled: {_fmt(metrics.get('n_settled'))}",
                f"- Record: {_fmt(metrics.get('wins'))}-{_fmt(metrics.get('losses'))}",
                f"- Win rate: {_fmt(metrics.get('win_rate'), percent=True)}",
                f"- Units staked: {_fmt(metrics.get('total_units_staked'))}",
                f"- Units P/L: {_fmt(metrics.get('total_units_pl'))}",
                f"- ROI (stake-weighted): {_fmt(metrics.get('roi_stake_weighted'), percent=True)}",
                f"- Brier: {_fmt(metrics.get('brier_score'))}",
                f"- Log loss: {_fmt(metrics.get('log_loss'))}",
                f"- ECE / MCE: {_fmt(metrics.get('ece'))} / {_fmt(metrics.get('mce'))}",
                f"- CLV: {_fmt(metrics.get('average_clv'))} (coverage {metrics.get('clv_coverage')}/{metrics.get('n_settled')})",
                "",
            ]
        )
    lines.extend(["## Provenance gaps", ""])
    for reason, count in (report.get("provenance_gaps") or {}).items():
        lines.append(f"- {reason}: {count}")
    lines.extend(["", "## Limitations", ""])
    for item in report.get("limitations") or []:
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()

    report = build(args.db.resolve())
    atomic_write(args.json_out.resolve(), json.dumps(report, indent=2, sort_keys=True) + "\n")
    atomic_write(args.md_out.resolve(), markdown(report))
    if args.stdout:
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get("status") != "unavailable" else 1


if __name__ == "__main__":
    raise SystemExit(main())
