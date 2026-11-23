#!/usr/bin/env python3
"""Run strict day-boundary walk-forward OOF calibration benchmark (identity vs isotonic vs Platt vs Beta-Logit)."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.probability_calibrator import (
    _extract_predicted_probability,
    _normalize_market,
    walk_forward_calibration_benchmark,
)


def load_dated_outcomes(csv_path: Path) -> list[tuple[str, float, float]]:
    dated_rows: list[tuple[str, float, float]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            market = _normalize_market(row.get("market", ""))
            if market != "moneyline":
                continue
            result = str(row.get("result", "")).strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            date_str = str(row.get("date") or row.get("date_ymd") or "").strip()
            dated_rows.append((date_str, prob, 1.0 if result == "win" else 0.0))
    return dated_rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Walk-forward OOF calibration benchmark (Phase 3.2).")
    parser.add_argument(
        "--csv",
        default=str(PROJECT_ROOT / "data" / "evolution" / "prediction_outcomes.csv"),
        help="Path to historical prediction outcomes CSV",
    )
    parser.add_argument("--min-train", type=int, default=100)
    parser.add_argument("--step", type=int, default=50)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    csv_file = Path(args.csv)
    if not csv_file.exists():
        err = {"status": "error", "error": f"CSV not found: {csv_file}"}
        print(json.dumps(err, indent=2) if args.json else f"ERROR: {err['error']}")
        return 1

    dated_rows = load_dated_outcomes(csv_file)
    report: dict[str, Any] = walk_forward_calibration_benchmark(
        dated_rows,
        min_train_samples=args.min_train,
        step_size=args.step,
    )
    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return 0

    print("=== Strict Day-Boundary Walk-Forward Calibration Benchmark ===")
    print(
        f"CSV: {csv_file} | Total moneyline rows: {report.get('n_total', 0)} "
        f"| OOF evaluated: {report.get('n_oof_evaluated', 0)}\n"
    )
    methods = report.get("methods") or {}
    if not methods:
        print(f"Status: {report.get('status')} (insufficient samples)")
        return 0

    print(f"{'Method':<14} {'Brier':>10} {'LogLoss':>10} {'ECE':>10}")
    for method_name in ("identity", "isotonic", "platt", "beta_logit"):
        m = methods.get(method_name)
        if not m:
            continue
        print(
            f"{method_name:<14} {m['brier']:>10.6f} {m['log_loss']:>10.6f} {m['ece']:>10.6f}"
        )
    print(
        f"\nBest by Brier: {report.get('best_by_brier')} | "
        f"Best by Log-Loss: {report.get('best_by_log_loss')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
