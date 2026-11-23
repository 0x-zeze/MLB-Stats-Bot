#!/usr/bin/env python3
"""Train Phase 4 shadow challengers from the read-only SQLite prediction DB.

Supports:
  - learned_v2_logistic    (pure-baseball L2 logistic baseline, v1.0)
  - market_residual_v2     (fixed-offset linear market-residual, v1.0 or v2.0)
  - market_residual_gbdt_v2 (shallow monotone GBDT + fixed market offset, v2.0)

NEVER mutates production SQLite tables or activates a challenger automatically.
Writes proposal artifacts to data/models/ for shadow scoring only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.core.feature_vector_py import (
    FEATURE_VECTOR_SCHEMA_VERSION,
    FEATURE_VECTOR_V2_SCHEMA_VERSION,
)
from src.models.train_learned_v2_logistic import (
    train_learned_v2_logistic,
    write_artifact as write_learned_artifact,
)
from src.models.train_market_residual_gbdt_v2 import (
    train_market_residual_gbdt_v2,
    write_artifact as write_gbdt_artifact,
)
from src.models.train_market_residual_v2 import (
    train_market_residual_v2,
    write_artifact as write_linear_artifact,
)

ALL_MODELS = ("learned_v2_logistic", "market_residual_v2", "market_residual_gbdt_v2")


def run_training(
    db_path: str,
    *,
    output_dir: str = "data/models",
    cohort: str = "main",
    feature_schema_version: str = FEATURE_VECTOR_V2_SCHEMA_VERSION,
    models: list[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    selected = list(models) if models else list(ALL_MODELS)
    db_file = Path(db_path)
    if not db_file.exists():
        return {
            "status": "error",
            "error": f"SQLite database not found: {db_path}",
            "db_path": str(db_file),
            "results": {},
        }

    results: dict[str, dict[str, Any]] = {}
    for model_id in selected:
        if model_id == "learned_v2_logistic":
            report = train_learned_v2_logistic(str(db_file), cohort=cohort)
            writer = write_learned_artifact
        elif model_id == "market_residual_v2":
            report = train_market_residual_v2(
                str(db_file),
                cohort=cohort,
                feature_schema_version=feature_schema_version,
            )
            writer = write_linear_artifact
        elif model_id == "market_residual_gbdt_v2":
            report = train_market_residual_gbdt_v2(
                str(db_file),
                cohort=cohort,
                feature_schema_version=feature_schema_version,
            )
            writer = write_gbdt_artifact
        else:
            results[model_id] = {"status": "error", "reasons": [f"unknown_model_id: {model_id}"]}
            continue

        written_path = None
        if not dry_run and report.get("status") == "trained":
            written_path = writer(report, output_dir)

        results[model_id] = {
            "status": report.get("status"),
            "feature_schema_version": report.get("feature_schema_version"),
            "dataset_row_count": report.get("dataset_row_count", 0),
            "with_market_row_count": report.get("with_market_row_count"),
            "oof_row_count": report.get("oof_row_count", 0),
            "oof_metrics": report.get("oof_metrics"),
            "market_oof_metrics": report.get("market_oof_metrics"),
            "v2_hydration_summary": report.get("v2_hydration_summary"),
            "artifact_hash": report.get("artifact_hash"),
            "artifact_path": written_path,
            "reasons": report.get("reasons", []),
        }

    return {
        "status": "ok",
        "db_path": str(db_file),
        "output_dir": output_dir,
        "cohort": cohort,
        "feature_schema_version": feature_schema_version,
        "dry_run": dry_run,
        "results": results,
    }


def _print_summary(summary: dict[str, Any]) -> None:
    print(f"=== MLB Challenger Trainer ({summary.get('feature_schema_version')}) ===")
    print(f"DB: {summary.get('db_path')} | Cohort: {summary.get('cohort')} | Dry-run: {summary.get('dry_run')}\n")
    if summary.get("status") != "ok":
        print(f"ERROR: {summary.get('error')}")
        return
    for model_id, res in summary["results"].items():
        status = res.get("status")
        rows = res.get("dataset_row_count", 0)
        mkt = res.get("with_market_row_count")
        mkt_str = f" (with_market={mkt})" if mkt is not None else ""
        print(f"- {model_id}: {status.upper()} | rows={rows}{mkt_str}")
        if status == "trained":
            oof = res.get("oof_metrics") or {}
            brier = oof.get("brier")
            ll = oof.get("log_loss")
            b_str = f"{brier:.5f}" if isinstance(brier, (int, float)) else "-"
            l_str = f"{ll:.5f}" if isinstance(ll, (int, float)) else "-"
            print(f"    OOF n={res.get('oof_row_count')} | Brier={b_str} | LogLoss={l_str}")
            print(f"    Hash: {res.get('artifact_hash')}")
            if res.get("artifact_path"):
                print(f"    Saved: {res.get('artifact_path')}")
        else:
            reasons = ", ".join(res.get("reasons") or []) or "none"
            print(f"    Reasons: {reasons}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Train MLB shadow challengers (read-only DB).")
    parser.add_argument("--db", default=str(PROJECT_ROOT / "data" / "state.sqlite"), help="Path to SQLite DB")
    parser.add_argument("--output-dir", default=str(PROJECT_ROOT / "data" / "models"), help="Artifact output dir")
    parser.add_argument("--cohort", default="main", choices=["main", "close_time", "confirmed_lineup"])
    parser.add_argument(
        "--schema",
        default=FEATURE_VECTOR_V2_SCHEMA_VERSION,
        choices=[FEATURE_VECTOR_SCHEMA_VERSION, FEATURE_VECTOR_V2_SCHEMA_VERSION],
    )
    parser.add_argument(
        "--models",
        nargs="+",
        default=list(ALL_MODELS),
        choices=list(ALL_MODELS),
        help="Challenger models to train",
    )
    parser.add_argument("--dry-run", action="store_true", help="Train without writing artifact files")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    args = parser.parse_args()

    summary = run_training(
        args.db,
        output_dir=args.output_dir,
        cohort=args.cohort,
        feature_schema_version=args.schema,
        models=args.models,
        dry_run=args.dry_run,
    )
    if args.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        _print_summary(summary)
    return 0 if summary.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
