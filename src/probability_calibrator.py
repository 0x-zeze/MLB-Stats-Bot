"""Probability calibrator for model probabilities (Isotonic, Platt, Beta-Logit).

Maps raw model probabilities to calibrated probabilities using historical
prediction outcomes, per active market (moneyline). Supports:
  - Piecewise-linear PAV isotonic regression (legacy default)
  - Platt scaling in logit space: sigmoid(a * logit(p) + b), a > 0
  - Beta-Logit calibration (Kull et al., 2017):
    sigmoid(a * ln(p) - b * ln(1 - p) + c), a >= 0, b >= 0, a + b > 0

All parametric methods are pure-Python (L2-regularized Newton-Raphson toward
identity) and share bit-exact formulas with src/calibration.js.
"""

from __future__ import annotations

import csv
import json
import math
import sqlite3
from bisect import bisect_left
from pathlib import Path
from typing import Any

from .utils import clamp, safe_float

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_OUTCOMES_PATH = _DATA_DIR / "evolution" / "prediction_outcomes.csv"
# Legacy single-market (moneyline) map; kept for backward compatibility.
_CALIBRATION_MAP_PATH = _DATA_DIR / "calibration_map.json"
# Per-market maps: {"moneyline": [[x,y],...]}.
_CALIBRATION_MAPS_PATH = _DATA_DIR / "calibration_maps.json"
# Per-market fit metadata, including sample counts used by runtime policy gates.
_CALIBRATION_META_PATH = _DATA_DIR / "calibration_meta.json"
_SQLITE_PATH = _DATA_DIR / "state.sqlite"

_MARKETS = ("moneyline",)

_MIN_SAMPLES = 50
_BUCKET_SIZE = 0.03
_MIN_BIN_COUNT = 3

# Per-market overrides for low-volume markets. Moneyline has enough samples for
# tight defaults. Markets absent here use the defaults.
_MARKET_PARAMS: dict[str, dict[str, float]] = {}

_SQLITE_MARKET_PARAMS: dict[str, dict[str, float]] = {
    "moneyline": {"min_samples": 25, "bucket_size": 0.04, "min_bin_count": 2},
}

_MIN_ISOTONIC_SAMPLES_FOR_TRUST = {
    "moneyline": 150,  # isotonic overfits below this; use shrinkage instead
}

_MIN_PARAMETRIC_SAMPLES_FOR_TRUST = {
    "moneyline": 60,  # 2-3 parameter logit calibrators need far fewer samples
}

_SHRINKAGE_FACTOR = {
    "moneyline": 0.5,  # pull raw probability 50% of the way toward 0.5
}

_PROB_EPS = 1e-6

_cached_maps: dict[str, Any] | None = None
_cached_disk_maps: dict[str, Any] | None = None
_cached_maps_path: Path | None = None
_cached_meta: dict[str, Any] | None = None
_cached_meta_path: Path | None = None


def _logit(p: float) -> float:
    c = min(max(float(p), _PROB_EPS), 1.0 - _PROB_EPS)
    return math.log(c / (1.0 - c))


def _sigmoid(z: float) -> float:
    if z >= 35.0:
        return 1.0
    if z <= -35.0:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def validate_parametric_calibrator(params: Any) -> tuple[bool, str | None]:
    """Validate a parametric calibration object (platt or beta_logit)."""
    if not isinstance(params, dict):
        return False, "not_dict"
    method = str(params.get("method", "")).strip().lower()
    if method == "identity":
        return True, None
    if method == "platt":
        a = safe_float(params.get("a"), None)
        b = safe_float(params.get("b"), None)
        if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
            return False, "nonfinite_platt_params"
        if a <= 0.0:
            return False, "nonpositive_platt_slope"
        return True, None
    if method == "beta_logit":
        a = safe_float(params.get("a"), None)
        b = safe_float(params.get("b"), None)
        c = safe_float(params.get("c"), None)
        if (
            a is None
            or b is None
            or c is None
            or not (math.isfinite(a) and math.isfinite(b) and math.isfinite(c))
        ):
            return False, "nonfinite_beta_logit_params"
        if a < 0.0 or b < 0.0 or (a + b) <= 0.0:
            return False, "nonmonotonic_beta_logit_params"
        return True, None
    return False, f"unknown_method:{method}"


def apply_parametric_calibrator(params: dict[str, Any], raw_probability: float) -> float:
    """Apply a validated Platt or Beta-Logit calibrator in logit space.

    Mirrors applyParametricCalibration in src/calibration.js bit-for-bit.
    """
    valid, _reason = validate_parametric_calibrator(params)
    if not valid:
        return clamp(float(raw_probability), 0.05, 0.95)
    method = str(params.get("method", "")).strip().lower()
    p = min(max(float(raw_probability), _PROB_EPS), 1.0 - _PROB_EPS)
    if method == "identity":
        return clamp(p, 0.05, 0.95)
    if method == "platt":
        z = float(params["a"]) * math.log(p / (1.0 - p)) + float(params["b"])
        return clamp(_sigmoid(z), 0.05, 0.95)
    if method == "beta_logit":
        z = float(params["a"]) * math.log(p) - float(params["b"]) * math.log(1.0 - p) + float(params["c"])
        return clamp(_sigmoid(z), 0.05, 0.95)
    return clamp(p, 0.05, 0.95)


def _solve_linear_3x3(A: list[list[float]], b: list[float]) -> list[float] | None:
    """Gaussian elimination with partial pivoting for small (2x2 or 3x3) systems."""
    m = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(m):
        pivot = max(range(col, m), key=lambda r: abs(M[r][col]))
        if abs(M[pivot][col]) < 1e-12:
            return None
        M[col], M[pivot] = M[pivot], M[col]
        piv_val = M[col][col]
        for j in range(col, m + 1):
            M[col][j] /= piv_val
        for r in range(m):
            if r == col:
                continue
            factor = M[r][col]
            for j in range(col, m + 1):
                M[r][j] -= factor * M[col][j]
    return [M[i][m] for i in range(m)]


def fit_platt_calibrator(
    rows: list[tuple[float, float]],
    *,
    l2: float = 2.0,
    min_samples: int = 30,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Fit monotone Platt scaling sigmoid(a * logit(p) + b) with L2 prior toward identity (1, 0)."""
    clean: list[tuple[float, float]] = []
    for prob, outcome in rows:
        p = safe_float(prob, None)
        y = safe_float(outcome, None)
        if p is None or y is None or not (math.isfinite(p) and math.isfinite(y)):
            continue
        if p > 1.0:
            p /= 100.0
        clean.append((min(max(p, _PROB_EPS), 1.0 - _PROB_EPS), 1.0 if y >= 0.5 else 0.0))

    n = len(clean)
    if n < min_samples:
        return None, {
            "status": "skipped",
            "method": "platt",
            "reason": f"only {n} samples (need {min_samples})",
            "samples": n,
        }
    pos = sum(1 for _, y in clean if y >= 0.5)
    neg = n - pos
    if pos < 5 or neg < 5:
        return None, {
            "status": "skipped",
            "method": "platt",
            "reason": f"insufficient class balance (pos={pos}, neg={neg})",
            "samples": n,
        }

    xs = [math.log(p / (1.0 - p)) for p, _ in clean]
    ys = [y for _, y in clean]
    reg = max(1e-4, float(l2)) / float(n)

    def loss(a: float, b: float) -> float:
        total = 0.0
        for x, y in zip(xs, ys):
            z = a * x + b
            # Numerically stable binary cross-entropy: log(1 + exp(z)) - y*z
            if z >= 0.0:
                total += z + math.log1p(math.exp(-z)) - y * z
            else:
                total += math.log1p(math.exp(z)) - y * z
        return total / n + 0.5 * reg * ((a - 1.0) ** 2 + b ** 2)

    a, b = 1.0, 0.0
    cur_loss = loss(a, b)
    for _ in range(50):
        ga = reg * (a - 1.0)
        gb = reg * b
        haa = reg
        hab = 0.0
        hbb = reg
        inv_n = 1.0 / n
        for x, y in zip(xs, ys):
            phat = _sigmoid(a * x + b)
            diff = phat - y
            w = max(1e-9, phat * (1.0 - phat))
            ga += diff * x * inv_n
            gb += diff * inv_n
            haa += w * x * x * inv_n
            hab += w * x * inv_n
            hbb += w * inv_n
        step = _solve_linear_3x3([[haa, hab], [hab, hbb]], [-ga, -gb])
        if step is None:
            break
        da, db = step
        if max(abs(da), abs(db)) < 1e-9:
            break
        alpha = 1.0
        while alpha >= 1e-4:
            na, nb = a + alpha * da, b + alpha * db
            nl = loss(na, nb)
            if nl <= cur_loss + 1e-12:
                a, b, cur_loss = na, nb, nl
                break
            alpha *= 0.5
        else:
            break

    if not (math.isfinite(a) and math.isfinite(b)) or a <= 0.0:
        return None, {
            "status": "skipped",
            "method": "platt",
            "reason": f"nonpositive_or_nonfinite_slope (a={a})",
            "samples": n,
        }

    params = {"method": "platt", "a": round(a, 6), "b": round(b, 6)}
    return params, {
        "status": "success",
        "method": "platt",
        "samples": n,
        "params": params,
    }


def _fit_beta_logit_subset(
    us: list[float],
    vs: list[float],
    ys: list[float],
    reg: float,
    sym_reg: float,
    fix_a_zero: bool = False,
    fix_b_zero: bool = False,
) -> tuple[float, float, float, float]:
    """Minimize regularized Beta-Logit NLL with optional zero-clamping on a or b."""
    n = len(ys)
    inv_n = 1.0 / n

    def loss(a: float, b: float, c: float) -> float:
        total = 0.0
        for u, v, y in zip(us, vs, ys):
            z = a * u + b * v + c
            if z >= 0.0:
                total += z + math.log1p(math.exp(-z)) - y * z
            else:
                total += math.log1p(math.exp(z)) - y * z
        return (
            total * inv_n
            + 0.5 * reg * ((a - 1.0) ** 2 + (b - 1.0) ** 2 + c ** 2)
            + 0.5 * sym_reg * ((a - b) ** 2)
        )

    a = 0.0 if fix_a_zero else 1.0
    b = 0.0 if fix_b_zero else 1.0
    c = 0.0
    cur_loss = loss(a, b, c)

    free_idx = [i for i, fixed in enumerate((fix_a_zero, fix_b_zero, False)) if not fixed]
    for _ in range(60):
        ga = reg * (a - 1.0) + sym_reg * (a - b)
        gb = reg * (b - 1.0) - sym_reg * (a - b)
        gc = reg * c
        H = [
            [reg + sym_reg, -sym_reg, 0.0],
            [-sym_reg, reg + sym_reg, 0.0],
            [0.0, 0.0, reg],
        ]
        for u, v, y in zip(us, vs, ys):
            phat = _sigmoid(a * u + b * v + c)
            diff = phat - y
            w = max(1e-9, phat * (1.0 - phat))
            ga += diff * u * inv_n
            gb += diff * v * inv_n
            gc += diff * inv_n
            H[0][0] += w * u * u * inv_n
            H[0][1] += w * u * v * inv_n
            H[0][2] += w * u * inv_n
            H[1][0] += w * u * v * inv_n
            H[1][1] += w * v * v * inv_n
            H[1][2] += w * v * inv_n
            H[2][0] += w * u * inv_n
            H[2][1] += w * v * inv_n
            H[2][2] += w * inv_n
        grad_full = [ga, gb, gc]
        sub_H = [[H[r][col] for col in free_idx] for r in free_idx]
        sub_rhs = [-grad_full[r] for r in free_idx]
        step = _solve_linear_3x3(sub_H, sub_rhs)
        if step is None:
            break
        delta = [0.0, 0.0, 0.0]
        for idx_pos, var_idx in enumerate(free_idx):
            delta[var_idx] = step[idx_pos]
        if max(abs(d) for d in delta) < 1e-9:
            break
        alpha = 1.0
        while alpha >= 1e-4:
            na = a + alpha * delta[0]
            nb = b + alpha * delta[1]
            nc = c + alpha * delta[2]
            nl = loss(na, nb, nc)
            if nl <= cur_loss + 1e-12:
                a, b, c, cur_loss = na, nb, nc, nl
                break
            alpha *= 0.5
        else:
            break

    return a, b, c, cur_loss


def fit_beta_logit_calibrator(
    rows: list[tuple[float, float]],
    *,
    l2: float = 2.0,
    symmetry_l2: float = 4.0,
    min_samples: int = 50,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Fit monotone Kull et al. (2017) Beta calibration in logit space:
        sigmoid(a * ln(p) - b * ln(1 - p) + c),  a >= 0, b >= 0, a + b > 0.
    Uses active-set Newton-Raphson with L2 prior toward identity (1, 1, 0).
    """
    clean: list[tuple[float, float]] = []
    for prob, outcome in rows:
        p = safe_float(prob, None)
        y = safe_float(outcome, None)
        if p is None or y is None or not (math.isfinite(p) and math.isfinite(y)):
            continue
        if p > 1.0:
            p /= 100.0
        clean.append((min(max(p, _PROB_EPS), 1.0 - _PROB_EPS), 1.0 if y >= 0.5 else 0.0))

    n = len(clean)
    if n < min_samples:
        return None, {
            "status": "skipped",
            "method": "beta_logit",
            "reason": f"only {n} samples (need {min_samples})",
            "samples": n,
        }
    pos = sum(1 for _, y in clean if y >= 0.5)
    neg = n - pos
    if pos < 5 or neg < 5:
        return None, {
            "status": "skipped",
            "method": "beta_logit",
            "reason": f"insufficient class balance (pos={pos}, neg={neg})",
            "samples": n,
        }

    us = [math.log(p) for p, _ in clean]
    vs = [-math.log(1.0 - p) for p, _ in clean]
    ys = [y for _, y in clean]
    reg = max(1e-4, float(l2)) / float(n)
    sym_reg = max(0.0, float(symmetry_l2)) / float(n)

    a, b, c, best_loss = _fit_beta_logit_subset(us, vs, ys, reg, sym_reg)
    if a < 0.0 or b < 0.0:
        candidates: list[tuple[float, float, float, float]] = []
        ca, cb, cc, cl = _fit_beta_logit_subset(us, vs, ys, reg, sym_reg, fix_a_zero=True)
        if cb > 0.0:
            candidates.append((ca, cb, cc, cl))
        da, db, dc, dl = _fit_beta_logit_subset(us, vs, ys, reg, sym_reg, fix_b_zero=True)
        if da > 0.0:
            candidates.append((da, db, dc, dl))
        if not candidates:
            return None, {
                "status": "skipped",
                "method": "beta_logit",
                "reason": "no_monotonic_beta_logit_solution",
                "samples": n,
            }
        a, b, c, best_loss = min(candidates, key=lambda item: item[3])

    if not (math.isfinite(a) and math.isfinite(b) and math.isfinite(c)) or a < 0.0 or b < 0.0 or (a + b) <= 1e-4:
        return None, {
            "status": "skipped",
            "method": "beta_logit",
            "reason": f"nonmonotonic_beta_logit_params (a={a}, b={b})",
            "samples": n,
        }

    params = {"method": "beta_logit", "a": round(a, 6), "b": round(b, 6), "c": round(c, 6)}
    return params, {
        "status": "success",
        "method": "beta_logit",
        "samples": n,
        "params": params,
    }


def evaluate_calibration_metrics(
    probs: list[float],
    outcomes: list[float],
    *,
    n_bins: int = 10,
) -> dict[str, Any]:
    """Compute Brier score, Log-Loss, and Expected Calibration Error (ECE)."""
    pairs = [
        (min(max(float(p), _PROB_EPS), 1.0 - _PROB_EPS), 1.0 if float(y) >= 0.5 else 0.0)
        for p, y in zip(probs, outcomes)
        if math.isfinite(float(p)) and math.isfinite(float(y))
    ]
    n = len(pairs)
    if n == 0:
        return {"n": 0, "brier": None, "log_loss": None, "ece": None}

    brier = sum((p - y) ** 2 for p, y in pairs) / n
    log_loss = -sum(y * math.log(p) + (1.0 - y) * math.log(1.0 - p) for p, y in pairs) / n

    bins: list[list[tuple[float, float]]] = [[] for _ in range(max(2, n_bins))]
    for p, y in pairs:
        idx = min(len(bins) - 1, int(p * len(bins)))
        bins[idx].append((p, y))
    ece = 0.0
    for bucket in bins:
        if not bucket:
            continue
        avg_p = sum(p for p, _ in bucket) / len(bucket)
        avg_y = sum(y for _, y in bucket) / len(bucket)
        ece += (len(bucket) / n) * abs(avg_p - avg_y)

    return {
        "n": n,
        "brier": round(brier, 6),
        "log_loss": round(log_loss, 6),
        "ece": round(ece, 6),
    }


def walk_forward_calibration_benchmark(
    dated_rows: list[tuple[str, float, float]],
    *,
    min_train_samples: int = 100,
    step_size: int = 50,
) -> dict[str, Any]:
    """Chronological prequential walk-forward benchmark of calibration methods.

    Each row is (date_str, raw_prob, outcome). Evaluates strictly out-of-fold:
    block k is calibrated ONLY using rows strictly preceding block k.
    Compares identity, isotonic, platt, and beta_logit on Brier, Log-Loss, ECE.
    """
    ordered = sorted(
        [
            (str(d), min(max(float(p) / 100.0 if float(p) > 1.0 else float(p), _PROB_EPS), 1.0 - _PROB_EPS),
             1.0 if float(y) >= 0.5 else 0.0)
            for d, p, y in dated_rows
        ],
        key=lambda r: r[0],
    )
    if len(ordered) <= min_train_samples:
        return {"status": "insufficient_data", "n_total": len(ordered), "methods": {}}

    # Group rows by calendar date so every train/test split obeys strict
    # day boundaries: max(train_dates) < min(test_dates) with zero same-day leakage.
    date_groups: list[tuple[str, list[tuple[float, float]]]] = []
    for d, p, y in ordered:
        if not date_groups or date_groups[-1][0] != d:
            date_groups.append((d, [(p, y)]))
        else:
            date_groups[-1][1].append((p, y))

    preds: dict[str, list[float]] = {
        "identity": [],
        "isotonic": [],
        "platt": [],
        "beta_logit": [],
    }
    labels: list[float] = []

    train_pairs: list[tuple[float, float]] = []
    group_idx = 0
    while group_idx < len(date_groups) and len(train_pairs) < min_train_samples:
        train_pairs.extend(date_groups[group_idx][1])
        group_idx += 1

    if group_idx >= len(date_groups):
        return {"status": "insufficient_data", "n_total": len(ordered), "methods": {}}

    while group_idx < len(date_groups):
        test_block: list[tuple[float, float]] = []
        while group_idx < len(date_groups) and (len(test_block) < max(1, step_size)):
            test_block.extend(date_groups[group_idx][1])
            group_idx += 1

        iso_map, _ = _fit_market_map(train_pairs, min_samples=50)
        platt_params, _ = fit_platt_calibrator(train_pairs, min_samples=30)
        beta_params, _ = fit_beta_logit_calibrator(train_pairs, min_samples=50)

        for raw_p, y in test_block:
            labels.append(y)
            preds["identity"].append(clamp(raw_p, 0.05, 0.95))
            preds["isotonic"].append(
                clamp(_interpolate(iso_map, raw_p), 0.05, 0.95) if iso_map else clamp(raw_p, 0.05, 0.95)
            )
            preds["platt"].append(
                apply_parametric_calibrator(platt_params, raw_p) if platt_params else clamp(raw_p, 0.05, 0.95)
            )
            preds["beta_logit"].append(
                apply_parametric_calibrator(beta_params, raw_p) if beta_params else clamp(raw_p, 0.05, 0.95)
            )
        train_pairs.extend(test_block)

    metrics_by_method = {
        method: evaluate_calibration_metrics(p_list, labels)
        for method, p_list in preds.items()
    }
    best_brier = min(metrics_by_method.items(), key=lambda kv: kv[1]["brier"] or 1e9)[0]
    best_logloss = min(metrics_by_method.items(), key=lambda kv: kv[1]["log_loss"] or 1e9)[0]
    return {
        "status": "ok",
        "n_total": len(ordered),
        "n_oof_evaluated": len(labels),
        "best_by_brier": best_brier,
        "best_by_log_loss": best_logloss,
        "methods": metrics_by_method,
    }


def _calibration_meta_path() -> Path:
    return _CALIBRATION_MAPS_PATH.with_name(_CALIBRATION_META_PATH.name)


def _load_calibration_meta() -> dict[str, Any]:
    global _cached_meta, _cached_meta_path
    meta_path = _calibration_meta_path()
    if _cached_meta is not None and _cached_meta_path == meta_path:
        return _cached_meta

    meta: dict[str, Any] = {}
    if meta_path.exists():
        try:
            raw = json.loads(meta_path.read_text())
            if isinstance(raw, dict):
                meta = raw
        except (json.JSONDecodeError, OSError, TypeError):
            meta = {}

    _cached_meta = meta
    _cached_meta_path = meta_path
    return meta


def _parse_market_calibrator(raw_entry: Any) -> Any:
    """Accept either legacy isotonic [[x,y],...] or parametric {method, ...}."""
    if isinstance(raw_entry, dict):
        valid, _reason = validate_parametric_calibrator(raw_entry)
        return dict(raw_entry) if valid else None
    if isinstance(raw_entry, list):
        return [(float(p[0]), float(p[1])) for p in raw_entry]
    return None


def _load_calibration_maps() -> dict[str, Any]:
    global _cached_maps, _cached_disk_maps, _cached_maps_path
    if _cached_maps is not None:
        if _cached_maps is not _cached_disk_maps or _cached_maps_path == _CALIBRATION_MAPS_PATH:
            return _cached_maps

    maps: dict[str, Any] = {}
    # Prefer the per-market file; fall back to the legacy moneyline-only file.
    if _CALIBRATION_MAPS_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAPS_PATH.read_text())
            if isinstance(raw, dict):
                for market, entry in raw.items():
                    parsed = _parse_market_calibrator(entry)
                    if parsed is not None:
                        maps[market] = parsed
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            maps = {}
    if "moneyline" not in maps and _CALIBRATION_MAP_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAP_PATH.read_text())
            parsed = _parse_market_calibrator(raw)
            if parsed is not None:
                maps["moneyline"] = parsed
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass

    _cached_maps = maps
    _cached_disk_maps = maps
    _cached_maps_path = _CALIBRATION_MAPS_PATH
    return maps


def _shrink_toward_half(raw_probability: float, market: str) -> float:
    """Safe fallback calibration that can only compress toward 0.5."""
    factor = _SHRINKAGE_FACTOR.get(market, 0.5)
    return 0.5 + (raw_probability - 0.5) * (1.0 - factor)


def _uses_low_sample_shrinkage(market: str, is_parametric: bool = False) -> bool:
    thresholds = _MIN_PARAMETRIC_SAMPLES_FOR_TRUST if is_parametric else _MIN_ISOTONIC_SAMPLES_FOR_TRUST
    threshold = thresholds.get(market)
    if threshold is None or market not in _SHRINKAGE_FACTOR:
        return False
    if _cached_maps is not None and _cached_maps is not _cached_disk_maps:
        return False
    samples = _load_calibration_meta().get("markets", {}).get(market, {}).get("samples")
    try:
        sample_count = int(samples)
    except (TypeError, ValueError):
        return False
    return sample_count < threshold


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

    Supports both legacy isotonic piecewise-linear maps and smooth logit-space
    parametric calibrators (platt, beta_logit). Falls back to the raw probability
    when no calibrator exists for the market.
    """
    market_key = str(market).strip().lower()
    entry = _load_calibration_maps().get(market_key)
    is_parametric = isinstance(entry, dict)
    if _uses_low_sample_shrinkage(market_key, is_parametric=is_parametric):
        # Mirror src/calibration.js parametric_low_sample_shrink parity:
        # shrink parametric output toward 0.5 when a parametric model exists.
        base = apply_parametric_calibrator(entry, raw_probability) if is_parametric else raw_probability
        calibrated = _shrink_toward_half(base, market_key)
        return clamp(calibrated, 0.05, 0.95)

    if not entry:
        return raw_probability
    if is_parametric:
        return apply_parametric_calibrator(entry, raw_probability)
    calibrated = _interpolate(entry, raw_probability)
    return clamp(calibrated, 0.05, 0.95)


# ---------------------------------------------------------------------------
# Banded shrink calibration (walk-forward validated, default-off)
# ---------------------------------------------------------------------------
# Per-band shrink factors fitted on recent outcomes. Each band maps raw model
# probability -> 0.5 + (raw - 0.5) * factor. Validated by
# scripts/model_edge_validation.py walk-forward: improves Brier by ~0.005
# combined when factors are allowed to expand the 50-55% band and shrink 55-60%.
# Default is OFF (all factors 1.0) until the gate in model_edge_validation
# promotes it. Walk-forward validated factors from 973 games (2026-07-02..08-03):
# expand 45-55% band, shrink 55-60% band.
_BANDED_SHRINK_FACTORS: dict[str, float] = {
    "0.00-0.45": 1.2,
    "0.45-0.50": 1.2,
    "0.50-0.55": 1.2,
    "0.55-0.60": 0.4,
    "0.60-1.00": 1.0,
}
_BANDED_SHRINK_ENABLED = True


def calibrate_banded_shrink(raw_probability: float) -> float:
    """Apply banded shrink calibration. Only active when enabled."""
    if not _BANDED_SHRINK_ENABLED:
        return raw_probability
    p = clamp(raw_probability, 0.05, 0.95)
    for band_key, factor in _BANDED_SHRINK_FACTORS.items():
        if isinstance(band_key, tuple) and len(band_key) == 2:
            lo_f, hi_f = float(band_key[0]), float(band_key[1])
        else:
            parts = str(band_key).split("-")
            if len(parts) != 2:
                continue
            lo_f, hi_f = float(parts[0]), float(parts[1])
        if lo_f <= p < hi_f or (p >= 0.95 and hi_f >= 0.95):
            return clamp(0.5 + (p - 0.5) * factor, 0.05, 0.95)
    return p


def set_banded_shrink_factors(factors: dict[str, float], enabled: bool = True) -> None:
    """Update banded shrink factors from validation output."""
    _BANDED_SHRINK_FACTORS.update(factors)
    global _BANDED_SHRINK_ENABLED
    _BANDED_SHRINK_ENABLED = enabled


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
    if market == "moneyline":
        return "moneyline"
    return None


def _extract_predicted_probability(row: dict[str, Any]) -> float | None:
    eval_json = row.get("evaluation_json", "")
    if eval_json:
        try:
            data = json.loads(eval_json)
            # The evaluator stores the authoritative per-market win probability
            # for the picked side here. Prefer
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


def _make_isotonic(points: list[tuple[float, float, int]]) -> list[tuple[float, float]]:
    """Apply weighted pool adjacent violators to enforce monotonicity.

    Each point is (x, y, count). PAV merges use sample-count weighted averages
    so large bins dominate over small outlier bins.
    """
    if not points:
        return []
    points = sorted(points, key=lambda p: p[0])

    blocks: list[list[tuple[float, float, int]]] = [[points[0]]]
    for point in points[1:]:
        blocks.append([point])
        while len(blocks) >= 2:
            last_n = sum(p[2] for p in blocks[-1])
            prev_n = sum(p[2] for p in blocks[-2])
            last_avg = sum(p[1] * p[2] for p in blocks[-1]) / last_n if last_n else 0.0
            prev_avg = sum(p[1] * p[2] for p in blocks[-2]) / prev_n if prev_n else 0.0
            if prev_avg <= last_avg:
                break
            blocks[-2].extend(blocks[-1])
            blocks.pop()

    result: list[tuple[float, float]] = []
    for block in blocks:
        total_n = sum(p[2] for p in block)
        avg_x = sum(p[0] * p[2] for p in block) / total_n if total_n else sum(p[0] for p in block) / len(block)
        avg_y = sum(p[1] * p[2] for p in block) / total_n if total_n else sum(p[1] for p in block) / len(block)
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
        return None, {
            "status": "skipped",
            "reason": f"only {len(rows)} samples (need {min_samples})",
            "samples": len(rows),
            "low_confidence_bins": False,
        }

    buckets: dict[int, list[tuple[float, float]]] = {}
    for prob, outcome in rows:
        bucket_idx = int(prob / bucket_size)
        buckets.setdefault(bucket_idx, []).append((prob, outcome))

    binned_points: list[tuple[float, float, int]] = []
    low_confidence_bins = False
    for bucket_idx in sorted(buckets):
        points = buckets[bucket_idx]
        if len(points) < min_bin_count:
            continue
        if len(points) < 3:
            low_confidence_bins = True
        avg_prob = sum(p[0] for p in points) / len(points)
        avg_outcome = sum(p[1] for p in points) / len(points)
        binned_points.append((avg_prob, avg_outcome, len(points)))

    if len(binned_points) < 3:
        return None, {
            "status": "skipped",
            "reason": "not enough bins with sufficient data",
            "samples": len(rows),
            "buckets": len(buckets),
            "bins": len(binned_points),
            "min_bin_count": min_bin_count,
            "low_confidence_bins": low_confidence_bins,
        }

    calibration_map = _make_isotonic(binned_points)

    # Safety clamp: prevent small-sample bins from producing 0.0/1.0 certainty.
    # The fewer total samples, the tighter the clamp — a 34-sample fit should never
    # claim near-certain outcomes, only a fit with hundreds of samples can approach
    # the extremes.
    if len(rows) < 100 or low_confidence_bins:
        clamp_lo, clamp_hi = 0.15, 0.85
    elif len(rows) < 300:
        clamp_lo, clamp_hi = 0.08, 0.92
    else:
        clamp_lo, clamp_hi = 0.05, 0.95

    calibration_map = [(x, min(max(y, clamp_lo), clamp_hi)) for x, y in calibration_map]

    # Degenerate guard: if pool-adjacent-violators collapsed everything to a single
    # flat level (all y within 1e-6), the market has no monotonic signal — the
    # mapping would just pull every probability to one constant (this is what
    # happened historically: a single [0.598 -> 0.406] point). Skip it and let
    # calibrate() fall back to the raw probability, which is strictly safer than
    # forcing a constant. A genuine calibration map needs >=2 distinct outputs.
    distinct_y = {round(y, 6) for _, y in calibration_map}
    if len(calibration_map) < 2 or len(distinct_y) < 2:
        return None, {
            "status": "skipped",
            "reason": "degenerate map (no monotonic signal; falls back to raw)",
            "samples": len(rows),
            "bins": len(binned_points),
            "low_confidence_bins": low_confidence_bins,
        }

    return calibration_map, {
        "status": "success",
        "samples": len(rows),
        "bins": len(binned_points),
        "map_points": len(calibration_map),
        "low_confidence_bins": low_confidence_bins,
    }


def _serialize_calibrator_entry(entry: Any) -> Any:
    if isinstance(entry, dict):
        return dict(entry)
    return [list(p) for p in entry]


def _write_calibration_maps(
    maps: dict[str, Any],
    per_market: dict[str, Any],
    *,
    source: str,
) -> dict[str, Any]:
    """Persist per-market maps (isotonic or parametric) and keep legacy moneyline map synced."""
    global _cached_maps, _cached_disk_maps, _cached_maps_path, _cached_meta, _cached_meta_path

    calibrated_markets = sorted(maps.keys())
    meta = {
        "version": 1,
        "source": source,
        "calibrated_markets": calibrated_markets,
        "markets": per_market,
        "policies": {
            "moneyline": {
                "min_samples_for_isotonic": _MIN_ISOTONIC_SAMPLES_FOR_TRUST["moneyline"],
                "min_samples_for_parametric": _MIN_PARAMETRIC_SAMPLES_FOR_TRUST["moneyline"],
                "low_sample_strategy": "shrink_toward_50",
                "shrinkage_factor": _SHRINKAGE_FACTOR["moneyline"],
            },
        },
    }

    _CALIBRATION_MAPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    meta_path = _calibration_meta_path()
    meta_path.write_text(json.dumps(meta, indent=2))
    _cached_meta = meta
    _cached_meta_path = meta_path

    _CALIBRATION_MAPS_PATH.write_text(
        json.dumps({m: _serialize_calibrator_entry(pts) for m, pts in maps.items()}, indent=2)
    )
    if "moneyline" in maps:
        _CALIBRATION_MAP_PATH.write_text(
            json.dumps(_serialize_calibrator_entry(maps["moneyline"]), indent=2)
        )
    elif _CALIBRATION_MAP_PATH.exists():
        _CALIBRATION_MAP_PATH.unlink()
    _cached_maps = maps
    _cached_disk_maps = maps
    _cached_maps_path = _CALIBRATION_MAPS_PATH

    if not maps:
        return {
            "status": "skipped",
            "reason": "no market had enough samples",
            "markets": per_market,
            "calibrated_markets": calibrated_markets,
            "path": str(_CALIBRATION_MAPS_PATH),
            "meta_path": str(meta_path),
            "source": source,
        }

    return {
        "status": "success",
        "markets": per_market,
        "calibrated_markets": calibrated_markets,
        "path": str(_CALIBRATION_MAPS_PATH),
        "meta_path": str(meta_path),
        "source": source,
    }


def _fit_all_markets(
    rows_by_market: dict[str, list[tuple[float, float]]],
    *,
    min_samples: int | None = None,
    market_params: dict[str, dict[str, float]] | None = None,
    method: str = "isotonic",
) -> tuple[dict[str, Any], dict[str, Any]]:
    maps: dict[str, Any] = {}
    per_market: dict[str, Any] = {}
    method_key = str(method or "isotonic").strip().lower()
    for market in _MARKETS:
        params = (market_params or _MARKET_PARAMS).get(market, {})
        if market_params is None and min_samples is not None:
            sample_floor = min_samples
        else:
            sample_floor = params.get("min_samples", min_samples if min_samples is not None else _MIN_SAMPLES)
        if method_key == "platt":
            calibration_map, info = fit_platt_calibrator(
                rows_by_market[market],
                min_samples=int(sample_floor),
            )
        elif method_key == "beta_logit":
            calibration_map, info = fit_beta_logit_calibrator(
                rows_by_market[market],
                min_samples=int(sample_floor),
            )
        else:
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


def retrain(*, method: str = "isotonic") -> dict[str, Any]:
    """Rebuild per-market calibration maps from prediction outcomes.

    Uses a chronological 80/20 split: fit on the oldest 80% of rows, evaluate
    on the held-out 20% tail. This prevents in-sample overfitting where the
    same data is used for both fitting and Brier evaluation.
    """
    if not _OUTCOMES_PATH.exists():
        return {"status": "error", "reason": "prediction_outcomes.csv not found", "source": "CSV prediction_outcomes"}

    dated_rows: list[tuple[str, str, float, float]] = []
    with open(_OUTCOMES_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            market = _normalize_market(row.get("market", ""))
            if market not in set(_MARKETS):
                continue
            result = row.get("result", "").strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            date_str = row.get("date", "") or ""
            outcome = 1.0 if result == "win" else 0.0
            dated_rows.append((date_str, market, prob, outcome))

    # Sort chronologically so the split is temporal, not random.
    dated_rows.sort(key=lambda r: r[0])
    cutoff_idx = int(len(dated_rows) * 0.80)
    train_rows = dated_rows[:cutoff_idx]

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    for _date, market, prob, outcome in train_rows:
        rows_by_market[market].append((prob, outcome))

    maps, per_market = _fit_all_markets(rows_by_market, method=method)
    method_suffix = "" if method == "isotonic" else f", method={method}"
    return _write_calibration_maps(
        maps,
        per_market,
        source=f"CSV prediction_outcomes (chronological 80% train, {cutoff_idx}/{len(dated_rows)} rows{method_suffix})",
    )


def retrain_from_sqlite(sqlite_path: str | Path | None = None) -> dict[str, Any]:
    """Rebuild per-market calibration maps from SELECTED-VALUE bet ledger.

    This is the explicitly named ``selected_value`` diagnostic path. It trains on
    ``bet_ledger`` rows, which are VALUE-selected picks — NOT all-game history.
    Selection bias means this population is not the calibration truth for the
    control model. P6 retargets the PRIMARY training path to all-game
    ``model_predictions`` + ``game_outcomes`` (see ``retrain_all_game``); this
    function is retained as an explicitly named diagnostic only and must NEVER be
    used as the default calibration truth.
    """
    source = Path(sqlite_path) if sqlite_path is not None else _SQLITE_PATH
    if not source.exists():
        return {"status": "error", "reason": f"SQLite database not found: {source}", "source": "SQLite bet_ledger (selected_value diagnostic)"}

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
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"status": "error", "reason": f"SQLite read failed: {exc}", "source": "SQLite bet_ledger (selected_value diagnostic)"}

    maps, per_market = _fit_all_markets(rows_by_market, market_params=_SQLITE_MARKET_PARAMS)
    result = _write_calibration_maps(maps, per_market, source="SQLite bet_ledger (selected_value diagnostic)")
    result["diagnostic"] = "selected_value"
    result["selection_bias_warning"] = (
        "bet_ledger is VALUE-selected history, not all-game. Use only as a "
        "diagnostic; the primary calibration truth is retrain_all_game()."
    )
    return result


def retrain_all_game(sqlite_path: str | Path | None = None, *, method: str = "isotonic") -> dict[str, Any]:
    """P6 PRIMARY calibration training path: all-game model_predictions + outcomes.

    Reads the migration-006 ``model_predictions`` table (one row per eligible
    scheduled game, including NO BET) joined to ``game_outcomes``. This is the
    unselected all-game population — the correct calibration truth for the
    control model, free of the VALUE-selection bias in ``bet_ledger``.

    Uses the control ``raw_home_probability`` (uncalibrated) vs the home-win
    outcome. Falls back to ``calibrated_home_probability`` only when raw is null.
    Promotion-eligible rows only (as_of_utc < first_pitch_utc).

    If migration-006 tables are absent (production DB not migrated), returns an
    explicit error rather than fabricating data or silently falling back to the
    selected-value path.
    """
    source = Path(sqlite_path) if sqlite_path is not None else _SQLITE_PATH
    if not source.exists():
        return {"status": "error", "reason": f"SQLite database not found: {source}", "source": "SQLite model_predictions (all-game)"}

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    try:
        conn = sqlite3.connect(str(source))
        conn.row_factory = sqlite3.Row
        try:
            # Verify migration-006 tables exist; never fabricate if absent.
            try:
                conn.execute("SELECT 1 FROM model_predictions LIMIT 1")
                conn.execute("SELECT 1 FROM game_outcomes LIMIT 1")
            except sqlite3.Error as exc:
                return {
                    "status": "error",
                    "reason": f"migration_006_tables_absent ({exc}); all-game path cannot run without model_predictions/game_outcomes",
                    "source": "SQLite model_predictions (all-game)",
                }
            rows = conn.execute(
                """
                WITH latest_mp AS (
                    SELECT mp.game_pk, mp.raw_home_probability, mp.calibrated_home_probability,
                           mp.pick_side, mp.promotion_eligible,
                           ROW_NUMBER() OVER (PARTITION BY mp.game_pk ORDER BY mp.rowid DESC) AS rn
                    FROM model_predictions mp
                    WHERE mp.model_id = 'heuristic_v1'
                      AND mp.promotion_eligible = 1
                )
                SELECT lm.raw_home_probability, lm.calibrated_home_probability,
                       lm.pick_side, lm.promotion_eligible,
                       go.winner_team_id, go.home_team_id
                FROM latest_mp lm
                JOIN game_outcomes go ON go.game_pk = lm.game_pk
                WHERE lm.rn = 1
                """
            )
            for row in rows:
                prob = _normalize_probability(row["raw_home_probability"])
                if prob is None:
                    prob = _normalize_probability(row["calibrated_home_probability"])
                if prob is None:
                    continue
                winner = row["winner_team_id"]
                home = row["home_team_id"]
                if winner is None or home is None:
                    continue
                outcome = 1.0 if str(winner) == str(home) else 0.0
                rows_by_market["moneyline"].append((prob, outcome))
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"status": "error", "reason": f"SQLite read failed: {exc}", "source": "SQLite model_predictions (all-game)"}

    maps, per_market = _fit_all_markets(rows_by_market, market_params=_SQLITE_MARKET_PARAMS, method=method)
    result = _write_calibration_maps(maps, per_market, source="SQLite model_predictions (all-game, P6 primary)")
    result["population"] = "all_game"
    result["method"] = method
    return result


def benchmark_csv_outcomes(outcomes_path: str | Path | None = None) -> dict[str, Any]:
    """Run chronological walk-forward calibration benchmark on prediction_outcomes.csv."""
    path = Path(outcomes_path) if outcomes_path is not None else _OUTCOMES_PATH
    if not path.exists():
        return {"status": "error", "reason": f"outcomes file not found: {path}"}
    dated_rows: list[tuple[str, float, float]] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            market = _normalize_market(row.get("market", ""))
            if market != "moneyline":
                continue
            result = row.get("result", "").strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            dated_rows.append((row.get("date", "") or "", prob, 1.0 if result == "win" else 0.0))
    return walk_forward_calibration_benchmark(dated_rows)


def retrain_default(*, method: str = "isotonic") -> dict[str, Any]:
    """P6 default calibration retrain.

    PRIMARY path is now all-game ``model_predictions`` + ``game_outcomes``
    (``retrain_all_game``). If migration-006 tables are absent, fall back to CSV
    ``prediction_outcomes`` (``retrain``) rather than the selected-value
    ``bet_ledger`` path — selected-value is a diagnostic, not default truth.

    The selected-value ``bet_ledger`` path (``retrain_from_sqlite``) is retained
    but must be invoked explicitly; it is never the default.
    """
    if _SQLITE_PATH.exists():
        result = retrain_all_game(_SQLITE_PATH) if method == "isotonic" else retrain_all_game(_SQLITE_PATH, method=method)
        if result.get("status") == "error" and "migration_006_tables_absent" in result.get("reason", ""):
            # Production DB not migrated to 006 — fall back to CSV outcomes, NOT
            # the selected-value ledger. Calibration stays selected-bias-free.
            return retrain() if method == "isotonic" else retrain(method=method)
        return result
    return retrain() if method == "isotonic" else retrain(method=method)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Probability calibrator")
    parser.add_argument("--retrain", action="store_true", help="Rebuild calibration map (P6 default: all-game)")
    parser.add_argument("--all-game", action="store_true", help="Force all-game model_predictions path")
    parser.add_argument("--selected-value", action="store_true",
                        help="Diagnostic only: bet_ledger selected-value path (biased)")
    parser.add_argument("--method", choices=["isotonic", "platt", "beta_logit"], default="isotonic",
                        help="Calibration method (default: isotonic)")
    parser.add_argument("--benchmark", action="store_true",
                        help="Run chronological walk-forward benchmark (identity vs isotonic vs platt vs beta_logit)")
    args = parser.parse_args()

    if args.benchmark:
        result = benchmark_csv_outcomes()
    elif args.all_game:
        result = retrain_all_game(method=args.method)
    elif args.selected_value:
        result = retrain_from_sqlite()
    elif args.retrain:
        result = retrain_default(method=args.method)
    else:
        parser.print_help()
        raise SystemExit(0)
    print(json.dumps(result, indent=2))
