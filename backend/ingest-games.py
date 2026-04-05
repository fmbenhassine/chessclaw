#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import argparse
import os
import sqlite3
import sys

import chess.pgn

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.paths import DATABASE_PATH, DATA_DIRECTORY


DEFAULT_GAMES_DIRECTORY = DATA_DIRECTORY / "games"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Load PGN games into the SQLite games table."
    )
    parser.add_argument(
        "pgn_file",
        nargs="?",
        type=Path,
        help="Optional path to one PGN file to ingest. Defaults to all PGN files under data/games.",
    )
    args = parser.parse_args()

    if not DATABASE_PATH.exists():
        print(
            f"Error: database file not found: {DATABASE_PATH}. Run setup-database.py first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    inserted_count = 0
    existing_count = 0
    pgn_paths = _resolve_input_files(args.pgn_file)

    try:
        with sqlite3.connect(DATABASE_PATH) as connection:
            for pgn_path in pgn_paths:
                print(f"Ingesting games from file: {pgn_path}")
                file_inserted_count, file_existing_count = _ingest_pgn_file(connection, pgn_path)
                inserted_count += file_inserted_count
                existing_count += file_existing_count
    except OSError as exc:
        print(f"Error: could not read PGN file: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    if inserted_count == 0 and existing_count == 0:
        if args.pgn_file is None:
            print(
                f"Error: no PGN games found in {DEFAULT_GAMES_DIRECTORY}.",
                file=sys.stderr,
            )
        else:
            print(f"Error: no PGN games found in {args.pgn_file.expanduser().resolve()}.", file=sys.stderr)
        raise SystemExit(1)


def _resolve_input_files(pgn_file: Path | None) -> list[Path]:
    if pgn_file is not None:
        return [pgn_file.expanduser().resolve()]

    if not DEFAULT_GAMES_DIRECTORY.exists():
        print(
            f"Error: games directory not found: {DEFAULT_GAMES_DIRECTORY}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return sorted(path.resolve() for path in DEFAULT_GAMES_DIRECTORY.rglob("*.pgn"))


def _ingest_pgn_file(
    connection: sqlite3.Connection,
    pgn_path: Path,
) -> tuple[int, int]:
    inserted_count = 0
    existing_count = 0
    try:
        with pgn_path.open(encoding="utf-8") as pgn_handle:
            while True:
                game = chess.pgn.read_game(pgn_handle)
                if game is None:
                    break

                if game.errors:
                    print(f"Error: could not parse PGN file {pgn_path}.", file=sys.stderr)
                    raise SystemExit(1)

                _ensure_allowed_user(game)
                game_row = _build_game_row(game)
                existing_game_id = _find_existing_game_id(connection, game_row)
                if existing_game_id is not None:
                    print("Game already exists.")
                    existing_count += 1
                    continue

                _insert_game(connection, game_row)
                inserted_count += 1
    except OSError as exc:
        print(f"Error: could not read PGN file: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    return inserted_count, existing_count


def _ensure_allowed_user(game: chess.pgn.Game) -> None:
    allowed = [
        value.strip().casefold()
        for value in os.environ.get("CHESSCLAW_ALLOWED_USERNAMES", "").split(",")
        if value.strip()
    ]
    if not allowed:
        return

    white = game.headers.get("White", "").strip().casefold()
    black = game.headers.get("Black", "").strip().casefold()
    if white in allowed or black in allowed:
        return

    print(
        "Error: refusing to ingest a game that does not involve one of the configured ChessClaw usernames.",
        file=sys.stderr,
    )
    raise SystemExit(1)


def _build_game_row(game: chess.pgn.Game) -> dict[str, str]:
    headers = game.headers
    exporter = chess.pgn.StringExporter(headers=False, variations=True, comments=True)
    moves_pgn = game.accept(exporter).strip()
    site = headers.get("Site", "").strip()
    if site == "Chess.com":
        site = headers.get("Link", "").strip()

    return {
        "white": headers.get("White", "").strip(),
        "black": headers.get("Black", "").strip(),
        "result": headers.get("Result", "").strip(),
        "utc_date": headers.get("UTCDate", "").strip(),
        "utc_time": headers.get("UTCTime", "").strip(),
        "white_elo": headers.get("WhiteElo", "").strip(),
        "black_elo": headers.get("BlackElo", "").strip(),
        "eco": headers.get("ECO", "").strip(),
        "termination": headers.get("Termination", "").strip(),
        "site": site,
        "raw_pgn": moves_pgn,
    }


def _insert_game(connection: sqlite3.Connection, game_row: dict[str, str]) -> None:
    connection.execute(
        """
        INSERT INTO games (
            white,
            black,
            result,
            utc_date,
            utc_time,
            white_elo,
            black_elo,
            eco,
            termination,
            site,
            raw_pgn
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            game_row["white"],
            game_row["black"],
            game_row["result"],
            game_row["utc_date"],
            game_row["utc_time"],
            game_row["white_elo"],
            game_row["black_elo"],
            game_row["eco"],
            game_row["termination"],
            game_row["site"],
            game_row["raw_pgn"],
        ),
    )


def _find_existing_game_id(
    connection: sqlite3.Connection,
    game_row: dict[str, str],
) -> int | None:
    row = connection.execute(
        """
        SELECT id
        FROM games
        WHERE white = ?
          AND black = ?
          AND result = ?
          AND utc_date = ?
          AND utc_time = ?
        """,
        (
            game_row["white"],
            game_row["black"],
            game_row["result"],
            game_row["utc_date"],
            game_row["utc_time"],
        ),
    ).fetchone()
    if row is None:
        return None

    return int(row[0])


if __name__ == "__main__":
    main()
