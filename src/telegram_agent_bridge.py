"""Minimal JSON bridge from Telegram bot to Python agent tools."""

from __future__ import annotations

import json
import sys
from typing import Any

from .agent_tools import (
    get_game_context,
    get_today_games,
    predict_moneyline,
    predict_yrfi,
)
from .knowledge.baseball_knowledge import BaseballKnowledgeBase
from .utils import format_probability


KNOWLEDGE_QUESTIONS = {
    "wrc": "Why is wRC+ better than OPS for offense evaluation?",
    "fip": "Why does FIP matter more than ERA for pitcher prediction?",
    "wind": "Why can weather affect run scoring?",
    "bullpen": "Why is bullpen fatigue important for MLB betting?",
    "market": "How do moneyline odds become implied probability?",
    "value": "Why can a team be favored but still not be a good value bet?",
    "markets": "What is the difference between moneyline and YRFI/NRFI?",
    "f5": "What are the best indicators for first 5 innings bets?",
}


def _json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _pct(value: float | None) -> str:
    return format_probability(float(value or 0.0))


def _fmt_number(value: Any, digits: int = 1) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "-"


def _game_label(game: dict[str, Any]) -> str:
    return f"{game.get('away_team')} @ {game.get('home_team')}"


def list_games() -> dict[str, Any]:
    games = [game for game in get_today_games(use_live=False) if not game.get("final")]
    return {
        "text": "Pilih game:",
        "games": [
            {
                "id": str(game["game_id"]),
                "label": _game_label(game),
                "date": game.get("date", ""),
            }
            for game in games
        ],
    }


def game_menu(game_id: str) -> dict[str, Any]:
    context = get_game_context(game_id)
    pitchers = context["probable_pitchers"]
    text = "\n".join(
        [
            "MLB Agent Tools",
            context["matchup"],
            f"Date: {context['date']}",
            f"Park: {context['park'].get('park', '-')}",
            f"SP: {pitchers['away']['pitcher']} vs {pitchers['home']['pitcher']}",
            "",
            "Pilih action:",
        ]
    )
    return {"text": text}


def moneyline(game_id: str) -> dict[str, Any]:
    result = predict_moneyline(game_id)
    market = result.get("market", {})
    edge = result.get("home_edge")
    quality = result.get("quality_report", {})
    lines = [
        "Moneyline",
        result["matchup"],
        f"Pick: {result['predicted_winner']}",
        f"Home: {_pct(result['home_win_probability'])}",
        f"Away: {_pct(result['away_win_probability'])}",
        f"Confidence: {result['confidence']}",
        f"Decision: {result.get('decision', '-')}",
        f"Quality: {quality.get('score', 0)}/100",
    ]
    if market.get("available"):
        lines.append(f"Market ML: home {market.get('home_moneyline')} | away {market.get('away_moneyline')}")
    if edge is not None:
        lines.append(f"Home edge: {edge * 100:+.1f}%")
    if result.get("confidence_adjustments"):
        lines.append(f"Adjustment: {result['confidence_adjustments'][0]}")
    lines.append(f"No-bet: {'YES' if result['no_bet'] else 'NO'}")
    return {"text": "\n".join(lines)}



def yrfi(game_id: str) -> dict[str, Any]:
    result = predict_yrfi(game_id)
    quality = result.get("quality_report", {})
    lines = [
        "YRFI / NRFI",
        result.get("matchup", "-"),
        f"Lean: {result.get('lean', '-')}",
        f"YRFI: {_pct(result.get('yrfi_probability'))}",
        f"NRFI: {_pct(result.get('nrfi_probability'))}",
        f"Confidence: {result.get('confidence', '-')}",
        f"Decision: {result.get('decision', '-')}",
        f"Quality: {quality.get('score', 0)}/100",
        f"No-bet: {'YES' if result.get('no_bet') else 'NO'}",
    ]
    return {"text": "\n".join(lines)}

def context(game_id: str) -> dict[str, Any]:
    item = get_game_context(game_id)
    weather = item.get("weather", {})
    market = item.get("market", {})
    lines = [
        "Game Context",
        item["matchup"],
        f"Park: {item['park'].get('park', '-')}",
        f"Weather: {_fmt_number(weather.get('temperature'))} F, wind {_fmt_number(weather.get('wind_speed'))} {weather.get('wind_direction', '')}",
        f"Home ML: {market.get('home_moneyline', '-') if market.get('available') else '-'}",
        f"Away ML: {market.get('away_moneyline', '-') if market.get('available') else '-'}",
    ]
    return {"text": "\n".join(lines)}


def full(game_id: str) -> dict[str, Any]:
    ml = predict_moneyline(game_id)
    first = predict_yrfi(game_id)
    quality = first.get("quality_report", ml.get("quality_report", {}))
    lines = [
        "MLB Game Analysis",
        ml["matchup"],
        f"ML pick: {ml['predicted_winner']} ({ml['confidence']})",
        f"Home/Away: {_pct(ml['home_win_probability'])} / {_pct(ml['away_win_probability'])}",
        f"YRFI lean: {first.get('lean', '-')} ({first.get('confidence', '-')})",
        f"YRFI/NRFI: {_pct(first.get('yrfi_probability'))} / {_pct(first.get('nrfi_probability'))}",
        f"Decision: ML {ml.get('decision', '-')} | YRFI {first.get('decision', '-')}",
        f"Quality: {quality.get('score', 0)}/100",
        "",
        "Factors:",
        *[f"- {factor}" for factor in (ml.get("main_factors", []) + first.get("main_factors", []))[:4]],
        f"No-bet: {'YES' if ml.get('no_bet') else 'NO'}",
    ]
    return {"text": "\n".join(lines)}


def knowledge(question_key_or_text: str) -> dict[str, Any]:
    question = KNOWLEDGE_QUESTIONS.get(question_key_or_text, question_key_or_text)
    answer = BaseballKnowledgeBase().answer(question, limit=2)
    lines = [
        "Knowledge",
        question,
        "",
        answer.answer.replace("- ", "• "),
    ]
    if answer.sources:
        lines.append("")
        lines.append(f"Source: {answer.sources[0]}")
    return {"text": "\n".join(lines)}


def main(argv: list[str] | None = None) -> None:
    args = argv if argv is not None else sys.argv[1:]
    action = args[0] if args else "games"
    value = args[1] if len(args) > 1 else "0"

    if action == "games":
        _json(list_games())
    elif action == "game":
        _json(game_menu(value))
    elif action == "moneyline":
        _json(moneyline(value))
    elif action == "yrfi":
        _json(yrfi(value))
    elif action == "context":
        _json(context(value))
    elif action == "full":
        _json(full(value))
    elif action == "knowledge":
        _json(knowledge(" ".join(args[1:]) or "wrc"))
    else:
        _json({"text": "Action tidak dikenal."})


if __name__ == "__main__":
    main()
