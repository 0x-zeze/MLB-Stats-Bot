"""Create a local Python virtualenv and install backend dependencies."""

from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = ROOT / ".venv"


def python_bin() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def update_env() -> None:
    env_path = ROOT / ".env"
    python_value = str(python_bin())
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    replaced = False
    next_lines: list[str] = []

    for line in lines:
        if line.startswith("PYTHON_BIN="):
            next_lines.append(f"PYTHON_BIN={python_value}")
            replaced = True
        else:
            next_lines.append(line)

    if not replaced:
        if next_lines and next_lines[-1].strip():
            next_lines.append("")
        next_lines.append(f"PYTHON_BIN={python_value}")

    env_path.write_text("\n".join(next_lines) + "\n", encoding="utf-8")


def main() -> int:
    print(f"Creating Python virtualenv: {VENV_DIR}", flush=True)
    venv.EnvBuilder(with_pip=True, clear=False).create(VENV_DIR)

    python = str(python_bin())
    subprocess.check_call([python, "-m", "pip", "install", "--upgrade", "pip"], cwd=ROOT)
    subprocess.check_call([python, "-m", "pip", "install", "-r", "requirements.txt"], cwd=ROOT)
    update_env()

    print(f"Python backend ready: {python}", flush=True)
    print("Updated .env PYTHON_BIN to use this virtualenv.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
