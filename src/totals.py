"""MLB total-runs and over/under prediction module."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .bullpen import BullpenUsage, bullpen_fatigue_adjustment
from .data_loader import PitcherStats, TeamStats
from .lineup import LineupContext, lineup_adjustment
from .park_factors import ParkFactors, park_factor_adjustment
from .utils import clamp, confidence_label, format_probability, safe_float
from .weather import WeatherContext, weather_adjustment

COMMON_TOTAL_LINES = (6.5, 7.5, 8.5, 9.5, 10.5, 11.5)
LEAGUE_AVERAGE_TOTAL_RUNS = 8.8


@dataclass(frozen=True)
class GameTotalContext:
    """Context inputs for total-runs projection."""

    home_pitcher: PitcherStats | None = None
    away_pitcher: PitcherStats | None = None
    home_lineup: LineupContext | None = None
    away_lineup: LineupContext | None = None
    home_bullpen: BullpenUsage | None = None
    away_bullpen: BullpenUsage | None = None
    weather: WeatherContext | None = None
    park: ParkFactors | None = None
    umpire_adjustment: float = 0.0
    league_average_total_runs: float = LEAGUE_AVERAGE_TOTAL_RUNS


@dataclass(frozen=True)
class TotalPredictionResult:
    """Final total-runs projection payload."""

    home_expected_runs: float
    away_expected_runs: float
    projected_total_runs: float
    market_total: float | None
    over_probabilities: dict[float, float]
    under_probabilities: dict[float, float]
    best_total_lean: str
    confidence: str
    model_edge: float | None
    main_factors: list[str] = field(default_factory=list)

    def format(self) -> str:
        """Render a CLI-friendly total-runs output."""
        lines = [
            "Total Runs Prediction:",
            f"Home expected runs: {self.home_expected_runs:.1f}",
            f"Away expected runs: {self.away_expected_runs:.1f}",
            f"Projected total runs: {self.projected_total_runs:.1f}",
        ]
        if self.market_total is not None:
            lines.append(f"Market total: {self.market_total:.1f}")

        lines.extend(["", "Over/Under Probability:"])
        for line in COMMON_TOTAL_LINES:
            lines.append(f"Over {line:.1f}: {format_probability(self.over_probabilities[line])}")
        for line in COMMON_TOTAL_LINES:
            lines.append(f"Under {line:.1f}: {format_probability(self.under_probabilities[line])}")

        lines.extend(["", "Best Total Lean:", f"Lean: {self.best_total_lean}", f"Confidence: {self.confidence}"])
        if self.model_edge is not None:
            lines.append(f"Model edge: {self.model_edge * 100:+.1f}%")

        lines.append("")
        lines.append("Main Factors:")
        lines.extend(f"- {factor}" for factor in self.main_factors)
        return "\n".join(lines)


def _value(obj: Any, name: str, default: float = 0.0) -> float:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return safe_float(obj.get(name), default)
    return safe_float(getattr(obj, name, None), default)


def _offense_adjustment(team: TeamStats, opponent_pitcher: PitcherStats | None) -> float:
    pitcher_hand = "rhp"
    split_ops = _value(team, "ops_vs_rhp", _value(team, "ops", 0.720))
    split_wrc = _value(team, "wrc_plus_vs_rhp", _value(team, "wrc_plus", 100.0))

    if opponent_pitcher is not None:
        # Sample data does not carry handedness yet; keep this hook ready for real feeds.
        pitcher_hand = str(getattr(opponent_pitcher, "handedness", "rhp")).lower()
        if pitcher_hand == "lhp":
            split_ops = _value(team, "ops_vs_lhp", split_ops)
            split_wrc = _value(team, "wrc_plus_vs_lhp", split_wrc)

    run_adj = (_value(team, "runs_per_game", 4.4) - 4.4) * 0.45
    ops_adj = (split_ops - 0.720) * 2.3
    wrc_adj = (split_wrc - 100.0) * 0.012
    woba_adj = (_value(team, "woba", 0.315) - 0.315) * 2.2
    xwoba_adj = (_value(team, "xwoba", 0.315) - 0.315) * 2.0
    xslg_adj = (_value(team, "xslg", 0.400) - 0.400) * 1.2
    barrel_adj = (_value(team, "barrel_rate", 0.08) - 0.08) * 2.0
    hard_hit_adj = (_value(team, "hard_hit_rate", 0.39) - 0.39) * 0.9
    k_adj = (0.22 - _value(team, "strikeout_rate", 0.22)) * 1.1
    walk_adj = (_value(team, "walk_rate", 0.085) - 0.085) * 1.5
    return clamp(
        run_adj
        + ops_adj
        + wrc_adj
        + woba_adj
        + xwoba_adj
        + xslg_adj
        + barrel_adj
        + hard_hit_adj
        + k_adj
        + walk_adj,
        -1.3,
        1.3,
    )


def _starting_pitcher_adjustment(pitcher: PitcherStats | None) -> float:
    if pitcher is None:
        return 0.0

    era_adj = (_value(pitcher, "era", 4.20) - 4.20) * 0.16
    fip_adj = (_value(pitcher, "fip", 4.20) - 4.20) * 0.13
    xfip_adj = (_value(pitcher, "xfip", 4.20) - 4.20) * 0.10
    whip_adj = (_value(pitcher, "whip", 1.30) - 1.30) * 0.85
    k_adj = (0.22 - _value(pitcher, "k_rate", 0.22)) * 1.1
    bb_adj = (_value(pitcher, "bb_rate", 0.085) - 0.085) * 1.4
    hr_adj = (_value(pitcher, "hr_per_9", 1.10) - 1.10) * 0.28
    xwoba_adj = (_value(pitcher, "xwoba_allowed", 0.315) - 0.315) * 2.0
    hard_hit_adj = (_value(pitcher, "hard_hit_rate_allowed", 0.39) - 0.39) * 0.75
    barrel_adj = (_value(pitcher, "barrel_rate_allowed", 0.08) - 0.08) * 1.7
    pitch_count_adj = max(0.0, _value(pitcher, "pitch_count_last_start", 88.0) - 100.0) * 0.006
    rest_adj = -0.08 if _value(pitcher, "days_rest", 5.0) >= 6.0 else 0.0
    if _value(pitcher, "days_rest", 5.0) <= 3.0:
        rest_adj = 0.12
    recent_adj = (_value(pitcher, "recent_3_start_era", _value(pitcher, "era", 4.20)) - 4.20) * 0.08
    return clamp(
        era_adj
        + fip_adj
        + xfip_adj
        + whip_adj
        + k_adj
        + bb_adj
        + hr_adj
        + xwoba_adj
        + hard_hit_adj
        + barrel_adj
        + pitch_count_adj
        + rest_adj
        + recent_adj,
        -1.4,
        1.4,
    )


def _team_bullpen_quality_adjustment(team: TeamStats) -> float:
    era_adj = (_value(team, "bullpen_era", 4.10) - 4.10) * 0.10
    fip_adj = (_value(team, "bullpen_fip", 4.10) - 4.10) * 0.08
    whip_adj = (_value(team, "bullpen_whip", 1.30) - 1.30) * 0.55
    recent_adj = (_value(team, "bullpen_era_last_7", 4.10) - 4.10) * 0.06
    return clamp(era_adj + fip_adj + whip_adj + recent_adj, -0.6, 0.8)


def _recent_form_adjustment(team: TeamStats, opponent: TeamStats) -> float:
    team_runs = (_value(team, "runs_last_5", 22.0) / 5.0 - 4.4) * 0.16
    opp_allowed = (_value(opponent, "runs_allowed_last_5", 22.0) / 5.0 - 4.4) * 0.12
    ops_recent = (_value(team, "ops_last_7_days", _value(team, "ops", 0.720)) - 0.720) * 0.8
    return clamp(team_runs + opp_allowed + ops_recent, -0.55, 0.55)


def project_team_runs(
    home_team: TeamStats,
    away_team: TeamStats,
    game_context: GameTotalContext | dict[str, Any],
) -> tuple[float, float]:
    """Project home and away expected runs from team, pitcher, and context features."""
    if isinstance(game_context, dict):
        context = GameTotalContext(**game_context)
    else:
        context = game_context

    base_team_runs = context.league_average_total_runs / 2.0
    park_adj = park_factor_adjustment(context.park) / 2.0
    weather_adj = weather_adjustment(context.weather) / 2.0
    umpire_adj = context.umpire_adjustment / 2.0

    home_runs = (
        base_team_runs
        + 0.10
        + _offense_adjustment(home_team, context.away_pitcher)
        + _starting_pitcher_adjustment(context.away_pitcher)
        + _team_bullpen_quality_adjustment(away_team)
        + bullpen_fatigue_adjustment(context.away_bullpen)
        + lineup_adjustment(context.home_lineup)
        + _recent_form_adjustment(home_team, away_team)
        + park_adj
        + weather_adj
        + umpire_adj
    )
    away_runs = (
        base_team_runs
        + _offense_adjustment(away_team, context.home_pitcher)
        + _starting_pitcher_adjustment(context.home_pitcher)
        + _team_bullpen_quality_adjustment(home_team)
        + bullpen_fatigue_adjustment(context.home_bullpen)
        + lineup_adjustment(context.away_lineup)
        + _recent_form_adjustment(away_team, home_team)
        + park_adj
        + weather_adj
        + umpire_adj
    )
    return clamp(home_runs, 1.5, 8.5), clamp(away_runs, 1.5, 8.5)


def project_total_runs(home_expected_runs: float, away_expected_runs: float) -> float:
    """Return total expected runs from team-level projections."""
    return max(0.0, safe_float(home_expected_runs) + safe_float(away_expected_runs))


def _poisson_cdf(expected_total_runs: float, max_runs: int) -> float:
    mean = max(0.01, safe_float(expected_total_runs, 0.01))
    probability = math.exp(-mean)
    cumulative = probability
    for runs in range(1, max_runs + 1):
        probability *= mean / runs
        cumulative += probability
    return clamp(cumulative, 0.0, 1.0)


def poisson_total_probability(expected_total_runs: float, line: float, side: str = "over") -> float:
    """Return probability of total going over or under a half-run line."""
    cutoff = math.floor(safe_float(line))
    under = _poisson_cdf(expected_total_runs, cutoff)
    return 1.0 - under if side.lower() == "over" else under


def negative_binomial_total_probability(
    expected_total_runs: float,
    variance: float,
    line: float,
    side: str = "over",
) -> float:
    """Return over/under probability with over-dispersed run scoring."""
    mean = max(0.01, safe_float(expected_total_runs, 0.01))
    variance_value = safe_float(variance, mean)
    if variance_value <= mean:
        return poisson_total_probability(mean, line, side)

    r = mean**2 / (variance_value - mean)
    p = r / (r + mean)
    cutoff = math.floor(safe_float(line))
    cumulative = 0.0
    for runs in range(cutoff + 1):
        log_prob = (
            math.lgamma(runs + r)
            - math.lgamma(r)
            - math.lgamma(runs + 1)
            + r * math.log(p)
            + runs * math.log(1.0 - p)
        )
        cumulative += math.exp(log_prob)
    under = clamp(cumulative, 0.0, 1.0)
    return 1.0 - under if side.lower() == "over" else under


def calculate_total_edge(model_probability: float, market_probability: float) -> float:
    """Return model probability minus market implied probability."""
    return safe_float(model_probability) - safe_float(market_probability)


def classify_total_bet(
    projected_total: float,
    market_total: float,
    over_probability: float,
    under_probability: float,
) -> dict[str, Any]:
    """Classify the best total lean and confidence."""
    total_diff = safe_float(projected_total) - safe_float(market_total)
    if total_diff >= 0.35 and over_probability >= under_probability:
        lean = f"Over {market_total:.1f}"
        probability = over_probability
    elif total_diff <= -0.35 and under_probability > over_probability:
        lean = f"Under {market_total:.1f}"
        probability = under_probability
    else:
        lean = "No clear total lean"
        probability = max(over_probability, under_probability)

    edge = probability - 0.50
    confidence = confidence_label(probability)
    if lean == "No clear total lean":
        confidence = "Low"

    return {"lean": lean, "confidence": confidence, "edge": edge}


def predict_total_runs(
    home_team: TeamStats,
    away_team: TeamStats,
    context: GameTotalContext,
    market_total: float | None = None,
    market_probability: float | None = None,
) -> TotalPredictionResult:
    """Build a full total-runs projection with common over/under lines."""
    home_expected, away_expected = project_team_runs(home_team, away_team, context)
    projected_total = project_total_runs(home_expected, away_expected)
    variance = max(projected_total * 1.25, projected_total + 1.0)
    over = {
        line: negative_binomial_total_probability(projected_total, variance, line, "over")
        for line in COMMON_TOTAL_LINES
    }
    under = {
        line: negative_binomial_total_probability(projected_total, variance, line, "under")
        for line in COMMON_TOTAL_LINES
    }

    target_total = safe_float(market_total, 8.5) if market_total is not None else 8.5
    target_over = over.get(target_total) or negative_binomial_total_probability(
        projected_total, variance, target_total, "over"
    )
    target_under = under.get(target_total) or negative_binomial_total_probability(
        projected_total, variance, target_total, "under"
    )
    classification = classify_total_bet(projected_total, target_total, target_over, target_under)
    model_edge = (
        calculate_total_edge(target_over if "Over" in classification["lean"] else target_under, market_probability)
        if market_probability is not None and classification["lean"] != "No clear total lean"
        else classification["edge"]
    )

    return TotalPredictionResult(
        home_expected_runs=home_expected,
        away_expected_runs=away_expected,
        projected_total_runs=projected_total,
        market_total=market_total,
        over_probabilities=over,
        under_probabilities=under,
        best_total_lean=classification["lean"],
        confidence=classification["confidence"],
        model_edge=model_edge,
        main_factors=total_main_factors(context, projected_total, target_total),
    )


def total_main_factors(
    context: GameTotalContext,
    projected_total: float,
    market_total: float,
) -> list[str]:
    """Explain the biggest total-runs inputs in plain English."""
    factors: list[str] = []
    if projected_total > market_total + 0.35:
        factors.append("Projected total is above the market number")
    elif projected_total < market_total - 0.35:
        factors.append("Projected total is below the market number")

    park_adj = park_factor_adjustment(context.park)
    if park_adj >= 0.20:
        factors.append("Hitter-friendly park factor")
    elif park_adj <= -0.20:
        factors.append("Pitcher-friendly park factor")

    weather_adj = weather_adjustment(context.weather)
    if weather_adj >= 0.20:
        factors.append("Warm or hitter-friendly weather profile")
    elif weather_adj <= -0.20:
        factors.append("Run-suppressing weather profile")

    if bullpen_fatigue_adjustment(context.away_bullpen) >= 0.20:
        factors.append("Away bullpen used heavily or missing leverage arms")
    if bullpen_fatigue_adjustment(context.home_bullpen) >= 0.20:
        factors.append("Home bullpen used heavily or missing leverage arms")

    if lineup_adjustment(context.home_lineup) + lineup_adjustment(context.away_lineup) >= 0.20:
        factors.append("Strong or mostly confirmed lineup context")
    if lineup_adjustment(context.home_lineup) + lineup_adjustment(context.away_lineup) <= -0.20:
        factors.append("Lineup availability reduces run expectation")

    return factors[:5] or ["Balanced total profile with no extreme run-environment signal"]
