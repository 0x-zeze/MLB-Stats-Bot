"""CLV (Closing Line Value) driven model reweighting.

CLV is the difference between the odds at which we placed a bet and the
closing odds. Positive CLV over a large sample is the strongest indicator
of long-term profitability — stronger than win/loss record.

This module:
- Tracks CLV per pick, per confidence band, per market segment
- Reweights model confidence based on historical CLV performance
- Identifies segments where the model consistently beats or trails the market
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import mean
from typing import Any

from .utils import clamp, safe_float

MIN_CLV_SAMPLE = 20
STRONG_CLV_THRESHOLD = 2.0  # cents of CLV
WEAK_CLV_THRESHOLD = -2.0


@dataclass
class CLVRecord:
    """A single bet's CLV data point."""

    decision_id: str
    market: str
    team: str
    recommended_odds: float  # American odds at bet time
    closing_odds: float  # American odds at first pitch
    edge: float
    confidence: str
    result: str = ""
    segment: str = ""


@dataclass
class CLVSummary:
    """Aggregated CLV stats for a segment."""

    sample_size: int = 0
    avg_clv_cents: float = 0.0
    median_clv_cents: float = 0.0
    positive_clv_pct: float = 0.0
    roi: float = 0.0
    win_rate: float = 0.0


def american_to_cents(odds: float) -> float:
    """Normalize American odds to a cents scale for CLV comparison.

    -150 favorite = 150 cents favorite
    +150 underdog = -150 cents (i.e. 150 cents underdog)
    """
    if odds > 0:
        return -odds
    return abs(odds)


def clv_cents(recommended_odds: float, closing_odds: float) -> float:
    """Return CLV in cents (positive = bet got better number than close).

    If we bet at -130 and it closed at -150, we got +20 cents of value.
    """
    bet_cents = american_to_cents(safe_float(recommended_odds, 0.0))
    close_cents = american_to_cents(safe_float(closing_odds, 0.0))
    return close_cents - bet_cents


def summarize_clv(records: list[CLVRecord]) -> CLVSummary:
    """Aggregate CLV stats across a list of records."""
    if not records:
        return CLVSummary()

    clv_values = [clv_cents(r.recommended_odds, r.closing_odds) for r in records]
    positive = sum(1 for v in clv_values if v > 0)
    wins = sum(1 for r in records if r.result == "win")
    settled = [r for r in records if r.result in ("win", "loss")]

    return CLVSummary(
        sample_size=len(records),
        avg_clv_cents=round(mean(clv_values), 2),
        median_clv_cents=round(sorted(clv_values)[len(clv_values) // 2], 2),
        positive_clv_pct=positive / len(records),
        roi=0.0,  # computed by caller with profit data
        win_rate=wins / max(len(settled), 1) if settled else 0.0,
    )


def clv_confidence_multiplier(summary: CLVSummary) -> float:
    """Return a 0.85-1.15 multiplier for model confidence based on CLV.

    Strong positive CLV → boost confidence (model is beating the market).
    Negative CLV → reduce confidence (model is trailing the market).
    """
    if summary.sample_size < MIN_CLV_SAMPLE:
        return 1.0

    avg = summary.avg_clv_cents
    if avg >= STRONG_CLV_THRESHOLD:
        return clamp(1.0 + min(avg / 20.0, 0.15), 1.0, 1.15)
    if avg <= WEAK_CLV_THRESHOLD:
        return clamp(1.0 + max(avg / 20.0, -0.15), 0.85, 1.0)
    return 1.0


def clv_segment_report(records: list[CLVRecord], segment_key: str = "confidence") -> dict[str, CLVSummary]:
    """Break down CLV by a segment key (confidence, market, segment)."""
    groups: dict[str, list[CLVRecord]] = {}
    for record in records:
        key = getattr(record, segment_key, "unknown") or "unknown"
        groups.setdefault(str(key), []).append(record)

    return {key: summarize_clv(recs) for key, recs in groups.items()}


def should_downgrade_on_clv(summary: CLVSummary) -> tuple[bool, str]:
    """Return (should_downgrade, reason) for a segment with poor CLV."""
    if summary.sample_size < MIN_CLV_SAMPLE:
        return False, ""
    if summary.avg_clv_cents <= WEAK_CLV_THRESHOLD:
        return True, f"negative CLV trend ({summary.avg_clv_cents:.1f}c avg over {summary.sample_size} bets)"
    return False, ""


def should_upgrade_on_clv(summary: CLVSummary) -> tuple[bool, str]:
    """Return (should_upgrade, reason) for a segment with strong CLV."""
    if summary.sample_size < MIN_CLV_SAMPLE:
        return False, ""
    if summary.avg_clv_cents >= STRONG_CLV_THRESHOLD and summary.positive_clv_pct >= 0.55:
        return True, f"positive CLV trend ({summary.avg_clv_cents:.1f}c avg over {summary.sample_size} bets)"
    return False, ""
