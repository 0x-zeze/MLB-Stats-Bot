"""Prompt versioning with candidate creation and rollback support."""

from __future__ import annotations

import re
from typing import Any

from .memory_store import read_json, record_evolution_event, utc_now, write_json


def get_prompt_versions() -> dict[str, Any]:
    return read_json("prompt_versions")


def get_active_prompt_version() -> dict[str, Any]:
    payload = get_prompt_versions()
    active = payload.get("active_version")
    for version in payload.get("versions", []):
        if version.get("version") == active:
            return version
    return payload.get("versions", [{}])[0]


def _next_version(current: str) -> str:
    match = re.search(r"v(\d+)\.(\d+)$", current)
    if not match:
        return f"{current}-candidate"
    major, minor = int(match.group(1)), int(match.group(2))
    return re.sub(r"v\d+\.\d+$", f"v{major}.{minor + 1}", current)


def create_prompt_candidate(
    *,
    reason: str,
    changes: list[str],
    source_losses: list[str] | None = None,
    source_gradients: list[str] | None = None,
    backtest_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = get_prompt_versions()
    active = payload.get("active_version", "mlb-analyst-v1.0")
    existing = {version.get("version") for version in payload.get("versions", [])}
    next_version = _next_version(active)
    while next_version in existing:
        next_version = _next_version(next_version)
    candidate = {
        "version": next_version,
        "date_created": utc_now(),
        "reason": reason,
        "changes": changes,
        "previous_version": active,
        "status": "candidate",
        "source_losses": source_losses or [],
        "source_gradients": source_gradients or [],
        "backtest_result": backtest_result,
        "rollback_supported": True,
        "production_update_allowed": False,
    }
    payload.setdefault("versions", []).append(candidate)
    write_json("prompt_versions", payload)
    record_evolution_event("prompt_candidate_created", candidate)
    return candidate


def promote_prompt_candidate(version: str, promotion_result: dict[str, Any]) -> dict[str, Any]:
    if promotion_result.get("status") != "approved":
        raise ValueError("Prompt candidate cannot be promoted without an approved promotion gate result.")
    payload = get_prompt_versions()
    previous_active = payload.get("active_version")
    found = False
    for item in payload.get("versions", []):
        if item.get("version") == previous_active:
            item["status"] = "archived"
        if item.get("version") == version:
            item["status"] = "active"
            item["promotion_result"] = promotion_result
            item["production_update_allowed"] = True
            found = True
    if not found:
        raise KeyError(f"Unknown prompt candidate: {version}")
    payload["active_version"] = version
    write_json("prompt_versions", payload)
    record_evolution_event("prompt_promoted", {"version": version, "previous_version": previous_active})
    return payload


def rollback_prompt_version(target_version: str) -> dict[str, Any]:
    payload = get_prompt_versions()
    versions = payload.get("versions", [])
    if not any(item.get("version") == target_version for item in versions):
        raise KeyError(f"Unknown prompt version: {target_version}")
    current = payload.get("active_version")
    for item in versions:
        if item.get("version") == current:
            item["status"] = "archived"
        if item.get("version") == target_version:
            item["status"] = "active"
    payload["active_version"] = target_version
    write_json("prompt_versions", payload)
    record_evolution_event("prompt_rollback", {"from": current, "to": target_version})
    return payload
