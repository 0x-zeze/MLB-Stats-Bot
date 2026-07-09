"""Append a MANUALLY-authored evolution rule candidate.

This CLI lets an operator propose a moneyline (or other market) rule candidate
by hand, using the exact same on-disk schema the auto-generator emits
(src/evolution/rule_candidate_generator.py). A manual candidate is NOT a
production change: it is written to data/evolution/rule_candidates.jsonl as a
``pending`` candidate that still MUST clear the backtest + promotion gate like
any auto-generated candidate.

Two things distinguish a manual candidate for auditing:

* ``source: "manual"`` -- the auto-generator never sets ``source``, so this is a
  clean discriminator when auditing where a candidate came from.
* ``candidate_id`` prefixed ``manual-...`` -- avoids any sha1 collision with the
  auto-generator's ``cand-...`` ids.

No-bypass guarantees (nothing here weakens them):

* ``required_backtest: True``, ``backtest_status: "pending"``,
  ``status: "pending"``, ``production_update_allowed: False`` -- identical to the
  generator. A candidate created "now" has ~0 after-rows, so
  evolution_engine.backtest_candidates() marks it ``insufficient_data`` /
  ``deferred`` until enough post-creation outcomes accumulate.
* The promotion gate (promotion_gate._unsafe_change) hard-rejects unsafe text
  regardless of this CLI. This CLI only PRE-WARNS on obviously unsafe wording so
  the operator gets immediate feedback; it never suppresses the gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any

from .memory_store import append_jsonl, read_jsonl

# Accepted candidate types. Mirrors the union produced by the auto-generator's
# _candidate_type() plus threshold_update (in the plan's accepted arg set).
VALID_TYPES = (
    "no_bet_rule",
    "confidence_cap",
    "threshold_update",
    "prompt_update",
    "tool_order_update",
    "symbolic_update",
)

# Wording the promotion gate hard-rejects (promotion_gate._unsafe_change). We
# only warn; the gate remains the enforcer.
_UNSAFE_TOKENS = (
    "remove no bet",
    "disable no bet",
    "bypass no bet",
    "ignore no bet",
)


def _manual_candidate_id(market: str, rule_text: str, candidate_type: str) -> str:
    key = f"{market}|{candidate_type}|{rule_text}"
    digest = hashlib.sha1(f"manual:{key}".encode("utf-8")).hexdigest()[:10]
    return f"manual-{digest}"


def detect_unsafe_wording(candidate_type: str, rule_text: str, reason: str) -> str | None:
    """Return a warning if the wording is one the promotion gate hard-rejects."""
    text = " ".join([candidate_type, rule_text, reason]).lower()
    for token in _UNSAFE_TOKENS:
        if token in text:
            return f"Wording contains '{token}': the promotion gate will reject this."
    if "increase high confidence" in text and "calibration" not in text:
        return (
            "Wording increases high-confidence picks without mentioning "
            "calibration: the promotion gate will reject this."
        )
    return None


def build_manual_candidate(
    *,
    rule: str,
    market: str = "moneyline",
    candidate_type: str = "no_bet_rule",
    reason: str | None = None,
    source_lessons: list[str] | None = None,
    source_losses: list[str] | None = None,
) -> dict[str, Any]:
    """Build a manual candidate dict in the generator's canonical schema.

    Does NOT set ``created_at`` -- append_jsonl() stamps it, exactly as the
    auto-generator relies on.
    """
    if not rule or not rule.strip():
        raise ValueError("rule text must be non-empty")
    if candidate_type not in VALID_TYPES:
        raise ValueError(
            f"invalid type {candidate_type!r}; expected one of {', '.join(VALID_TYPES)}"
        )

    market = market.lower()
    rule = rule.strip()
    return {
        "candidate_id": _manual_candidate_id(market, rule, candidate_type),
        "market": market,
        "type": candidate_type,
        "rule": rule,
        "reason": (reason or "Manually proposed rule candidate.").strip(),
        "source_lessons": list(source_lessons or []),
        "source_losses": list(source_losses or []),
        "required_backtest": True,
        "backtest_status": "pending",
        "status": "pending",
        "production_update_allowed": False,
        "source": "manual",
    }


def add_manual_candidate(
    *,
    rule: str,
    market: str = "moneyline",
    candidate_type: str = "no_bet_rule",
    reason: str | None = None,
    source_lessons: list[str] | None = None,
    source_losses: list[str] | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    """Build and (optionally) persist a manual candidate.

    Idempotent: if a candidate with the same ``candidate_id`` already exists in
    the store, the existing record is returned and nothing new is written.
    """
    candidate = build_manual_candidate(
        rule=rule,
        market=market,
        candidate_type=candidate_type,
        reason=reason,
        source_lessons=source_lessons,
        source_losses=source_losses,
    )
    if not persist:
        return candidate

    for existing in read_jsonl("rule_candidates"):
        if existing.get("candidate_id") == candidate["candidate_id"]:
            return existing

    return append_jsonl("rule_candidates", candidate)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Append a manually-authored evolution rule candidate (pending gate).",
    )
    parser.add_argument("--rule", required=True, help="Free text of the proposed rule.")
    parser.add_argument("--market", default="moneyline", help="Target market (default: moneyline).")
    parser.add_argument(
        "--type",
        dest="candidate_type",
        default="no_bet_rule",
        choices=VALID_TYPES,
        help="Candidate type (default: no_bet_rule).",
    )
    parser.add_argument("--reason", default=None, help="Why this rule is proposed.")
    parser.add_argument(
        "--source-lesson",
        dest="source_lessons",
        action="append",
        default=[],
        help="A source lesson id (repeatable).",
    )
    parser.add_argument(
        "--source-loss",
        dest="source_losses",
        action="append",
        default=[],
        help="A source loss id (repeatable).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and print the candidate without writing it.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    warning = detect_unsafe_wording(args.candidate_type, args.rule, args.reason or "")
    if warning:
        print(f"WARNING: {warning}", file=sys.stderr)

    try:
        candidate = add_manual_candidate(
            rule=args.rule,
            market=args.market,
            candidate_type=args.candidate_type,
            reason=args.reason,
            source_lessons=args.source_lessons,
            source_losses=args.source_losses,
            persist=not args.dry_run,
        )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(candidate, indent=2, sort_keys=True))
    if not args.dry_run:
        print(
            f"\nAppended manual candidate {candidate['candidate_id']} "
            "(pending backtest + promotion gate; NOT a production change).",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
