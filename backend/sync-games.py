#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import argparse
import subprocess
import sys


SCRIPTS_DIRECTORY = Path(__file__).resolve().parent
DOWNLOAD_SCRIPT = SCRIPTS_DIRECTORY / "download-games.py"
INGEST_SCRIPT = SCRIPTS_DIRECTORY / "ingest-games.py"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download recent games for one user, ingest them, then remove the downloaded file."
    )
    parser.add_argument("username", help="Platform username")
    parser.add_argument(
        "--platform",
        choices=("lichess", "chesscom"),
        help="Game platform to sync from. Omit to sync both platforms.",
    )
    args = parser.parse_args()

    username = args.username.strip()
    platforms = [args.platform] if args.platform else ["lichess", "chesscom"]

    for platform in platforms:
        downloaded_path = _download_games(username, platform)
        _ingest_games(downloaded_path)
        downloaded_path.unlink()
        print(f"Removed downloaded file: {downloaded_path}")


def _download_games(username: str, platform: str) -> Path:
    result = subprocess.run(
        [
            sys.executable,
            str(DOWNLOAD_SCRIPT),
            username,
            "--platform",
            platform,
            "--mode",
            "sync",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    _forward_output(result)

    output_lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not output_lines:
        print("Error: download script did not report an output file.", file=sys.stderr)
        raise SystemExit(1)

    downloaded_path = Path(output_lines[-1]).expanduser().resolve()
    if not downloaded_path.exists():
        print(f"Error: downloaded file not found: {downloaded_path}", file=sys.stderr)
        raise SystemExit(1)

    return downloaded_path


def _ingest_games(downloaded_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(INGEST_SCRIPT), str(downloaded_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    _forward_output(result)


def _forward_output(result: subprocess.CompletedProcess[str]) -> None:
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)


if __name__ == "__main__":
    main()
