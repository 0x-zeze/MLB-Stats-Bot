"""Train the market_residual_v2 challenger (fixed-offset residual model).

Model:

    logit(P_home) = logit(P_market_no_vig_home) + beta0 + beta . X_baseball

The market-offset coefficient is FIXED at exactly 1.0 — it is never fit. Only
beta0 (intercept) and beta (baseball-feature coefficients) are learned, via L2-
penalized Bernoulli regression on the residual logit. L2 strength is selected
through inner chronological validation, never on the outer test fold or holdout.

Leakage rules (same as P2):
  - Imputation medians, missingness, scaling, coefficients fit INSIDE each
    training fold only.
  - Require enough prior observations/events; else insufficient_data (no artifact).
  - Uses ONLY complete same-book quote pairs available by run as_of. Missing /
    stale / unpaired market data produces NO residual prediction (the row is
    excluded from training and scored unavailable at inference).

Reads the all-game dataset from a (copy of) the production DB. NEVER mutates
production tables. Writes proposal artifacts to data/models/. Activation
requires separate human approval.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.optimize import minimize

from src.core.feature_vector_py import (
    FEATURE_VECTOR_SCHEMA_VERSION,
    FEATURE_VECTOR_V2_FEATURE_NAMES,
    FEATURE_VECTOR_V2_SCHEMA_VERSION,
)
from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics
from src.models.train_learned_v2_logistic import (
    _build_matrix,
    _row_features,
    _stable_stringify,
    FEATURE_NAMES,
)

# ---- Identity (must match src/core/model_ids.js) ----
MARKET_RESIDUAL_V2_MODEL_ID = "market_residual_v2"
MARKET_RESIDUAL_V2_IMPL_VERSION = "market-residual-v2-v1.0"
MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION = FEATURE_VECTOR_SCHEMA_VERSION
SUPPORTED_FEATURE_SCHEMAS = (FEATURE_VECTOR_SCHEMA_VERSION, FEATURE_VECTOR_V2_SCHEMA_VERSION)
ARTIFACT_MANIFEST_VERSION = "market-residual-v2-artifact-v1"

# The market logit is a FIXED offset; coefficient is exactly 1 (never fit).
MARKET_OFFSET_COEFFICIENT = 1.0

# ---- Training gates ----
MIN_TRAIN_ROWS_PER_FOLD = 60
MIN_EVENTS_PER_CLASS = 10
MIN_WITH_MARKET_ROWS = 40  # residual model needs market-paired rows
REGULARIZATION_GRID = [0.001, 0.01, 0.1, 1.0, 10.0]
INNER_VAL_FRACTION = 0.25


@dataclass
class ResidualFoldFit:
    fold_index: int
    train_rows: int
    pos_events: int
    neg_events: int
    imputation: dict[str, float]
    feature_mean: dict[str, float]
    feature_std: dict[str, float]
    coefficients: dict[str, float]
    intercept: float
    l2_strength: float
    train_brier: float | None
    train_log_loss: float | None
    train_accuracy: float | None


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _market_logit(row: DatasetRow) -> float | None:
    """Fixed market logit offset: logit(P_market_no_vig_home).

    Returns None if no complete same-book no-vig market probability is paired to
    the run. A row without market cannot train or score a residual prediction.
    """
    p = _safe_float(row.market_no_vig_home_prob)
    if p is None or p <= 0.0 or p >= 1.0:
        return None
    return math.log(p / (1.0 - p))


def _fit_offset_logistic(
    X: np.ndarray, y: np.ndarray, offset: np.ndarray, c: float
) -> tuple[float, np.ndarray]:
    """Fit L2-penalized Bernoulli logistic regression with fixed logit offset.

    Minimizes: sum_i [log(1 + exp(z_i)) - y_i * z_i] + (1 / (2 * c)) * ||w||^2
    where z_i = offset_i + b + X_i @ w. The offset coefficient is fixed at 1.0.
    """
    n_features = X.shape[1]
    reg = 1.0 / max(float(c), 1e-12)

    def obj_and_grad(params: np.ndarray) -> tuple[float, np.ndarray]:
        b = params[0]
        w = params[1:]
        z = offset + b + X @ w
        # Numerically stable log(1 + exp(z)) - y * z
        log1p_exp = np.where(z > 0, z + np.log1p(np.exp(-z)), np.log1p(np.exp(z)))
        loss = float(np.sum(log1p_exp - y * z) + 0.5 * reg * float(np.dot(w, w)))
        p = _sigmoid(z)
        diff = p - y
        grad = np.empty_like(params)
        grad[0] = float(np.sum(diff))
        grad[1:] = X.T @ diff + reg * w
        return loss, grad

    init = np.zeros(n_features + 1, dtype=float)
    res = minimize(
        obj_and_grad,
        init,
        method="L-BFGS-B",
        jac=True,
        options={"maxiter": 500},
    )
    params = res.x
    return float(params[0]), params[1:].astype(float)


def _extract_row_features(
    row: DatasetRow, feature_names: list[str]
) -> tuple[list[float | None], list[int]] | None:
    if feature_names == FEATURE_NAMES:
        return _row_features(row)
    fv = row.feature_vector
    if not fv:
        return None
    values: list[float | None] = []
    missing: list[int] = []
    for name in feature_names:
        v = _safe_float(fv.get(name))
        values.append(v)
        missing.append(1 if v is None else 0)
    return values, missing


def _build_feature_matrix(
    rows: list[DatasetRow], feature_names: list[str]
) -> tuple[np.ndarray, np.ndarray, list[int]] | None:
    if feature_names == FEATURE_NAMES:
        return _build_matrix(rows)
    n_feat = len(feature_names)
    X = np.full((len(rows), n_feat), np.nan, dtype=float)
    y = np.empty(len(rows), dtype=float)
    valid_mask: list[int] = []
    any_valid = False
    for i, row in enumerate(rows):
        extracted = _extract_row_features(row, feature_names)
        if extracted is None or row.home_won is None:
            valid_mask.append(0)
            y[i] = 0.0
            continue
        values, _ = extracted
        for j, v in enumerate(values):
            X[i, j] = np.nan if v is None else float(v)
        y[i] = 1.0 if row.home_won else 0.0
        valid_mask.append(1)
        any_valid = True
    return (X, y, valid_mask) if any_valid else None


def _fit_residual_fold(
    train_rows: list[DatasetRow],
    fold_index: int,
    feature_names: list[str] | None = None,
) -> tuple[ResidualFoldFit | None, str | None]:
    """Fit the residual model on training-fold rows that have market + features.

    Minimizes exact L2-penalized Bernoulli log-loss with fixed market logit
    offset (coefficient = 1.0, never fit): z = market_logit + b + beta . X_scaled.
    Imputation and scaling are fit strictly on inner-train during C selection,
    then refit on the full training fold.
    """
    active_features = list(feature_names) if feature_names is not None else list(FEATURE_NAMES)
    usable = [
        r for r in train_rows
        if _market_logit(r) is not None and r.home_won is not None and _extract_row_features(r, active_features) is not None
    ]
    if len(usable) < MIN_TRAIN_ROWS_PER_FOLD:
        return None, (
            f"fold_{fold_index}_insufficient_with_market_rows_{len(usable)}"
            f"_below_{MIN_TRAIN_ROWS_PER_FOLD}"
        )

    matrix = _build_feature_matrix(usable, active_features)
    if matrix is None:
        return None, f"fold_{fold_index}_no_feature_vectors"
    X_all, y_all, valid_mask = matrix
    valid_idx = [i for i, m in enumerate(valid_mask) if m]
    n_feat = len(active_features)
    X_raw = X_all[valid_idx, :n_feat].copy()
    y = y_all[valid_idx]
    market_logits = np.array([_market_logit(usable[i]) for i in valid_idx], dtype=float)

    pos = int(np.sum(y == 1.0))
    neg = int(np.sum(y == 0.0))
    if pos < MIN_EVENTS_PER_CLASS or neg < MIN_EVENTS_PER_CLASS:
        return None, (
            f"fold_{fold_index}_insufficient_events_pos_{pos}_neg_{neg}"
            f"_min_{MIN_EVENTS_PER_CLASS}"
        )

    def _fit_transform(X_tr: np.ndarray, X_te: np.ndarray | None = None):
        imp: dict[str, float] = {}
        mu_map: dict[str, float] = {}
        std_map: dict[str, float] = {}
        tr_out = X_tr.copy()
        te_out = X_te.copy() if X_te is not None else None
        for j, name in enumerate(active_features):
            col = tr_out[:, j]
            finite = col[np.isfinite(col)]
            med = float(np.median(finite)) if finite.size else 0.0
            imp[name] = med
            tr_nan = np.isnan(col)
            if tr_nan.any():
                tr_out[tr_nan, j] = med
            mu = float(np.mean(tr_out[:, j]))
            sigma = float(np.std(tr_out[:, j]))
            std = sigma if sigma > 1e-9 else 1.0
            mu_map[name] = mu
            std_map[name] = std
            tr_out[:, j] = (tr_out[:, j] - mu) / std
            if te_out is not None:
                te_col = te_out[:, j]
                te_nan = np.isnan(te_col)
                if te_nan.any():
                    te_out[te_nan, j] = med
                te_out[:, j] = (te_out[:, j] - mu) / std
        return tr_out, te_out, imp, mu_map, std_map

    order = np.arange(len(y))
    n_val = max(1, int(len(y) * INNER_VAL_FRACTION))
    inner_train_idx = order[:-n_val]
    inner_val_idx = order[-n_val:]

    X_inner_tr, X_inner_val, _, _, _ = _fit_transform(X_raw[inner_train_idx], X_raw[inner_val_idx])

    best_c = REGULARIZATION_GRID[0]
    best_val_brier = math.inf
    for c in REGULARIZATION_GRID:
        try:
            b_in, w_in = _fit_offset_logistic(
                X_inner_tr, y[inner_train_idx], market_logits[inner_train_idx], c
            )
        except (ValueError, np.linalg.LinAlgError):
            continue
        z = b_in + X_inner_val @ w_in + market_logits[inner_val_idx]
        val_prob = _sigmoid(z)
        val_brier = float(np.mean((val_prob - y[inner_val_idx]) ** 2))
        if val_brier < best_val_brier:
            best_val_brier = val_brier
            best_c = c

    # Refit on the FULL training fold with the selected C.
    X, _, imputation, feature_mean, feature_std = _fit_transform(X_raw)
    intercept, coefs = _fit_offset_logistic(X, y, market_logits, best_c)

    coefficients = {name: float(coefs[j]) for j, name in enumerate(active_features)}

    # Training metrics (offset-adjusted; audit only, never a selection signal).
    z_train = intercept + X @ coefs + market_logits
    train_prob = _sigmoid(z_train)
    train_metrics = model_metrics(
        [float(p) for p in train_prob], [int(v) for v in y]
    )

    return ResidualFoldFit(
        fold_index=fold_index,
        train_rows=len(valid_idx),
        pos_events=pos,
        neg_events=neg,
        imputation=imputation,
        feature_mean=feature_mean,
        feature_std=feature_std,
        coefficients=coefficients,
        intercept=intercept,
        l2_strength=best_c,
        train_brier=train_metrics.get("brier"),
        train_log_loss=train_metrics.get("log_loss"),
        train_accuracy=train_metrics.get("accuracy"),
    ), None


def _predict_residual_fold(
    fit: ResidualFoldFit,
    rows: list[DatasetRow],
    feature_names: list[str] | None = None,
) -> tuple[list[float], list[int]]:
    """Apply a residual fit. Rows without market OR without features are invalid."""
    active_features = list(feature_names) if feature_names is not None else list(FEATURE_NAMES)
    probs: list[float] = []
    valid: list[int] = []
    for row in rows:
        market_logit = _market_logit(row)
        extracted = _extract_row_features(row, active_features)
        if market_logit is None or extracted is None:
            probs.append(0.5)
            valid.append(0)
            continue
        values, _missing = extracted
        z = fit.intercept + market_logit  # market offset coefficient = 1.0
        for j, name in enumerate(active_features):
            v = values[j]
            if v is None:
                v = fit.imputation.get(name, 0.0)
            scaled = (v - fit.feature_mean[name]) / fit.feature_std[name]
            z += fit.coefficients[name] * scaled
        probs.append(_sigmoid_scalar(z))
        valid.append(1)
    return probs, valid


def _sigmoid(z: np.ndarray) -> np.ndarray:
    out = np.empty_like(z, dtype=float)
    high = z >= 35
    low = z <= -35
    mid = ~(high | low)
    out[high] = 1.0
    out[low] = 0.0
    out[mid] = 1.0 / (1.0 + np.exp(-z[mid]))
    return out


def _sigmoid_scalar(z: float) -> float:
    if z >= 35:
        return 1.0
    if z <= -35:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def _artifact_hash(content: dict[str, Any]) -> str:
    return hashlib.sha256(_stable_stringify(content).encode()).hexdigest()


def train_market_residual_v2(
    db_path: str,
    cohort: str = "main",
    model_id_for_dataset: str = "heuristic_v1",
    feature_schema_version: str = MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION,
) -> dict[str, Any]:
    """Train market_residual_v2 from all-game feature vectors + market quotes.

    Returns a proposal artifact dict. If data is insufficient, returns an
    insufficient_data report with no usable coefficients. NEVER mutates
    production tables.
    """
    if feature_schema_version not in SUPPORTED_FEATURE_SCHEMAS:
        raise ValueError(f"Unsupported feature_schema_version: {feature_schema_version}")
    active_features = (
        list(FEATURE_VECTOR_V2_FEATURE_NAMES)
        if feature_schema_version == FEATURE_VECTOR_V2_SCHEMA_VERSION
        else list(FEATURE_NAMES)
    )

    clean, quarantined = build_game_dataset(db_path, model_id=model_id_for_dataset, cohort=cohort)
    v2_hydration_summary = None
    if feature_schema_version == FEATURE_VECTOR_V2_SCHEMA_VERSION:
        from src.models.train_market_residual_gbdt_v2 import hydrate_v2_feature_vectors

        v2_hydration_summary = hydrate_v2_feature_vectors(db_path, clean)

    base = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_V2_IMPL_VERSION,
        "feature_schema_version": feature_schema_version,
        "cohort": cohort,
        "control_model_id": model_id_for_dataset,
        "dataset_row_count": len(clean),
        "quarantine_count": len(quarantined),
        "v2_hydration_summary": v2_hydration_summary,
        "feature_names": list(active_features),
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "regularization_grid": list(REGULARIZATION_GRID),
        "gates": {
            "min_train_rows_per_fold": MIN_TRAIN_ROWS_PER_FOLD,
            "min_events_per_class": MIN_EVENTS_PER_CLASS,
            "min_with_market_rows": MIN_WITH_MARKET_ROWS,
        },
    }

    if len(clean) == 0:
        return _insufficient(base, ["empty_dataset"])

    # Count market-paired rows.
    with_market = [r for r in clean if _market_logit(r) is not None]
    base["with_market_row_count"] = len(with_market)
    if len(with_market) < MIN_WITH_MARKET_ROWS:
        return _insufficient(base, [
            f"with_market_rows_{len(with_market)}_below_{MIN_WITH_MARKET_ROWS}"
        ])

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
    market_oof_labels: list[int] = []
    fold_fits: list[dict[str, Any]] = []
    fold_metrics: list[dict[str, Any]] = []
    insufficient_reasons: list[str] = []

    for fold in test_folds:
        train_start = fold["train_start_date"]
        train_end = fold["train_end_date"]
        test_start = fold["start_date"]
        test_end = fold["end_date"]

        train_rows = [r for r in clean if train_start <= r.date_ymd <= train_end]
        test_rows = [r for r in clean if test_start <= r.date_ymd < test_end]

        fit, reason = _fit_residual_fold(train_rows, fold["fold_index"], active_features)
        if fit is None:
            insufficient_reasons.append(reason or f"fold_{fold['fold_index']}_unfit")
            fold_fits.append({"fold_index": fold["fold_index"], "status": "insufficient", "reason": reason})
            fold_metrics.append({"fold_index": fold["fold_index"], "status": "insufficient"})
            continue

        probs, valid = _predict_residual_fold(fit, test_rows, active_features)
        fold_probs = [p for p, v in zip(probs, valid) if v]
        fold_labels = [1 if r.home_won else 0 for r, v in zip(test_rows, valid) if v]
        fold_market_probs = [float(r.market_no_vig_home_prob) for r, v in zip(test_rows, valid) if v]

        oof_probs.extend(fold_probs)
        oof_labels.extend(fold_labels)
        market_oof_probs.extend(fold_market_probs)
        market_oof_labels.extend(fold_labels)

        fm = model_metrics(fold_probs, fold_labels) if fold_probs else {}
        fm["fold_index"] = fold["fold_index"]
        fm["test_rows"] = len(fold_probs)
        fm["train_rows"] = fit.train_rows
        fm["l2_strength"] = fit.l2_strength
        fm["pos_events"] = fit.pos_events
        fm["neg_events"] = fit.neg_events
        fold_metrics.append(fm)

        fold_fits.append({
            "fold_index": fold["fold_index"],
            "status": "fit",
            "train_rows": fit.train_rows,
            "pos_events": fit.pos_events,
            "neg_events": fit.neg_events,
            "l2_strength": fit.l2_strength,
            "imputation": fit.imputation,
            "feature_mean": fit.feature_mean,
            "feature_std": fit.feature_std,
            "coefficients": fit.coefficients,
            "intercept": fit.intercept,
            "train_brier": fit.train_brier,
            "train_log_loss": fit.train_log_loss,
            "train_accuracy": fit.train_accuracy,
        })

    base["fold_fits"] = fold_fits
    base["fold_metrics"] = fold_metrics
    base["insufficient_fold_reasons"] = insufficient_reasons

    if not oof_probs:
        return _insufficient(base, ["no_oof_predictions"] + insufficient_reasons)

    oof_metrics = model_metrics(oof_probs, oof_labels)
    base["oof_metrics"] = oof_metrics
    base["oof_row_count"] = len(oof_probs)

    # Market baseline metrics on the EXACT SAME valid OOF rows evaluated above.
    base["market_oof_metrics"] = model_metrics(market_oof_probs, market_oof_labels) if market_oof_probs else {}

    # Final proposal artifact: refit on ALL pre-holdout with-market rows.
    holdout_start = holdout_folds[0]["start_date"] if holdout_folds else None
    pre_holdout = [r for r in clean if (r.date_ymd < holdout_start if holdout_start else True)]

    final_fit, final_reason = _fit_residual_fold(pre_holdout, fold_index=-1, feature_names=active_features)
    if final_fit is None:
        return _insufficient(base, ["final_refit_failed", final_reason or "final_refit_unknown"])

    artifact_content = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_V2_IMPL_VERSION,
        "feature_schema_version": feature_schema_version,
        "feature_names": list(active_features),
        "coefficients": final_fit.coefficients,
        "intercept": final_fit.intercept,
        "imputation": final_fit.imputation,
        "feature_mean": final_fit.feature_mean,
        "feature_std": final_fit.feature_std,
        "l2_strength": final_fit.l2_strength,
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "training_cutoff": holdout_start,
        "train_rows": final_fit.train_rows,
        "pos_events": final_fit.pos_events,
        "neg_events": final_fit.neg_events,
        "oof_metrics": oof_metrics,
        "market_oof_metrics": base["market_oof_metrics"],
        "oof_row_count": len(oof_probs),
        "fold_count": len(test_folds),
        "gates": base["gates"],
    }
    artifact_content["artifact_hash"] = _artifact_hash(artifact_content)

    base["artifact"] = artifact_content
    base["status"] = "trained"
    base["artifact_hash"] = artifact_content["artifact_hash"]
    base["reasons"] = []
    base["recommendation_eligible"] = False  # P7 holdout + human approval needed
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
    fname = f"{MARKET_RESIDUAL_V2_MODEL_ID}-{status}-{h[:12]}.json"
    path = os.path.join(output_dir, fname)
    with open(path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    return path
