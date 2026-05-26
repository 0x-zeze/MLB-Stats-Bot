"""Isotonic regression calibrator for moneyline probabilities.

Maps raw model probabilities to calibrated probabilities using historical
prediction outcomes. Uses piecewise-linear interpolation from binned averages
(no sklearn dependency).
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from pathlib import Path
from typing import Any

from .utils import clamp, safe_float

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_OUTCOMES_PATH = _DATA_DIR / "evolution" / "prediction_outcomes.csv"
_CALIBRATION_MAP_PATH = _DATA_DIR / "calibration_map.json"

_MIN_SAMPLES = 50
_BUCKET_SIZE = 0.03
_MIN_BIN_COUNT = 3

_cached_map: list[tuple[float, float]] | None = None


def _load_calibration_map() -> list[tuple[float, float]]:
    global _cached_map
    if _cached_map is not None:
        return _cached_map
    if not _CALIBRATION_MAP_PATH.exists():
        return []
    try:
        raw = json.loads(_CALIBRATION_MAP_PATH.read_text())
        _cached_map = [(float(pair[0]), float(pair[1])) for pair in raw]
        return _cached_map
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return []


def _interpolate(mapping: list[tuple[float, float]], raw: float) -> float:
    if not mapping:
        return raw
    xs = [p[0] for p in mapping]
    ys = [p[1] for p in mapping]

    if raw <= xs[0]:
        return ys[0]
    if raw >= xs[-1]:
        return ys[-1]

    idx = bisect_left(xs, raw)
    if idx == 0:
        return ys[0]

    x0, x1 = xs[idx - 1], xs[idx]
    y0, y1 = ys[idx - 1], ys[idx]
    if x1 == x0:
        return y0
    t = (raw - x0) / (x1 - x0)
    return y0 + t * (y1 - y0)


def calibrate(raw_probability: float) -> float:
    """Map a raw model probability to a calibrated probability."""
    mapping = _load_calibration_map()
    if not mapping:
        return raw_probability
    calibrated = _interpolate(mapping, raw_probability)
    return clamp(calibrated, 0.05, 0.95)


def _extract_predicted_probability(row: dict[str, Any]) -> float | None:
    eval_json = row.get("evaluation_json", "")
    if eval_json:
        try:
            data = json.loads(eval_json)
            edge = safe_float(data.get("edge"), None)
            if edge is not None:
                return clamp((50.0 + edge) / 100.0, 0.05, 0.95)
            prob = data.get("model_probability") or data.get("home_win_probability")
            if prob is not None:
                val = safe_float(prob)
                return clamp(val / 100.0 if val > 1.0 else val, 0.05, 0.95)
        except (json.JSONDecodeError, TypeError):
            pass
    brier = safe_float(row.get("brier_score"), None)
    result = row.get("result", "").strip().lower()
    if brier is not None and result in ("win", "loss"):
        outcome = 1.0 if result == "win" else 0.0
        prob = outcome - (1 - 2 * outcome) * (brier ** 0.5)
        return clamp(prob, 0.05, 0.95)
    return None


def _make_isotonic(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Apply pool adjacent violators to enforce monotonicity."""
    if not points:
        return []
    points = sorted(points, key=lambda p: p[0])

    blocks: list[list[tuple[float, float]]] = [[points[0]]]
    for point in points[1:]:
        blocks.append([point])
        while len(blocks) >= 2:
            last_avg = sum(p[1] for p in blocks[-1]) / len(blocks[-1])
            prev_avg = sum(p[1] for p in blocks[-2]) / len(blocks[-2])
            if prev_avg <= last_avg:
                break
            blocks[-2].extend(blocks[-1])
            blocks.pop()

    result: list[tuple[float, float]] = []
    for block in blocks:
        avg_x = sum(p[0] for p in block) / len(block)
        avg_y = sum(p[1] for p in block) / len(block)
        result.append((avg_x, avg_y))
    return result


def retrain() -> dict[str, Any]:
    """Rebuild calibration map from prediction outcomes."""
    global _cached_map

    if not _OUTCOMES_PATH.exists():
        return {"status": "error", "reason": "prediction_outcomes.csv not found"}

    rows: list[tuple[float, float]] = []
    with open(_OUTCOMES_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("market", "").strip().lower() != "moneyline":
                continue
            result = row.get("result", "").strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            outcome = 1.0 if result == "win" else 0.0
            rows.append((prob, outcome))

    if len(rows) < _MIN_SAMPLES:
        return {"status": "skipped", "reason": f"only {len(rows)} samples (need {_MIN_SAMPLES})"}

    buckets: dict[int, list[tuple[float, float]]] = {}
    for prob, outcome in rows:
        bucket_idx = int(prob / _BUCKET_SIZE)
        buckets.setdefault(bucket_idx, []).append((prob, outcome))

    binned_points: list[tuple[float, float]] = []
    for bucket_idx in sorted(buckets):
        points = buckets[bucket_idx]
        if len(points) < _MIN_BIN_COUNT:
            continue
        avg_prob = sum(p[0] for p in points) / len(points)
        avg_outcome = sum(p[1] for p in points) / len(points)
        binned_points.append((avg_prob, avg_outcome))

    if len(binned_points) < 3:
        return {"status": "skipped", "reason": "not enough bins with sufficient data"}

    calibration_map = _make_isotonic(binned_points)

    _CALIBRATION_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CALIBRATION_MAP_PATH.write_text(json.dumps(calibration_map, indent=2))
    _cached_map = calibration_map

    return {
        "status": "success",
        "samples": len(rows),
        "bins": len(binned_points),
        "map_points": len(calibration_map),
        "path": str(_CALIBRATION_MAP_PATH),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Probability calibrator")
    parser.add_argument("--retrain", action="store_true", help="Rebuild calibration map")
    args = parser.parse_args()

    if args.retrain:
        result = retrain()
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()
