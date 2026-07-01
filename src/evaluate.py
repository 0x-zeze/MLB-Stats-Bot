"""Evaluate logged MLB predictions and produce reports."""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any

from .calibration import brier_score, calibration_by_confidence, calibration_table, log_loss
from .data_loader import read_csv
from .reports import format_calibration_report, format_group_report, format_metrics, market_total_range
from .utils import data_path, safe_float

PREDICTION_LOG_FIELDS = [
    "game_id",
    "game_pk",
    "decision_id",
    "date",
    "home_team",
    "away_team",
    "matchup",
    "predicted_winner",
    "final_lean",
    "market_type",
    "home_win_probability",
    "away_win_probability",
    "over_probability",
    "under_probability",
    "projected_total_runs",
    "market_total",
    "model_prob",
    "fair_prob",
    "model_edge",
    "edge",
    "confidence",
    "odds",
    "units_staked",
    "actual_home_score",
    "actual_away_score",
    "actual_total_runs",
    "result",
    "profit_loss",
    "closing_line",
    "closing_line_value",
    "recommended_at",
    "settled_at",
]


def prediction_log_fieldnames() -> list[str]:
    """Return stable prediction-log columns used by CSV exports."""
    return list(PREDICTION_LOG_FIELDS)


def load_prediction_log(
    path: str | Path | None = None,
    sqlite_path: str | Path | None = data_path("state.sqlite"),
) -> list[dict[str, Any]]:
    """Load prediction log rows from live SQLite when available, else CSV."""
    sqlite_source = Path(sqlite_path) if sqlite_path else None
    if sqlite_source and sqlite_source.exists():
        return build_prediction_log_rows_from_sqlite(sqlite_source)
    source = Path(path) if path else data_path("predictions_log.csv")
    if not source.exists():
        return []
    return read_csv(source)


def _safe_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None or value == "":
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _get_nested(data: dict[str, Any], *path: str) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _first_value(*values: Any) -> Any:
    for value in values:
        if value is not None and str(value).strip() != "":
            return value
    return ""


def _float_or_none(value: Any) -> float | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    number = safe_float(value, float("nan"))
    return None if number != number else number


def _decimal_probability(value: Any) -> float | str:
    number = _float_or_none(value)
    if number is None:
        return ""
    if abs(number) > 1.0:
        number /= 100.0
    return max(0.0, min(1.0, number))


def _decimal_edge(value: Any) -> float | str:
    number = _float_or_none(value)
    if number is None:
        return ""
    return number / 100.0 if abs(number) > 1.0 else number


def _parse_matchup(matchup: Any) -> tuple[str, str]:
    text = str(matchup or "")
    if " @ " not in text:
        return "", ""
    away, home = text.split(" @ ", 1)
    return away.strip(), home.strip()


def _pick_name(payload: dict[str, Any]) -> Any:
    return _first_value(
        _get_nested(payload, "pick", "name"),
        _get_nested(payload, "pick", "team"),
        _get_nested(payload, "pick", "teamName"),
        _get_nested(payload, "valuePick", "teamName"),
    )


def _team_name(payload: dict[str, Any], side: str) -> Any:
    return _first_value(
        _get_nested(payload, side, "name"),
        _get_nested(payload, side, "team"),
        _get_nested(payload, side, "teamName"),
        _get_nested(payload, f"{side}Team", "name"),
    )


def _market_total(payload: dict[str, Any]) -> Any:
    return _first_value(
        payload.get("projectedTotal"),
        payload.get("marketTotal"),
        _get_nested(payload, "totals", "projectedTotal"),
        _get_nested(payload, "totals", "marketTotal"),
        _get_nested(payload, "currentOdds", "total"),
        _get_nested(payload, "currentOdds", "totalLine"),
    )


def _result_label(value: Any) -> str:
    result = str(value or "").strip().lower()
    if result in {"win", "won", "w"}:
        return "win"
    if result in {"loss", "lost", "l"}:
        return "loss"
    if result in {"push", "void", "tie"}:
        return "push"
    return ""


def _truthy_sqlite(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "win", "won"}:
        return True
    if text in {"0", "false", "no", "loss", "lost"}:
        return False
    return None


def _empty_prediction_row() -> dict[str, Any]:
    return {field: "" for field in PREDICTION_LOG_FIELDS}


def _ledger_row_to_prediction_log(row: dict[str, Any]) -> dict[str, Any] | None:
    result = _result_label(row.get("result"))
    if result == "push":
        return None

    payload = _safe_json(row.get("pick_payload"))
    matchup = _first_value(row.get("matchup"), payload.get("matchup"))
    away_team, home_team = _parse_matchup(matchup)
    away_team = str(_first_value(away_team, _team_name(payload, "away")))
    home_team = str(_first_value(home_team, _team_name(payload, "home")))
    side = str(row.get("side") or "").strip().lower()
    model_prob = _decimal_probability(row.get("model_prob"))
    fair_prob = _decimal_probability(row.get("fair_prob"))

    home_probability: float | str = model_prob if isinstance(model_prob, float) else ""
    away_probability: float | str = ""
    if isinstance(model_prob, float):
        if side == "home":
            away_probability = round(1.0 - model_prob, 6)
        elif side == "away":
            away_probability = model_prob

    final_lean = _first_value(_pick_name(payload), row.get("team"))
    market_total = _market_total(payload)
    row_out = _empty_prediction_row()
    row_out.update(
        {
            "game_id": row.get("game_pk") or "",
            "game_pk": row.get("game_pk") or "",
            "decision_id": row.get("decision_id") or "",
            "date": _first_value(row.get("pick_date_ymd"), row.get("date_ymd")),
            "home_team": home_team,
            "away_team": away_team,
            "matchup": matchup,
            "predicted_winner": final_lean,
            "final_lean": final_lean,
            "market_type": str(row.get("market") or "moneyline").lower(),
            "home_win_probability": home_probability,
            "away_win_probability": away_probability,
            "projected_total_runs": market_total,
            "market_total": market_total,
            "model_prob": model_prob,
            "fair_prob": fair_prob,
            "model_edge": _decimal_edge(row.get("edge")),
            "edge": row.get("edge") if row.get("edge") is not None else "",
            "confidence": _first_value(row.get("pick_confidence"), _get_nested(payload, "pick", "confidence")),
            "odds": row.get("odds") if row.get("odds") is not None else "",
            "units_staked": row.get("units_staked") if row.get("units_staked") is not None else "",
            "result": result,
            "profit_loss": row.get("units_pl") if row.get("units_pl") is not None else "",
            "closing_line_value": row.get("clv") if row.get("clv") is not None else "",
            "recommended_at": row.get("recommended_at") or "",
            "settled_at": row.get("settled_at") or "",
        }
    )
    return row_out


def _yrfi_row_to_prediction_log(row: dict[str, Any]) -> dict[str, Any]:
    payload = _safe_json(row.get("pick_payload"))
    matchup = _first_value(row.get("matchup"), payload.get("matchup"))
    away_team, home_team = _parse_matchup(matchup)
    away_team = str(_first_value(away_team, _team_name(payload, "away")))
    home_team = str(_first_value(home_team, _team_name(payload, "home")))
    correct = _truthy_sqlite(row.get("correct"))
    result = "" if correct is None else ("win" if correct else "loss")
    probability = _decimal_probability(row.get("probability"))
    row_out = _empty_prediction_row()
    row_out.update(
        {
            "game_id": row.get("game_pk") or "",
            "game_pk": row.get("game_pk") or "",
            "date": _first_value(row.get("yrfi_date_ymd"), row.get("pick_date_ymd")),
            "home_team": home_team,
            "away_team": away_team,
            "matchup": matchup,
            "predicted_winner": row.get("pick") or "",
            "final_lean": row.get("pick") or "",
            "market_type": "yrfi",
            "home_win_probability": probability,
            "model_prob": probability,
            "confidence": _first_value(row.get("pick_confidence"), _get_nested(payload, "firstInning", "confidence")),
            "projected_total_runs": _market_total(payload),
            "market_total": _market_total(payload),
            "result": result,
            "profit_loss": "" if result == "" else (1.0 if result == "win" else -1.0),
            "settled_at": row.get("processed_at") or "",
        }
    )
    return row_out


def build_prediction_log_rows_from_sqlite(sqlite_path: str | Path) -> list[dict[str, Any]]:
    """Build evaluator-compatible rows from live SQLite state."""
    source = Path(sqlite_path)
    if not source.exists():
        return []

    try:
        conn = sqlite3.connect(str(source))
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return []
    try:
        ledger_rows = [
            dict(row)
            for row in conn.execute(
                """
                SELECT
                    b.decision_id,
                    b.game_pk,
                    b.date_ymd,
                    b.market,
                    b.team,
                    b.side,
                    b.line,
                    b.odds,
                    b.fair_prob,
                    b.model_prob,
                    b.edge,
                    b.units_staked,
                    b.status,
                    b.result,
                    b.units_pl,
                    b.clv,
                    b.recommended_at,
                    b.settled_at,
                    p.date_ymd AS pick_date_ymd,
                    p.matchup,
                    p.pick_confidence,
                    p.payload AS pick_payload,
                    y.pick AS yrfi_pick,
                    y.probability AS yrfi_probability,
                    y.correct AS yrfi_correct
                FROM bet_ledger b
                JOIN picks p ON p.game_pk = b.game_pk
                LEFT JOIN yrfi_results y ON y.game_pk = b.game_pk
                ORDER BY COALESCE(b.date_ymd, p.date_ymd), b.decision_id
                """
            )
        ]
        yrfi_rows = [
            dict(row)
            for row in conn.execute(
                """
                SELECT
                    y.game_pk,
                    y.date_ymd AS yrfi_date_ymd,
                    y.pick,
                    y.probability,
                    y.correct,
                    y.processed_at,
                    p.date_ymd AS pick_date_ymd,
                    p.matchup,
                    p.pick_confidence,
                    p.payload AS pick_payload
                FROM yrfi_results y
                LEFT JOIN picks p ON p.game_pk = y.game_pk
                ORDER BY COALESCE(y.date_ymd, p.date_ymd), y.game_pk
                """
            )
        ]
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    rows: list[dict[str, Any]] = []
    for ledger_row in ledger_rows:
        prediction_row = _ledger_row_to_prediction_log(ledger_row)
        if prediction_row is not None:
            rows.append(prediction_row)
    rows.extend(_yrfi_row_to_prediction_log(row) for row in yrfi_rows)
    return rows


def is_yrfi_row(row: dict[str, Any]) -> bool:
    """Return true when row represents a YRFI/NRFI market."""
    market = str(row.get("market_type") or row.get("market") or "").strip().lower()
    if market in {"yrfi", "nrfi", "first inning", "first_inning", "first-inning"}:
        return True
    if any(token in market for token in ("yrfi", "nrfi", "first inning", "first_inning")):
        return True
    lean = str(row.get("final_lean") or row.get("prediction") or "").strip().upper()
    return lean in {"YES", "NO"}


def filter_rows_by_market(rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
    """Filter evaluator rows by market name."""
    if market == "all":
        return rows
    if market == "yrfi":
        return [row for row in rows if is_yrfi_row(row)]
    if market == "moneyline":
        return [row for row in rows if not is_yrfi_row(row)]
    return rows


def settled_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows with a win/loss outcome."""
    return [row for row in rows if str(row.get("result", "")).lower() in {"win", "loss"}]


def row_probability(row: dict[str, Any]) -> float:
    """Return probability attached to the final lean."""
    explicit_probability = _decimal_probability(row.get("model_prob"))
    if isinstance(explicit_probability, float):
        return explicit_probability
    lean = str(row.get("final_lean", ""))
    if lean.startswith("Over"):
        return safe_float(row.get("over_probability"), 0.0)
    if lean.startswith("Under"):
        return safe_float(row.get("under_probability"), 0.0)
    if lean and lean == row.get("home_team"):
        return safe_float(row.get("home_win_probability"), 0.0)
    if lean and lean == row.get("away_team"):
        return safe_float(row.get("away_win_probability"), 0.0)
    home_prob = safe_float(row.get("home_win_probability"), 0.0)
    away_prob = safe_float(row.get("away_win_probability"), 0.0)
    return max(home_prob, away_prob, safe_float(row.get("over_probability"), 0.0), safe_float(row.get("under_probability"), 0.0))


def row_won(row: dict[str, Any]) -> int:
    """Return 1 for win, 0 for loss."""
    return 1 if str(row.get("result", "")).lower() == "win" else 0


def calculate_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Calculate accuracy, ROI, edge, CLV, Brier score, and log loss."""
    bets = settled_rows(rows)
    if not bets:
        return {
            "bets": 0,
            "wins": 0,
            "losses": 0,
            "accuracy": 0.0,
            "win_rate": 0.0,
            "roi": 0.0,
            "average_edge": 0.0,
            "average_clv": 0.0,
            "brier_score": 0.0,
            "log_loss": 0.0,
        }

    wins = sum(row_won(row) for row in bets)
    probabilities = [row_probability(row) for row in bets]
    outcomes = [row_won(row) for row in bets]
    profit = sum(safe_float(row.get("profit_loss"), 0.0) for row in bets)
    return {
        "bets": len(bets),
        "wins": wins,
        "losses": len(bets) - wins,
        "accuracy": wins / len(bets),
        "win_rate": wins / len(bets),
        "roi": profit / len(bets),
        "average_edge": sum(safe_float(row.get("model_edge"), 0.0) for row in bets) / len(bets),
        "average_clv": sum(safe_float(row.get("closing_line_value"), 0.0) for row in bets) / len(bets),
        "brier_score": brier_score(probabilities, outcomes),
        "log_loss": log_loss(probabilities, outcomes),
    }


def group_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, dict[str, Any]]:
    """Calculate metrics by arbitrary grouping function."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[key_fn(row)].append(row)
    return {key: calculate_metrics(value) for key, value in groups.items()}


def performance_by_market_total(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Metrics grouped by market total range."""
    return group_metrics(rows, lambda row: market_total_range(row.get("market_total")))


def performance_by_confidence(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Metrics grouped by confidence label."""
    return group_metrics(rows, lambda row: str(row.get("confidence", "unknown")).lower() or "unknown")


def calibration_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows shaped for calibration helpers."""
    return [
        {
            "probability": row_probability(row),
            "won": row_won(row),
        }
        for row in settled_rows(rows)
    ]


def build_report(rows: list[dict[str, Any]]) -> str:
    """Build a text evaluation report."""
    metrics = calculate_metrics(rows)
    calibration_input = calibration_rows(rows)
    lines = [
        format_metrics(metrics),
        "",
        *format_group_report(performance_by_confidence(rows), "Performance by Confidence"),
        "",
        *format_group_report(performance_by_market_total(rows), "Performance by Market Total"),
        "",
        *format_calibration_report(calibration_table(calibration_input), "Calibration by Probability"),
        "",
        *format_calibration_report(calibration_by_confidence(calibration_input), "Calibration by Confidence"),
    ]
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate MLB prediction logs.")
    parser.add_argument("--log", default=str(data_path("predictions_log.csv")), help="Predictions log CSV fallback")
    parser.add_argument("--sqlite", default=str(data_path("state.sqlite")), help="Live SQLite state database")
    parser.add_argument("--market", choices=["moneyline", "yrfi", "all"], default="all")
    parser.add_argument("--report", action="store_true", help="Print evaluation report")
    return parser.parse_args()


def empty_data_message(sqlite_path: str | Path | None, log_path: str | Path | None) -> str:
    """Explain why no settled rows were available."""
    sqlite_source = Path(sqlite_path) if sqlite_path else None
    log_source = Path(log_path) if log_path else None
    sqlite_status = f"exists={sqlite_source.exists()}" if sqlite_source else "disabled"
    log_status = f"exists={log_source.exists()}" if log_source else "disabled"
    return (
        "No settled win/loss predictions found. "
        f"Checked SQLite ({sqlite_source or 'disabled'}, {sqlite_status}) and CSV ({log_source or 'disabled'}, {log_status}). "
        "Use --sqlite <path> for live data, --log <csv> for an export, or run `npm run export:live`."
    )


def main() -> None:
    args = parse_args()
    rows = filter_rows_by_market(load_prediction_log(args.log, args.sqlite), args.market)
    if not settled_rows(rows):
        print(empty_data_message(args.sqlite, args.log))
        return
    if args.report:
        print(build_report(rows))
    else:
        metrics = calculate_metrics(rows)
        print(format_metrics(metrics))


if __name__ == "__main__":
    main()
