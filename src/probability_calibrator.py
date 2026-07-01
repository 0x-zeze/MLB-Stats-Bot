"""Isotonic regression calibrator for model probabilities.

Maps raw model probabilities to calibrated probabilities using historical
prediction outcomes, per active market (moneyline, yrfi). Uses
piecewise-linear interpolation from binned averages (no sklearn dependency).
"""

from __future__ import annotations

import csv
import json
import sqlite3
from bisect import bisect_left
from pathlib import Path
from typing import Any

from .utils import clamp, safe_float

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_OUTCOMES_PATH = _DATA_DIR / "evolution" / "prediction_outcomes.csv"
# Legacy single-market (moneyline) map; kept for backward compatibility.
_CALIBRATION_MAP_PATH = _DATA_DIR / "calibration_map.json"
# Per-market maps: {"moneyline": [[x,y],...], "yrfi": [...]}.
_CALIBRATION_MAPS_PATH = _DATA_DIR / "calibration_maps.json"
_SQLITE_PATH = _DATA_DIR / "state.sqlite"

_MARKETS = ("moneyline", "yrfi")

_MIN_SAMPLES = 50
_BUCKET_SIZE = 0.03
_MIN_BIN_COUNT = 3

# Per-market overrides for low-volume markets. Moneyline has enough samples for
# tight defaults. YRFI is thinner: a wider bucket lets it form stable bins, but
# the per-bin floor stays at 4 so a tiny tail bin cannot become an extreme anchor.
# Markets absent here use the defaults.
_MARKET_PARAMS: dict[str, dict[str, float]] = {
    "yrfi": {"min_samples": 40, "bucket_size": 0.05, "min_bin_count": 4},
}

_SQLITE_MARKET_PARAMS: dict[str, dict[str, float]] = {
    "moneyline": {"min_samples": 25, "bucket_size": 0.04, "min_bin_count": 2},
    "yrfi": {"min_samples": 30, "bucket_size": 0.05, "min_bin_count": 2},
}

_cached_maps: dict[str, list[tuple[float, float]]] | None = None


def _load_calibration_maps() -> dict[str, list[tuple[float, float]]]:
    global _cached_maps
    if _cached_maps is not None:
        return _cached_maps

    maps: dict[str, list[tuple[float, float]]] = {}
    # Prefer the per-market file; fall back to the legacy moneyline-only file.
    if _CALIBRATION_MAPS_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAPS_PATH.read_text())
            for market, pairs in raw.items():
                maps[market] = [(float(p[0]), float(p[1])) for p in pairs]
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            maps = {}
    if "moneyline" not in maps and _CALIBRATION_MAP_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAP_PATH.read_text())
            maps["moneyline"] = [(float(p[0]), float(p[1])) for p in raw]
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass

    _cached_maps = maps
    return maps


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


def calibrate(raw_probability: float, market: str = "moneyline") -> float:
    """Map a raw model probability to a calibrated probability for a market.

    Falls back to the raw probability when no calibration map exists for the
    market (e.g. not enough samples yet), so an uncalibrated market is never
    worse than the model's own estimate.
    """
    mapping = _load_calibration_maps().get(str(market).strip().lower())
    if not mapping:
        return raw_probability
    calibrated = _interpolate(mapping, raw_probability)
    return clamp(calibrated, 0.05, 0.95)


def _normalize_probability(value: Any) -> float | None:
    """Normalize decimal or percent probability to a valid model range."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    normalized = safe_float(value, None)
    if normalized is None:
        return None
    if normalized > 1.0:
        normalized /= 100.0
    if not 0.05 <= normalized <= 0.95:
        return None
    return normalized


def _normalize_market(value: Any) -> str | None:
    market = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if market in {"first_inning", "yrfi", "nrfi"}:
        return "yrfi"
    if market == "moneyline":
        return "moneyline"
    return None


def _extract_predicted_probability(row: dict[str, Any]) -> float | None:
    eval_json = row.get("evaluation_json", "")
    if eval_json:
        try:
            data = json.loads(eval_json)
            # The evaluator stores the authoritative per-market win probability
            # for the picked side here (moneyline and yrfi alike). Prefer
            # it so every active market calibrates, not just moneyline.
            predicted = safe_float(data.get("predicted_probability"), None)
            if predicted is not None:
                val = predicted / 100.0 if predicted > 1.0 else predicted
                if abs(val - 0.5) > 1e-9:
                    return clamp(val, 0.05, 0.95)
            edge = safe_float(data.get("edge"), None)
            if edge is not None and abs(edge) > 1e-9:
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
        prob = outcome + (1 - 2 * outcome) * (brier ** 0.5)
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


def _fit_market_map(
    rows: list[tuple[float, float]],
    *,
    min_samples: int = _MIN_SAMPLES,
    bucket_size: float = _BUCKET_SIZE,
    min_bin_count: int = _MIN_BIN_COUNT,
) -> tuple[list[tuple[float, float]] | None, dict[str, Any]]:
    """Bin (prob, outcome) pairs and fit an isotonic map for one market."""
    if len(rows) < min_samples:
        return None, {"status": "skipped", "reason": f"only {len(rows)} samples (need {min_samples})"}

    buckets: dict[int, list[tuple[float, float]]] = {}
    for prob, outcome in rows:
        bucket_idx = int(prob / bucket_size)
        buckets.setdefault(bucket_idx, []).append((prob, outcome))

    binned_points: list[tuple[float, float]] = []
    for bucket_idx in sorted(buckets):
        points = buckets[bucket_idx]
        if len(points) < min_bin_count:
            continue
        avg_prob = sum(p[0] for p in points) / len(points)
        avg_outcome = sum(p[1] for p in points) / len(points)
        binned_points.append((avg_prob, avg_outcome))

    if len(binned_points) < 3:
        return None, {
            "status": "skipped",
            "reason": "not enough bins with sufficient data",
            "samples": len(rows),
            "buckets": len(buckets),
            "bins": len(binned_points),
            "min_bin_count": min_bin_count,
        }

    calibration_map = _make_isotonic(binned_points)

    # Degenerate guard: if pool-adjacent-violators collapsed everything to a single
    # flat level (all y within 1e-6), the market has no monotonic signal — the
    # mapping would just pull every probability to one constant (this is what
    # happened to yrfi: a single [0.598 -> 0.406] point). Skip it and let
    # calibrate() fall back to the raw probability, which is strictly safer than
    # forcing a constant. A genuine calibration map needs >=2 distinct outputs.
    distinct_y = {round(y, 6) for _, y in calibration_map}
    if len(calibration_map) < 2 or len(distinct_y) < 2:
        return None, {
            "status": "skipped",
            "reason": "degenerate map (no monotonic signal; falls back to raw)",
            "samples": len(rows),
            "bins": len(binned_points),
        }

    return calibration_map, {
        "status": "success",
        "samples": len(rows),
        "bins": len(binned_points),
        "map_points": len(calibration_map),
    }


def _write_calibration_maps(
    maps: dict[str, list[tuple[float, float]]],
    per_market: dict[str, Any],
    *,
    source: str,
) -> dict[str, Any]:
    """Persist per-market maps and keep legacy moneyline map synced."""
    global _cached_maps

    if not maps:
        return {"status": "skipped", "reason": "no market had enough samples", "markets": per_market, "source": source}

    _CALIBRATION_MAPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CALIBRATION_MAPS_PATH.write_text(
        json.dumps({m: [list(p) for p in pts] for m, pts in maps.items()}, indent=2)
    )
    if "moneyline" in maps:
        _CALIBRATION_MAP_PATH.write_text(
            json.dumps([list(p) for p in maps["moneyline"]], indent=2)
        )
    _cached_maps = maps

    return {
        "status": "success",
        "markets": per_market,
        "calibrated_markets": sorted(maps.keys()),
        "path": str(_CALIBRATION_MAPS_PATH),
        "source": source,
    }


def _fit_all_markets(
    rows_by_market: dict[str, list[tuple[float, float]]],
    *,
    min_samples: int | None = None,
    market_params: dict[str, dict[str, float]] | None = None,
) -> tuple[dict[str, list[tuple[float, float]]], dict[str, Any]]:
    maps: dict[str, list[tuple[float, float]]] = {}
    per_market: dict[str, Any] = {}
    for market in _MARKETS:
        params = (market_params or _MARKET_PARAMS).get(market, {})
        if market_params is None and min_samples is not None:
            sample_floor = min_samples
        else:
            sample_floor = params.get("min_samples", min_samples if min_samples is not None else _MIN_SAMPLES)
        calibration_map, info = _fit_market_map(
            rows_by_market[market],
            min_samples=int(sample_floor),
            bucket_size=float(params.get("bucket_size", _BUCKET_SIZE)),
            min_bin_count=int(params.get("min_bin_count", _MIN_BIN_COUNT)),
        )
        per_market[market] = info
        if calibration_map is not None:
            maps[market] = calibration_map
    return maps, per_market


def retrain() -> dict[str, Any]:
    """Rebuild per-market calibration maps from prediction outcomes."""
    if not _OUTCOMES_PATH.exists():
        return {"status": "error", "reason": "prediction_outcomes.csv not found", "source": "CSV prediction_outcomes"}

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    with open(_OUTCOMES_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            market = _normalize_market(row.get("market", ""))
            if market not in rows_by_market:
                continue
            result = row.get("result", "").strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            outcome = 1.0 if result == "win" else 0.0
            rows_by_market[market].append((prob, outcome))

    maps, per_market = _fit_all_markets(rows_by_market)
    return _write_calibration_maps(maps, per_market, source="CSV prediction_outcomes")


def retrain_from_sqlite(sqlite_path: str | Path | None = None) -> dict[str, Any]:
    """Rebuild per-market calibration maps from live bet ledger probabilities."""
    source = Path(sqlite_path) if sqlite_path is not None else _SQLITE_PATH
    if not source.exists():
        return {"status": "error", "reason": f"SQLite database not found: {source}", "source": "SQLite bet_ledger"}

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    try:
        conn = sqlite3.connect(str(source))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT market, model_prob, result
                FROM bet_ledger
                WHERE status = 'settled'
                  AND result IN ('win', 'loss')
                """
            )
            for row in rows:
                market = _normalize_market(row["market"])
                if market not in rows_by_market:
                    continue
                prob = _normalize_probability(row["model_prob"])
                if prob is None:
                    continue
                outcome = 1.0 if str(row["result"]).strip().lower() == "win" else 0.0
                rows_by_market[market].append((prob, outcome))

            try:
                yrfi_rows = conn.execute(
                    """
                    SELECT probability, correct
                    FROM yrfi_results
                    WHERE correct IS NOT NULL
                    """
                )
            except sqlite3.Error:
                yrfi_rows = []
            for row in yrfi_rows:
                prob = _normalize_probability(row["probability"])
                if prob is None:
                    continue
                outcome = safe_float(row["correct"], None)
                if outcome not in (0.0, 1.0):
                    continue
                rows_by_market["yrfi"].append((prob, float(outcome)))
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"status": "error", "reason": f"SQLite read failed: {exc}", "source": "SQLite bet_ledger"}

    maps, per_market = _fit_all_markets(rows_by_market, market_params=_SQLITE_MARKET_PARAMS)
    return _write_calibration_maps(maps, per_market, source="SQLite bet_ledger")


def retrain_default() -> dict[str, Any]:
    """Prefer live SQLite calibration, falling back to CSV outcomes."""
    if _SQLITE_PATH.exists():
        return retrain_from_sqlite(_SQLITE_PATH)
    return retrain()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Probability calibrator")
    parser.add_argument("--retrain", action="store_true", help="Rebuild calibration map")
    args = parser.parse_args()

    if args.retrain:
        result = retrain_default()
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()
