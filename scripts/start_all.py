"""Run the Telegram bot, FastAPI dashboard API, and React dashboard together."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@dataclass
class ManagedProcess:
    name: str
    command: list[str]
    process: subprocess.Popen


def load_dotenv(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def node_command() -> str:
    return "node.exe" if os.name == "nt" else "node"


def start_process(name: str, command: list[str], env: dict[str, str] | None = None) -> ManagedProcess:
    print(f"Starting {name}: {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, cwd=ROOT, env=env)
    return ManagedProcess(name=name, command=command, process=process)


def stop_processes(processes: list[ManagedProcess]) -> None:
    for managed in processes:
        if managed.process.poll() is None:
            if os.name == "nt":
                managed.process.terminate()
            else:
                managed.process.send_signal(signal.SIGTERM)
    for managed in processes:
        try:
            managed.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            managed.process.kill()


def main() -> int:
    load_dotenv()

    api_host = os.environ.get("DASHBOARD_API_HOST", "127.0.0.1")
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
        start_process("Telegram bot", [node_command(), "src/index.js"], env=bot_env),
        start_process(
            "Dashboard API",
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
            "Dashboard web",
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
            for managed in processes:
                code = managed.process.poll()
                if code is not None:
                    exit_code = code
                    command = " ".join(managed.command)
                    raise RuntimeError(f"{managed.name} exited with code {code}: {command}")
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
