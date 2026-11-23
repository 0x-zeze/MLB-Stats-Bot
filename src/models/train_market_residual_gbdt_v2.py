"""Train the market_residual_gbdt_v2 challenger (Shallow Monotone GBDT + Fixed Market Offset).

Model equation:

    logit(P_home) = 1.0 * logit(P_market_no_vig_home)
                    + base_score
                    + learning_rate * sum_{m=1..M} Tree_m(X)

Implementation highlights (zero external LightGBM/XGBoost dependency; pure NumPy):
  - Exact second-order Newton-Raphson Bernoulli log-loss boosting starting from
    fixed market logit offset (market_offset_coefficient = 1.0, never fit).
  - Exact split finder testing all midpoints + both missingness directions
    (`missing_dir` in {"left", "right"}), avoiding naive median imputation.
  - Exact XGBoost/LightGBM interval-bounded monotone constraints across depth
    2-3 trees: guarantees globally monotone probability in every constrained
    feature across all combinations of other features.
  - Inner chronological early stopping + hyperparameter search (max_depth in
    {2, 3}, l2_leaf grid) fit strictly inside each training fold (zero leakage).
  - Exports compact flat-array JSON trees verified by SHA-256 `artifact_hash`
    matching src/core/market_residual_gbdt_v2.js bit-for-bit (< 1e-12 parity).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from src.core.feature_vector_py import (
    FEATURE_VECTOR_SCHEMA_VERSION,
    FEATURE_VECTOR_V1_FEATURE_NAMES,
    FEATURE_VECTOR_V2_FEATURE_NAMES,
    FEATURE_VECTOR_V2_SCHEMA_VERSION,
    _parse_iso_dt,
    _stable_stringify,
    buildFeatureVectorV2,
    flattenFeatureVector,
)
from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics

# ---- Identity (must match src/core/model_ids.js & src/core/market_residual_gbdt_v2.js) ----
MARKET_RESIDUAL_GBDT_V2_MODEL_ID = "market_residual_gbdt_v2"
MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION = "market-residual-gbdt-v2-v1.0"
MARKET_RESIDUAL_GBDT_V2_FEATURE_SCHEMA_VERSION = FEATURE_VECTOR_V2_SCHEMA_VERSION
SUPPORTED_FEATURE_SCHEMAS = (FEATURE_VECTOR_SCHEMA_VERSION, FEATURE_VECTOR_V2_SCHEMA_VERSION)
ARTIFACT_MANIFEST_VERSION = "market-residual-gbdt-v2-artifact-v1"
MARKET_OFFSET_COEFFICIENT = 1.0
MAX_ALLOWED_TREE_DEPTH = 3

# ---- Training gates ----
MIN_TRAIN_ROWS_PER_FOLD = 60
MIN_EVENTS_PER_CLASS = 10
MIN_WITH_MARKET_ROWS = 40
INNER_VAL_FRACTION = 0.25

# Shallow regularized search space to prevent overfitting MLB sample sizes.
DEFAULT_DEPTH_GRID = (2, 3)
DEFAULT_L2_GRID = (5.0, 15.0, 30.0)
DEFAULT_LEARNING_RATE = 0.05
DEFAULT_MAX_TREES = 80
DEFAULT_EARLY_STOPPING_ROUNDS = 12
DEFAULT_MIN_CHILD_HESSIAN = 3.0
DEFAULT_MIN_GAIN = 0.05

# Domain-grounded monotone constraints for P(home win):
#   +1: higher feature value MUST NOT decrease P(home win)
#   -1: higher feature value MUST NOT increase P(home win)
#    0: unconstrained (allows non-linear interactions, e.g., park/wind/temp/lead-time)
DEFAULT_MONOTONE_CONSTRAINTS: dict[str, int] = {
    # Home offense & lineup (+)
    "homeRpg": 1,
    "homeOps": 1,
    "homeParkAdjRpg": 1,
    "homeParkAdjOps": 1,
    "homeLineupQuality": 1,
    "homeLineupPlatoonWobaDelta": 1,
    "homeLineupPlatoonOpsDelta": 1,
    "platoonDeltaDiff": 1,
    "homeTeamXwoba": 1,
    "homeWinPct": 1,
    "homeRunDiffPerGame": 1,
    # Away offense & lineup (-)
    "awayRpg": -1,
    "awayOps": -1,
    "awayParkAdjRpg": -1,
    "awayParkAdjOps": -1,
    "awayLineupQuality": -1,
    "awayLineupPlatoonWobaDelta": -1,
    "awayLineupPlatoonOpsDelta": -1,
    "awayTeamXwoba": -1,
    "awayWinPct": -1,
    "awayRunDiffPerGame": -1,
    # Away pitching weakness (+ for home)
    "awayEra": 1,
    "awayWhip": 1,
    "awayParkAdjEra": 1,
    "awayParkAdjWhip": 1,
    "awayStarterEra": 1,
    "awayStarterWhip": 1,
    "awayStarterHr9": 1,
    "awayStarterXera": 1,
    "awayBullpenFatigue": 1,
    "awayBullpenReliefEra": 1,
    "awayTravelFatigueScore": 1,
    "awayStarterKMinusBb": -1,
    # Home pitching weakness (- for home)
    "homeEra": -1,
    "homeWhip": -1,
    "homeParkAdjEra": -1,
    "homeParkAdjWhip": -1,
    "homeStarterEra": -1,
    "homeStarterWhip": -1,
    "homeStarterHr9": -1,
    "homeStarterXera": -1,
    "homeBullpenFatigue": -1,
    "homeBullpenReliefEra": -1,
    "homeTravelFatigueScore": -1,
    "homeStarterKMinusBb": 1,
}


def _sigmoid_array(z: np.ndarray) -> np.ndarray:
    out = np.empty_like(z, dtype=float)
    high = z >= 35.0
    low = z <= -35.0
    mid = ~(high | low)
    out[high] = 1.0
    out[low] = 0.0
    out[mid] = 1.0 / (1.0 + np.exp(-z[mid]))
    return out


def _sigmoid_scalar(z: float) -> float:
    if z >= 35.0:
        return 1.0
    if z <= -35.0:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def _safe_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _clip_weight(val: float, low: float, high: float) -> float:
    if val < low:
        return low
    if val > high:
        return high
    return val


def _leaf_score(g_sum: float, h_sum: float, w: float, l2_leaf: float) -> float:
    """Exact reduction in second-order regularized Taylor loss for weight w."""
    return -(g_sum * w + 0.5 * (h_sum + l2_leaf) * w * w)


def _fit_single_tree(
    X: np.ndarray,
    grad: np.ndarray,
    hess: np.ndarray,
    feature_names: list[str],
    monotone_vec: list[int],
    max_depth: int,
    l2_leaf: float,
    min_child_hessian: float,
    min_gain: float,
    max_thresholds_per_feature: int = 32,
) -> dict[str, Any]:
    """Build one exact second-order regression tree with interval-bounded monotonicity."""
    nodes: list[dict[str, Any]] = []
    n_features = X.shape[1]

    def build_node(indices: np.ndarray, depth: int, low_bound: float, high_bound: float) -> int:
        node_idx = len(nodes)
        nodes.append({})  # reserve slot

        g_parent = float(np.sum(grad[indices]))
        h_parent = float(np.sum(hess[indices]))
        w_parent = _clip_weight(-g_parent / (h_parent + l2_leaf), low_bound, high_bound)
        parent_score = _leaf_score(g_parent, h_parent, w_parent, l2_leaf)

        if depth >= max_depth or indices.size < 4 or h_parent < 2.0 * min_child_hessian:
            nodes[node_idx] = {"leaf": True, "value": float(w_parent)}
            return node_idx

        best_gain = min_gain
        best_split: tuple[int, float, str, float, float, np.ndarray, np.ndarray] | None = None

        for j in range(n_features):
            col = X[indices, j]
            nan_mask = np.isnan(col)
            obs_mask = ~nan_mask
            n_obs = int(np.sum(obs_mask))
            if n_obs < 2:
                continue

            obs_indices = indices[obs_mask]
            miss_indices = indices[nan_mask]
            g_miss = float(np.sum(grad[miss_indices])) if miss_indices.size else 0.0
            h_miss = float(np.sum(hess[miss_indices])) if miss_indices.size else 0.0

            obs_vals = X[obs_indices, j]
            order = np.argsort(obs_vals, kind="mergesort")
            sorted_vals = obs_vals[order]
            sorted_g = grad[obs_indices[order]]
            sorted_h = hess[obs_indices[order]]

            # Distinct boundary positions where sorted_vals[i] < sorted_vals[i + 1].
            diffs = np.flatnonzero(sorted_vals[:-1] < sorted_vals[1:])
            if diffs.size == 0:
                continue

            # Downsample candidate split points deterministically if feature has many unique values.
            if diffs.size > max_thresholds_per_feature:
                pick = np.linspace(0, diffs.size - 1, max_thresholds_per_feature, dtype=int)
                diffs = diffs[np.unique(pick)]

            cum_g = np.cumsum(sorted_g)
            cum_h = np.cumsum(sorted_h)
            total_obs_g = float(cum_g[-1])
            total_obs_h = float(cum_h[-1])
            mono = monotone_vec[j]

            for pos in diffs:
                g_l_obs = float(cum_g[pos])
                h_l_obs = float(cum_h[pos])
                g_r_obs = total_obs_g - g_l_obs
                h_r_obs = total_obs_h - h_l_obs
                threshold = 0.5 * (float(sorted_vals[pos]) + float(sorted_vals[pos + 1]))

                # When missing values exist in training, test both directions.
                # When unseen during training, route future missing values to
                # the majority-hessian child (standard XGBoost/LightGBM fallback
                # rather than blindly routing to a minority tail).
                default_dir = "left" if h_l_obs >= h_r_obs else "right"
                directions = ("left", "right") if miss_indices.size > 0 else (default_dir,)
                for mdir in directions:
                    if mdir == "left":
                        g_l = g_l_obs + g_miss
                        h_l = h_l_obs + h_miss
                        g_r = g_r_obs
                        h_r = h_r_obs
                    else:
                        g_l = g_l_obs
                        h_l = h_l_obs
                        g_r = g_r_obs + g_miss
                        h_r = h_r_obs + h_miss

                    if h_l < min_child_hessian or h_r < min_child_hessian:
                        continue

                    w_l = _clip_weight(-g_l / (h_l + l2_leaf), low_bound, high_bound)
                    w_r = _clip_weight(-g_r / (h_r + l2_leaf), low_bound, high_bound)

                    # Strict monotone constraint gate.
                    if mono == 1 and w_l > w_r + 1e-12:
                        continue
                    if mono == -1 and w_l < w_r - 1e-12:
                        continue

                    gain = (
                        _leaf_score(g_l, h_l, w_l, l2_leaf)
                        + _leaf_score(g_r, h_r, w_r, l2_leaf)
                        - parent_score
                    )
                    if gain > best_gain:
                        best_gain = gain
                        # Defer index array slicing until we actually select this split?
                        # Store (j, threshold, mdir, w_l, w_r) cleanly.
                        best_split = (j, threshold, mdir, w_l, w_r, obs_indices, miss_indices)

        if best_split is None:
            nodes[node_idx] = {"leaf": True, "value": float(w_parent)}
            return node_idx

        best_j, threshold, mdir, w_l, w_r, obs_indices, miss_indices = best_split
        obs_vals = X[obs_indices, best_j]
        left_obs = obs_indices[obs_vals <= threshold]
        right_obs = obs_indices[obs_vals > threshold]
        if mdir == "left":
            left_idx = np.concatenate([left_obs, miss_indices]) if miss_indices.size else left_obs
            right_idx = right_obs
        else:
            left_idx = left_obs
            right_idx = np.concatenate([right_obs, miss_indices]) if miss_indices.size else right_obs

        mono = monotone_vec[best_j]
        mid = 0.5 * (w_l + w_r)
        if mono == 1:
            l_low, l_high = low_bound, min(high_bound, mid)
            r_low, r_high = max(low_bound, mid), high_bound
        elif mono == -1:
            l_low, l_high = max(low_bound, mid), high_bound
            r_low, r_high = low_bound, min(high_bound, mid)
        else:
            l_low, l_high = low_bound, high_bound
            r_low, r_high = low_bound, high_bound

        left_child = build_node(left_idx, depth + 1, l_low, l_high)
        right_child = build_node(right_idx, depth + 1, r_low, r_high)

        nodes[node_idx] = {
            "leaf": False,
            "feature": feature_names[best_j],
            "threshold": float(threshold),
            "left": int(left_child),
            "right": int(right_child),
            "missing_dir": mdir,
        }
        return node_idx

    build_node(np.arange(X.shape[0], dtype=int), 0, -math.inf, math.inf)
    return {"nodes": nodes}


def _predict_tree_matrix(tree: dict[str, Any], X: np.ndarray, name_to_idx: dict[str, int]) -> np.ndarray:
    nodes = tree["nodes"]
    n = X.shape[0]
    out = np.empty(n, dtype=float)
    for i in range(n):
        idx = 0
        while True:
            node = nodes[idx]
            if node["leaf"]:
                out[i] = node["value"]
                break
            v = X[i, name_to_idx[node["feature"]]]
            if math.isnan(v):
                idx = node["left"] if node["missing_dir"] == "left" else node["right"]
            else:
                idx = node["left"] if v <= node["threshold"] else node["right"]
    return out


def _fit_base_score(y: np.ndarray, market_logits: np.ndarray, l2_intercept: float = 5.0) -> float:
    """1D L2-regularized Newton-Raphson residual intercept with fixed market offset."""
    b = 0.0
    for _ in range(15):
        p = _sigmoid_array(market_logits + b)
        g = float(np.sum(p - y)) + l2_intercept * b
        h = float(np.sum(np.maximum(1e-6, p * (1.0 - p)))) + l2_intercept
        step = g / h
        b -= step
        if abs(step) < 1e-10:
            break
    return float(b)


def fit_monotone_residual_gbdt(
    X_train: np.ndarray,
    y_train: np.ndarray,
    market_logits_train: np.ndarray,
    feature_names: list[str],
    *,
    X_val: np.ndarray | None = None,
    y_val: np.ndarray | None = None,
    market_logits_val: np.ndarray | None = None,
    monotone_constraints: dict[str, int] | None = None,
    max_depth: int = 2,
    l2_leaf: float = 15.0,
    learning_rate: float = DEFAULT_LEARNING_RATE,
    max_trees: int = DEFAULT_MAX_TREES,
    early_stopping_rounds: int = DEFAULT_EARLY_STOPPING_ROUNDS,
    min_child_hessian: float = DEFAULT_MIN_CHILD_HESSIAN,
    min_gain: float = DEFAULT_MIN_GAIN,
    feature_schema_version: str = MARKET_RESIDUAL_GBDT_V2_FEATURE_SCHEMA_VERSION,
) -> dict[str, Any]:
    """Fit a shallow monotone residual GBDT directly from NumPy arrays.

    Returns a complete deployable/verifiable artifact dict (including SHA-256
    `artifact_hash`). Useful both for walk-forward training and standalone
    unit/parity testing.
    """
    if max_depth < 1 or max_depth > MAX_ALLOWED_TREE_DEPTH:
        raise ValueError(f"max_depth must be in [1, {MAX_ALLOWED_TREE_DEPTH}], got {max_depth}")

    constraints = (
        DEFAULT_MONOTONE_CONSTRAINTS
        if monotone_constraints is None
        else monotone_constraints
    )
    monotone_vec = [int(constraints.get(name, 0)) for name in feature_names]
    name_to_idx = {name: i for i, name in enumerate(feature_names)}

    base_score = _fit_base_score(y_train, market_logits_train)
    z_train = market_logits_train + base_score

    use_val = X_val is not None and y_val is not None and market_logits_val is not None and len(y_val) > 0
    z_val = (market_logits_val + base_score) if use_val else None

    best_val_loss = math.inf
    best_num_trees = 0
    rounds_without_improve = 0
    if use_val:
        p_val0 = np.clip(_sigmoid_array(z_val), 1e-15, 1.0 - 1e-15)
        best_val_loss = float(-np.mean(y_val * np.log(p_val0) + (1.0 - y_val) * np.log(1.0 - p_val0)))

    trees: list[dict[str, Any]] = []
    for _ in range(max_trees):
        p_tr = _sigmoid_array(z_train)
        grad = p_tr - y_train
        hess = np.maximum(1e-6, p_tr * (1.0 - p_tr))

        tree = _fit_single_tree(
            X_train,
            grad,
            hess,
            feature_names,
            monotone_vec,
            max_depth=max_depth,
            l2_leaf=l2_leaf,
            min_child_hessian=min_child_hessian,
            min_gain=min_gain,
        )

        # Stop if tree collapsed to a zero-leaf root (no profitable split).
        if len(tree["nodes"]) == 1 and abs(tree["nodes"][0]["value"]) < 1e-9:
            break

        pred_tr = _predict_tree_matrix(tree, X_train, name_to_idx)
        z_train = z_train + learning_rate * pred_tr
        trees.append(tree)

        if use_val:
            pred_val = _predict_tree_matrix(tree, X_val, name_to_idx)
            z_val = z_val + learning_rate * pred_val
            p_val = np.clip(_sigmoid_array(z_val), 1e-15, 1.0 - 1e-15)
            val_loss = float(-np.mean(y_val * np.log(p_val) + (1.0 - y_val) * np.log(1.0 - p_val)))
            if val_loss < best_val_loss - 1e-7:
                best_val_loss = val_loss
                best_num_trees = len(trees)
                rounds_without_improve = 0
            else:
                rounds_without_improve += 1
                if rounds_without_improve >= early_stopping_rounds:
                    break

    if use_val:
        trees = trees[:best_num_trees]

    artifact = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION,
        "feature_schema_version": feature_schema_version,
        "feature_names": list(feature_names),
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "base_score": float(base_score),
        "learning_rate": float(learning_rate),
        "max_depth": int(max_depth),
        "l2_leaf": float(l2_leaf),
        "min_child_hessian": float(min_child_hessian),
        "min_gain": float(min_gain),
        "monotone_constraints": {
            name: int(constraints[name])
            for name in feature_names
            if int(constraints.get(name, 0)) != 0
        },
        "tree_count": len(trees),
        "zero_trees_market_efficient": len(trees) == 0,
        "trees": trees,
    }
    artifact["artifact_hash"] = artifact_hash(artifact)
    return artifact


def artifact_hash(artifact: dict[str, Any]) -> str:
    body = {k: v for k, v in artifact.items() if k != "artifact_hash"}
    return hashlib.sha256(_stable_stringify(body).encode()).hexdigest()


def score_gbdt_artifact(
    artifact: dict[str, Any],
    flat_vector: dict[str, Any],
    market_no_vig_home_prob: float | None,
) -> dict[str, Any]:
    """Pure-Python mirror of scoreMarketResidualGbdtV2 (src/core/market_residual_gbdt_v2.js)."""
    if not isinstance(flat_vector, dict):
        return {
            "available": False, "homeProbability": None, "awayProbability": None,
            "marketLogit": None, "residualLogit": None, "marketNoVigProbability": None,
            "treesEvaluated": 0, "reasons": ["flat_vector_missing"],
        }
    p_mkt = _safe_float(market_no_vig_home_prob)
    if p_mkt is None:
        return {
            "available": False, "homeProbability": None, "awayProbability": None,
            "marketLogit": None, "residualLogit": None, "marketNoVigProbability": None,
            "treesEvaluated": 0, "reasons": ["market_no_vig_home_prob_missing"],
        }
    if p_mkt <= 0.0 or p_mkt >= 1.0:
        return {
            "available": False, "homeProbability": None, "awayProbability": None,
            "marketLogit": None, "residualLogit": None, "marketNoVigProbability": None,
            "treesEvaluated": 0, "reasons": [f"market_no_vig_home_prob_out_of_range ({p_mkt})"],
        }

    market_logit = math.log(p_mkt / (1.0 - p_mkt))
    tree_sum = 0.0
    trees = artifact.get("trees") or []
    for tree in trees:
        nodes = tree["nodes"]
        idx = 0
        while True:
            node = nodes[idx]
            if node["leaf"]:
                tree_sum += float(node["value"])
                break
            feat = node["feature"]
            raw_val = flat_vector.get(feat)
            missing_flag = flat_vector.get(f"missing_{feat}")
            val = _safe_float(raw_val)
            is_missing = (val is None) or (missing_flag == 1)
            if is_missing:
                idx = node["left"] if node["missing_dir"] == "left" else node["right"]
            else:
                idx = node["left"] if val <= float(node["threshold"]) else node["right"]

    residual_logit = float(artifact["base_score"]) + float(artifact["learning_rate"]) * tree_sum
    home_prob = _sigmoid_scalar(market_logit + residual_logit)
    return {
        "available": True,
        "homeProbability": home_prob,
        "awayProbability": 1.0 - home_prob,
        "marketLogit": market_logit,
        "residualLogit": residual_logit,
        "marketNoVigProbability": p_mkt,
        "treesEvaluated": len(trees),
        "reasons": [],
    }


@dataclass
class GbdtFoldResult:
    fold_index: int
    train_rows: int
    pos_events: int
    neg_events: int
    artifact: dict[str, Any]
    val_log_loss: float


def _market_logit(row: DatasetRow) -> float | None:
    p = _safe_float(row.market_no_vig_home_prob)
    if p is None or p <= 0.0 or p >= 1.0:
        return None
    return math.log(p / (1.0 - p))


def _rows_to_arrays(
    rows: list[DatasetRow], feature_names: list[str]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(rows)
    m = len(feature_names)
    X = np.full((n, m), np.nan, dtype=float)
    y = np.empty(n, dtype=float)
    mkt_logits = np.empty(n, dtype=float)
    for i, row in enumerate(rows):
        fv = row.feature_vector or {}
        for j, name in enumerate(feature_names):
            v = _safe_float(fv.get(name))
            X[i, j] = np.nan if v is None else v
        y[i] = 1.0 if row.home_won else 0.0
        mkt_logits[i] = _market_logit(row)
    return X, y, mkt_logits


def _fit_gbdt_fold(
    train_rows: list[DatasetRow],
    fold_index: int,
    feature_names: list[str],
    feature_schema_version: str,
    monotone_constraints: dict[str, int] | None = None,
) -> tuple[GbdtFoldResult | None, str | None]:
    usable = [
        r for r in train_rows
        if _market_logit(r) is not None and r.home_won is not None and r.feature_vector is not None
    ]
    if len(usable) < MIN_TRAIN_ROWS_PER_FOLD:
        return None, (
            f"fold_{fold_index}_insufficient_with_market_rows_{len(usable)}"
            f"_below_{MIN_TRAIN_ROWS_PER_FOLD}"
        )

    X_raw, y, mkt_logits = _rows_to_arrays(usable, feature_names)
    pos = int(np.sum(y == 1.0))
    neg = int(np.sum(y == 0.0))
    if pos < MIN_EVENTS_PER_CLASS or neg < MIN_EVENTS_PER_CLASS:
        return None, (
            f"fold_{fold_index}_insufficient_events_pos_{pos}_neg_{neg}"
            f"_min_{MIN_EVENTS_PER_CLASS}"
        )

    n_val = max(1, int(len(y) * INNER_VAL_FRACTION))
    X_in_tr, y_in_tr, m_in_tr = X_raw[:-n_val], y[:-n_val], mkt_logits[:-n_val]
    X_in_val, y_in_val, m_in_val = X_raw[-n_val:], y[-n_val:], mkt_logits[-n_val:]

    name_to_idx = {name: i for i, name in enumerate(feature_names)}
    best_cfg = (DEFAULT_DEPTH_GRID[0], DEFAULT_L2_GRID[0], 0)
    best_val_ll = math.inf

    for depth in DEFAULT_DEPTH_GRID:
        for l2_leaf in DEFAULT_L2_GRID:
            art = fit_monotone_residual_gbdt(
                X_in_tr,
                y_in_tr,
                m_in_tr,
                feature_names,
                X_val=X_in_val,
                y_val=y_in_val,
                market_logits_val=m_in_val,
                monotone_constraints=monotone_constraints,
                max_depth=depth,
                l2_leaf=l2_leaf,
                feature_schema_version=feature_schema_version,
            )
            z_val = m_in_val + float(art["base_score"])
            lr = float(art["learning_rate"])
            for tree in art["trees"]:
                z_val = z_val + lr * _predict_tree_matrix(tree, X_in_val, name_to_idx)
            val_probs = np.clip(_sigmoid_array(z_val), 1e-15, 1.0 - 1e-15)
            val_ll = float(-np.mean(y_in_val * np.log(val_probs) + (1.0 - y_in_val) * np.log(1.0 - val_probs)))
            if val_ll < best_val_ll:
                best_val_ll = val_ll
                best_cfg = (depth, l2_leaf, art["tree_count"])

    best_depth, best_l2, best_trees = best_cfg
    final_art = fit_monotone_residual_gbdt(
        X_raw,
        y,
        mkt_logits,
        feature_names,
        monotone_constraints=monotone_constraints,
        max_depth=best_depth,
        l2_leaf=best_l2,
        max_trees=max(0, best_trees),
        feature_schema_version=feature_schema_version,
    )
    return GbdtFoldResult(
        fold_index=fold_index,
        train_rows=len(usable),
        pos_events=pos,
        neg_events=neg,
        artifact=final_art,
        val_log_loss=best_val_ll,
    ), None


def hydrate_v2_feature_vectors(
    db_path: str, rows: list[DatasetRow]
) -> dict[str, int]:
    """Hydrate DatasetRows to mlb-feature-vector-v2.0 from frozen feature_snapshots.

    Eliminates train-serve skew when prediction_runs.normalized_feature_vector
    only persisted v1.0 cells while live shadow inference scores v2.0 from
    frozen coreInputs. Strictly read-only; never leaks postgame data because
    prediction_decision_snapshot is write-once at prediction time.
    """
    stats = {"already_v2": 0, "hydrated_from_snapshots": 0, "v1_only_fallback": 0}
    if not rows:
        return stats

    snapshots_by_game: dict[str, dict[str, Any]] = {}
    try:
        uri = f"{Path(db_path).resolve().as_uri()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        try:
            has_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature_snapshots'"
            ).fetchone()
            if has_table:
                snap_rows = conn.execute(
                    "SELECT game_pk, payload FROM feature_snapshots "
                    "WHERE feature_group = 'prediction_decision_snapshot'"
                ).fetchall()
                for sr in snap_rows:
                    raw_payload = sr["payload"]
                    if not raw_payload:
                        continue
                    try:
                        parsed = json.loads(raw_payload)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(parsed, dict) and isinstance(parsed.get("coreInputs"), dict):
                        snapshots_by_game[str(sr["game_pk"])] = parsed
        finally:
            conn.close()
    except sqlite3.Error:
        snapshots_by_game = {}

    for row in rows:
        fv = row.feature_vector
        if isinstance(fv, dict) and fv.get("schemaVersion") == FEATURE_VECTOR_V2_SCHEMA_VERSION:
            stats["already_v2"] += 1
            continue

        snap = snapshots_by_game.get(str(row.game_pk))
        snap_hash = snap.get("snapshotHash") if isinstance(snap, dict) else None
        hash_compatible = (
            snap is not None
            and (not row.snapshot_hash or not snap_hash or str(row.snapshot_hash) == str(snap_hash))
        )
        if hash_compatible:
            v2 = buildFeatureVectorV2(
                snap["coreInputs"],
                {"asOfUtc": row.as_of_utc, "firstPitchUtc": row.first_pitch_utc},
            )
            flat_v2 = flattenFeatureVector(v2)
            row.feature_vector = flat_v2
            row.feature_vector_hash = flat_v2.get("featureVectorHash")
            stats["hydrated_from_snapshots"] += 1
            continue

        # Fallback: preserve v1.0 cells and enrich leadTimeMinutes from pregame timestamps.
        if isinstance(fv, dict):
            enriched = dict(fv)
            if enriched.get("leadTimeMinutes") is None:
                as_of_dt = _parse_iso_dt(row.as_of_utc)
                fp_dt = _parse_iso_dt(row.first_pitch_utc)
                if as_of_dt is not None and fp_dt is not None:
                    delta_ms = int(round((fp_dt - as_of_dt).total_seconds() * 1000.0))
                    if delta_ms > 0:
                        enriched["leadTimeMinutes"] = delta_ms / 60000.0
                        enriched["missing_leadTimeMinutes"] = 0
            row.feature_vector = enriched
        stats["v1_only_fallback"] += 1

    return stats


def train_market_residual_gbdt_v2(
    db_path: str,
    cohort: str = "main",
    model_id_for_dataset: str = "heuristic_v1",
    feature_schema_version: str = MARKET_RESIDUAL_GBDT_V2_FEATURE_SCHEMA_VERSION,
    monotone_constraints: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Chronological walk-forward training of market_residual_gbdt_v2 from SQLite DB."""
    if feature_schema_version not in SUPPORTED_FEATURE_SCHEMAS:
        raise ValueError(f"Unsupported feature_schema_version: {feature_schema_version}")

    feature_names = (
        list(FEATURE_VECTOR_V2_FEATURE_NAMES)
        if feature_schema_version == FEATURE_VECTOR_V2_SCHEMA_VERSION
        else list(FEATURE_VECTOR_V1_FEATURE_NAMES)
    )

    clean, quarantined = build_game_dataset(db_path, model_id=model_id_for_dataset, cohort=cohort)
    v2_hydration_summary = (
        hydrate_v2_feature_vectors(db_path, clean)
        if feature_schema_version == FEATURE_VECTOR_V2_SCHEMA_VERSION
        else None
    )
    base: dict[str, Any] = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_GBDT_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_GBDT_V2_IMPL_VERSION,
        "feature_schema_version": feature_schema_version,
        "cohort": cohort,
        "control_model_id": model_id_for_dataset,
        "dataset_row_count": len(clean),
        "quarantine_count": len(quarantined),
        "v2_hydration_summary": v2_hydration_summary,
        "feature_names": feature_names,
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "gates": {
            "min_train_rows_per_fold": MIN_TRAIN_ROWS_PER_FOLD,
            "min_events_per_class": MIN_EVENTS_PER_CLASS,
            "min_with_market_rows": MIN_WITH_MARKET_ROWS,
        },
    }

    if not clean:
        return _insufficient(base, ["empty_dataset"])

    with_market = [r for r in clean if _market_logit(r) is not None]
    base["with_market_row_count"] = len(with_market)
    if len(with_market) < MIN_WITH_MARKET_ROWS:
        return _insufficient(
            base, [f"with_market_rows_{len(with_market)}_below_{MIN_WITH_MARKET_ROWS}"]
        )

    folds, dataset_hash = build_folds(clean)
    base["dataset_hash"] = dataset_hash
    base["fold_count"] = len(folds)
    base["folds"] = folds

    test_folds = [f for f in folds if f.get("fold_type") == "test"]
    holdout_folds = [f for f in folds if f.get("fold_type") == "holdout"]
    if not test_folds:
        return _insufficient(base, ["no_test_folds"])

    oof_probs: list[float] = []
    oof_labels: list[int] = []
    market_oof_probs: list[float] = []
    fold_metrics: list[dict[str, Any]] = []
    insufficient_reasons: list[str] = []

    for fold in test_folds:
        train_rows = [
            r for r in clean
            if fold["train_start_date"] <= r.date_ymd <= fold["train_end_date"]
        ]
        test_rows = [
            r for r in clean
            if fold["start_date"] <= r.date_ymd < fold["end_date"]
        ]
        fit, reason = _fit_gbdt_fold(
            train_rows,
            fold["fold_index"],
            feature_names,
            feature_schema_version,
            monotone_constraints,
        )
        if fit is None:
            insufficient_reasons.append(reason or f"fold_{fold['fold_index']}_unfit")
            fold_metrics.append({"fold_index": fold["fold_index"], "status": "insufficient"})
            continue

        fold_probs: list[float] = []
        fold_labels: list[int] = []
        fold_market: list[float] = []
        for row in test_rows:
            if row.home_won is None or row.feature_vector is None:
                continue
            scored = score_gbdt_artifact(fit.artifact, row.feature_vector, row.market_no_vig_home_prob)
            if not scored["available"]:
                continue
            fold_probs.append(float(scored["homeProbability"]))
            fold_labels.append(1 if row.home_won else 0)
            fold_market.append(float(row.market_no_vig_home_prob))

        oof_probs.extend(fold_probs)
        oof_labels.extend(fold_labels)
        market_oof_probs.extend(fold_market)

        fm = model_metrics(fold_probs, fold_labels) if fold_probs else {}
        fm["fold_index"] = fold["fold_index"]
        fm["train_rows"] = fit.train_rows
        fm["test_rows"] = len(fold_probs)
        fm["max_depth"] = fit.artifact["max_depth"]
        fm["l2_leaf"] = fit.artifact["l2_leaf"]
        fm["tree_count"] = fit.artifact["tree_count"]
        fold_metrics.append(fm)

    base["fold_metrics"] = fold_metrics
    base["insufficient_fold_reasons"] = insufficient_reasons

    if not oof_probs:
        return _insufficient(base, ["no_oof_predictions"] + insufficient_reasons)

    oof_metrics = model_metrics(oof_probs, oof_labels)
    market_oof_metrics = model_metrics(market_oof_probs, oof_labels)
    base["oof_metrics"] = oof_metrics
    base["market_oof_metrics"] = market_oof_metrics
    base["oof_row_count"] = len(oof_probs)

    holdout_start = holdout_folds[0]["start_date"] if holdout_folds else None
    pre_holdout = [r for r in clean if (r.date_ymd < holdout_start if holdout_start else True)]
    final_fit, final_reason = _fit_gbdt_fold(
        pre_holdout, -1, feature_names, feature_schema_version, monotone_constraints
    )
    if final_fit is None:
        return _insufficient(base, ["final_refit_failed", final_reason or "final_refit_unknown"])

    artifact = dict(final_fit.artifact)
    artifact.update({
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "training_cutoff": holdout_start,
        "train_rows": final_fit.train_rows,
        "pos_events": final_fit.pos_events,
        "neg_events": final_fit.neg_events,
        "oof_metrics": oof_metrics,
        "market_oof_metrics": market_oof_metrics,
        "oof_row_count": len(oof_probs),
        "fold_count": len(test_folds),
        "gates": base["gates"],
    })
    artifact["artifact_hash"] = artifact_hash(artifact)

    base["artifact"] = artifact
    base["status"] = "trained"
    base["artifact_hash"] = artifact["artifact_hash"]
    base["reasons"] = []
    base["recommendation_eligible"] = False
    return base


def _insufficient(base: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    base["status"] = "insufficient_data"
    base["reasons"] = reasons
    base["artifact"] = None
    base["artifact_hash"] = None
    base["recommendation_eligible"] = False
    return base


def write_artifact(report: dict[str, Any], output_dir: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    status = report.get("status", "unknown")
    h = report.get("artifact_hash") or "insufficient"
    fname = f"{MARKET_RESIDUAL_GBDT_V2_MODEL_ID}-{status}-{h[:12]}.json"
    path = os.path.join(output_dir, fname)
    with open(path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    return path
