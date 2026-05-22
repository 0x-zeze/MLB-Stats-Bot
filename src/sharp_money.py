"""Sharp money detection from line movement patterns."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .utils import clamp, safe_float


@dataclass(frozen=True)
class LineMovementSignal:
    """Sharp money signal from line movement analysis."""

    opening_line: float | None = None
    closing_line: float | None = None
    movement_direction: str = "neutral"  # "toward_model", "against_model", "neutral"
    movement_magnitude: float = 0.0
    reverse_line_movement: bool = False
    multi_book_consensus: float = 0.5
    steam_move_detected: bool = False
    sharp_money_direction: str = "unknown"  # "with_model", "against_model", "unknown"


def detect_sharp_money_signal(
    model_pick: str,
    model_probability: float,
    opening_odds: dict[str, Any] | None = None,
    closing_odds: dict[str, Any] | None = None,
    public_betting_pct: dict[str, float] | None = None,
    multi_book_lines: list[dict[str, Any]] | None = None,
) -> LineMovementSignal:
    """Detect sharp money indicators from line movement patterns."""
    if not opening_odds or not closing_odds:
        return LineMovementSignal()

    opening_line = safe_float(opening_odds.get(model_pick), None)
    closing_line = safe_float(closing_odds.get(model_pick), None)

    if opening_line is None or closing_line is None:
        return LineMovementSignal()

    movement = closing_line - opening_line
    magnitude = abs(movement)

    if magnitude < 3:
        direction = "neutral"
    elif movement < 0:
        direction = "toward_model"
    else:
        direction = "against_model"

    rlm = _detect_reverse_line_movement(
        model_pick, direction, public_betting_pct
    )

    consensus = _compute_multi_book_consensus(
        model_pick, multi_book_lines
    )

    steam = magnitude >= 20

    if direction == "against_model" and (rlm or steam):
        sharp_direction = "against_model"
    elif direction == "toward_model" and magnitude >= 10:
        sharp_direction = "with_model"
    elif rlm:
        sharp_direction = "against_model"
    else:
        sharp_direction = "unknown"

    return LineMovementSignal(
        opening_line=opening_line,
        closing_line=closing_line,
        movement_direction=direction,
        movement_magnitude=magnitude,
        reverse_line_movement=rlm,
        multi_book_consensus=consensus,
        steam_move_detected=steam,
        sharp_money_direction=sharp_direction,
    )


def _detect_reverse_line_movement(
    model_pick: str,
    line_direction: str,
    public_betting_pct: dict[str, float] | None,
) -> bool:
    """Detect reverse line movement: public bets one way, line moves the other."""
    if not public_betting_pct:
        return False

    pick_public_pct = safe_float(public_betting_pct.get(model_pick), 0.5)

    if pick_public_pct >= 0.60 and line_direction == "against_model":
        return True
    if pick_public_pct <= 0.40 and line_direction == "toward_model":
        return True

    return False


def _compute_multi_book_consensus(
    model_pick: str,
    multi_book_lines: list[dict[str, Any]] | None,
) -> float:
    """Compute how many books agree on the direction of movement.

    Returns 0-1 where 1 = all books moved in same direction.
    """
    if not multi_book_lines or len(multi_book_lines) < 2:
        return 0.5

    directions: list[int] = []
    for book in multi_book_lines:
        opening = safe_float(book.get("opening", book.get(f"opening_{model_pick}")), None)
        closing = safe_float(book.get("closing", book.get(f"closing_{model_pick}")), None)
        if opening is None or closing is None:
            continue
        diff = closing - opening
        if abs(diff) >= 3:
            directions.append(-1 if diff < 0 else 1)

    if not directions:
        return 0.5

    if all(d == directions[0] for d in directions):
        return 1.0

    majority = max(directions.count(1), directions.count(-1))
    return majority / len(directions)


def sharp_money_risk_factor(signal: LineMovementSignal) -> float:
    """Return 0-1 risk factor for quality control integration.

    High value = sharp money moving against model pick = higher risk.
    """
    if signal.movement_direction == "neutral" and not signal.reverse_line_movement:
        return 0.0

    risk = 0.0

    if signal.movement_direction == "against_model":
        risk += min(signal.movement_magnitude * 0.015, 0.30)

    if signal.reverse_line_movement:
        risk += 0.25

    if signal.steam_move_detected and signal.movement_direction == "against_model":
        risk += 0.20

    if signal.multi_book_consensus >= 0.80 and signal.movement_direction == "against_model":
        risk += 0.15

    if signal.movement_direction == "toward_model":
        risk -= min(signal.movement_magnitude * 0.008, 0.15)

    return clamp(risk, 0.0, 1.0)


def sharp_money_confidence_adjustment(signal: LineMovementSignal) -> str:
    """Return confidence adjustment recommendation based on sharp money."""
    risk = sharp_money_risk_factor(signal)

    if risk >= 0.50:
        return "downgrade_two"
    elif risk >= 0.30:
        return "downgrade_one"
    elif risk <= -0.05:
        return "upgrade_one"
    return "no_change"
