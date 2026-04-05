#!/usr/bin/env python3

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import os
import sqlite3
import sys
from urllib import error, parse, request

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.paths import DATABASE_PATH, DATA_DIRECTORY


GAMES_DIRECTORY = DATA_DIRECTORY / "games"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download chess games for one user from Lichess or Chess.com."
    )
    parser.add_argument("username", help="Platform username")
    parser.add_argument(
        "--mode",
        choices=("init", "sync"),
        required=True,
        help="Whether to download all games or only games after the latest stored one.",
    )
    parser.add_argument(
        "--platform",
        choices=("lichess", "chesscom"),
        required=True,
        help="Game platform to download from.",
    )
    args = parser.parse_args()

    username = args.username.strip()
    if args.platform == "lichess":
        if args.mode == "init":
            _run_lichess_init(username)
        else:
            _run_lichess_sync(username)
        return

    if args.mode == "init":
        _run_chesscom_init(username)
    else:
        _run_chesscom_sync(username)


def _run_lichess_init(username: str) -> None:
    output_directory = _platform_games_directory("lichess", username)
    output_directory.mkdir(parents=True, exist_ok=True)
    output_path = output_directory / f"lichess-{username}.pgn"
    url = f"https://lichess.org/api/games/user/{username}"
    body = _fetch_text(url, headers=_build_lichess_headers())
    output_path.write_text(body, encoding="utf-8")
    print(output_path)


def _run_lichess_sync(username: str) -> None:
    connection = _open_database_for_sync()
    with connection:
        latest_game = _find_latest_game(
            connection=connection,
            username=username,
            site_pattern="lichess",
        )

    if latest_game is None:
        print(f"Error: no Lichess games found in the database for {username}.", file=sys.stderr)
        raise SystemExit(1)

    utc_date, utc_time = latest_game
    since_timestamp = _to_unix_epoch_millis(utc_date, utc_time)
    formatted_datetime = _format_filename_datetime(utc_date, utc_time)
    query = parse.urlencode({"since": since_timestamp})
    url = f"https://lichess.org/api/games/user/{username}?{query}"
    output_directory = _platform_games_directory("lichess", username)
    output_directory.mkdir(parents=True, exist_ok=True)
    output_path = output_directory / f"lichess-{username}-since-{formatted_datetime}.pgn"

    body = _fetch_text(url, headers=_build_lichess_headers())
    output_path.write_text(body, encoding="utf-8")
    print(output_path)


def _run_chesscom_init(username: str) -> None:
    output_directory = _platform_games_directory("chesscom", username)
    output_directory.mkdir(parents=True, exist_ok=True)

    archives_url = f"https://api.chess.com/pub/player/{username}/games/archives"
    archives_payload = _fetch_text(archives_url)
    try:
        archives_data = json.loads(archives_payload)
    except json.JSONDecodeError as exc:
        print("Error: failed to parse Chess.com archives response.", file=sys.stderr)
        raise SystemExit(1) from exc

    archives = archives_data.get("archives")
    if not isinstance(archives, list):
        print("Error: Chess.com archives response did not include an archives list.", file=sys.stderr)
        raise SystemExit(1)

    for archive_url in archives:
        if not isinstance(archive_url, str):
            continue

        year, month = _extract_archive_year_month(archive_url)
        output_path = output_directory / f"{year}-{month}.pgn"
        body = _fetch_text(f"{archive_url}/pgn")
        output_path.write_text(body, encoding="utf-8")
        print(output_path)


def _run_chesscom_sync(username: str) -> None:
    connection = _open_database_for_sync()
    with connection:
        latest_game = _find_latest_game(
            connection=connection,
            username=username,
            site_pattern="chess.com",
        )

    if latest_game is None:
        print(
            f"Error: no Chess.com games found in the database for {username}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    utc_date, utc_time = latest_game
    year, month = _extract_database_year_month(utc_date)
    formatted_datetime = _format_filename_datetime(utc_date, utc_time)
    url = f"https://api.chess.com/pub/player/{username}/games/{year}/{month}/pgn"
    output_directory = _platform_games_directory("chesscom", username)
    output_directory.mkdir(parents=True, exist_ok=True)
    output_path = output_directory / f"chesscom-{username}-since-{formatted_datetime}.pgn"

    body = _fetch_text(url)
    output_path.write_text(body, encoding="utf-8")
    print(output_path)


def _open_database_for_sync() -> sqlite3.Connection:
    if not DATABASE_PATH.exists():
        print(
            f"Error: database file not found: {DATABASE_PATH}. Run setup-database.py first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return sqlite3.connect(DATABASE_PATH)


def _find_latest_game(
    connection: sqlite3.Connection,
    *,
    username: str,
    site_pattern: str,
) -> tuple[str, str] | None:
    row = connection.execute(
        """
        SELECT utc_date, utc_time
        FROM games
        WHERE instr(lower(site), lower(?)) > 0
          AND (lower(white) = lower(?) OR lower(black) = lower(?))
          AND utc_date <> ''
          AND utc_time <> ''
        ORDER BY utc_date DESC, utc_time DESC
        LIMIT 1
        """,
        (site_pattern, username, username),
    ).fetchone()
    if row is None:
        return None

    return str(row[0]), str(row[1])


def _build_lichess_headers() -> dict[str, str]:
    api_key = os.environ.get("LICHESS_API_KEY", "").strip()
    if not api_key:
        return {}

    return {"Authorization": f"Bearer {api_key}"}


def _platform_games_directory(platform: str, username: str) -> Path:
    return GAMES_DIRECTORY / f"{platform}-{username}-games"


def _fetch_text(url: str, *, headers: dict[str, str] | None = None) -> str:
    try:
        http_request = request.Request(url, headers=headers or {})
        with request.urlopen(http_request) as response:
            return response.read().decode("utf-8")
    except error.HTTPError as exc:
        print(f"Error: failed to download {url}: HTTP {exc.code}", file=sys.stderr)
        raise SystemExit(1) from exc
    except error.URLError as exc:
        print(f"Error: failed to download {url}: {exc.reason}", file=sys.stderr)
        raise SystemExit(1) from exc


def _extract_archive_year_month(archive_url: str) -> tuple[str, str]:
    parts = archive_url.rstrip("/").split("/")
    if len(parts) < 2:
        print(f"Error: invalid archive URL: {archive_url}", file=sys.stderr)
        raise SystemExit(1)

    return parts[-2], parts[-1]


def _extract_database_year_month(utc_date: str) -> tuple[str, str]:
    parts = utc_date.split(".")
    if len(parts) != 3:
        print(f"Error: invalid UTCDate value: {utc_date}", file=sys.stderr)
        raise SystemExit(1)

    return parts[0], parts[1]


def _to_unix_epoch_millis(utc_date: str, utc_time: str) -> int:
    dt = datetime.strptime(f"{utc_date} {utc_time}", "%Y.%m.%d %H:%M:%S").replace(
        tzinfo=timezone.utc
    )
    return int(dt.timestamp() * 1000)


def _format_filename_datetime(utc_date: str, utc_time: str) -> str:
    return f"{utc_date.replace('.', '-')}-{utc_time.replace(':', '-')}"


if __name__ == "__main__":
    main()
