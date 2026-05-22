"""CLI bridge for evolution memory retrieval.

Exposes retrieve_weighted_memory() from the evolution memory store as a
command-line tool that the Node.js bot can call via child_process.spawn().
"""

from __future__ import annotations

import argparse
import json
import sys

from .evolution.memory_store import retrieve_weighted_memory


def main() -> None:
    parser = argparse.ArgumentParser(description="Evolution memory retrieval bridge")
    parser.add_argument("--context-json", required=True, help="JSON game context")
    parser.add_argument("--top-k", type=int, default=5, help="Number of results")
    parser.add_argument("--min-composite", type=float, default=1.0, help="Minimum composite score")
    args = parser.parse_args()

    try:
        context = json.loads(args.context_json)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON context: {exc}"}), file=sys.stderr)
        sys.exit(1)

    result = retrieve_weighted_memory(
        context, top_k=args.top_k, min_composite=args.min_composite
    )
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
