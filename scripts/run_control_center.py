"""Run FastAPI and the React dashboard dev server with one command."""

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


def start_process(command: list[str]) -> subprocess.Popen:
    print(f"Starting: {' '.join(command)}")
    return subprocess.Popen(command, cwd=ROOT)


def main() -> int:
    api_host = os.environ.get("DASHBOARD_API_HOST", "0.0.0.0")
    api_port = os.environ.get("DASHBOARD_API_PORT", "8010")
    web_host = os.environ.get("DASHBOARD_WEB_HOST", "0.0.0.0")
    web_port = os.environ.get("DASHBOARD_WEB_PORT", "5173")

    if not shutil.which(npm_command()):
        print("npm is required for the React dashboard.", file=sys.stderr)
        return 1

    api = start_process(
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
    )
    web = start_process(
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
    )

    print(f"Dashboard API: http://{api_host}:{api_port}")
    print(f"Dashboard Web: http://localhost:{web_port}")

    processes = [api, web]
    try:
        while all(process.poll() is None for process in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
