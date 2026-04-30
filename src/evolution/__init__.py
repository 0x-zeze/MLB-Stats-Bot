"""Lightweight MLB agent evolution engine.

The package records prediction trajectories, evaluates settled games, turns
results into lessons, and proposes auditable rule/prompt/weight candidates.
Production behavior is never changed directly from generated lessons.
"""

from .trajectory_logger import log_prediction_trajectory
from .prediction_evaluator import evaluate_prediction
from .language_loss import calculate_language_loss
from .language_gradient import generate_language_gradient
from .lesson_generator import generate_lesson
from .promotion_gate import run_promotion_gate

__all__ = [
    "calculate_language_loss",
    "evaluate_prediction",
    "generate_language_gradient",
    "generate_lesson",
    "log_prediction_trajectory",
    "run_promotion_gate",
]
