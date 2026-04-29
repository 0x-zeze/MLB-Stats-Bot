"""Run the Telegram bot, FastAPI dashboard API, and React dashboard together."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def node_command() -> str:
    return "node.exe" if os.name == "nt" else "node"


def start_process(command: list[str], env: dict[str, str] | None = None) -> subprocess.Popen:
    print(f"Starting: {' '.join(command)}", flush=True)
    return subprocess.Popen(command, cwd=ROOT, env=env)


def stop_processes(processes: list[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            if os.name == "nt":
                process.terminate()
            else:
                process.send_signal(signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()


def main() -> int:
    api_host = os.environ.get("DASHBOARD_API_HOST", "0.0.0.0")
    api_port = os.environ.get("DASHBOARD_API_PORT", "8010")
    web_host = os.environ.get("DASHBOARD_WEB_HOST", "0.0.0.0")
    web_port = os.environ.get("DASHBOARD_WEB_PORT", "5173")

    if not shutil.which(node_command()):
        print("node is required for the Telegram bot.", file=sys.stderr)
        return 1
    if not shutil.which(npm_command()):
        print("npm is required for the React dashboard.", file=sys.stderr)
        return 1

    bot_env = os.environ.copy()
    # npm start owns the new React/FastAPI dashboard, so keep the legacy Node dashboard off.
    bot_env["DASHBOARD_ENABLED"] = os.environ.get("START_LEGACY_DASHBOARD", "false")

    processes = [
        start_process([node_command(), "src/index.js"], env=bot_env),
        start_process(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "src.dashboard_api:app",
                "--host",
                api_host,
                "--port",
                api_port,
            ]
        ),
        start_process(
            [
                npm_command(),
                "--prefix",
                "dashboard-react",
                "run",
                "dev",
                "--",
                "--host",
                web_host,
                "--port",
                web_port,
            ]
        ),
    ]

    print(f"Telegram bot: running from src/index.js", flush=True)
    print(f"Dashboard API: http://{api_host}:{api_port}", flush=True)
    print(f"Dashboard Web: http://localhost:{web_port}", flush=True)
    print("Use START_LEGACY_DASHBOARD=true only if you also need the old port-3008 dashboard.", flush=True)

    exit_code = 0
    try:
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    exit_code = code
                    raise RuntimeError(f"Process exited with code {code}")
            time.sleep(1)
    except KeyboardInterrupt:
        exit_code = 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr, flush=True)
    finally:
        stop_processes(processes)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
