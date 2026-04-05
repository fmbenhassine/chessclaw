#!/usr/bin/env python3

from pathlib import Path
import csv
import sqlite3
import sys

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.paths import DATABASE_PATH, OPENINGS_DIRECTORY, SQL_INIT_PATH


def main() -> None:
    database_exists = DATABASE_PATH.exists()
    init_sql = SQL_INIT_PATH.read_text(encoding="utf-8")

    with sqlite3.connect(DATABASE_PATH) as connection:
        if not database_exists:
            connection.executescript(init_sql)
        _ensure_indexes(connection)
        _load_openings(connection, OPENINGS_DIRECTORY)


def _ensure_indexes(connection: sqlite3.Connection) -> None:
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_missed_mates_game_id ON missed_mates (game_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_missed_mates_fen ON missed_mates (fen)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_missed_mates_mate_in ON missed_mates (mate_in)"
    )
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_mates_unique_position
            ON missed_mates (game_id, move_number, side, fen, mating_move_uci)
        """
    )


def _load_openings(connection: sqlite3.Connection, openings_directory) -> None:
    existing_row = connection.execute("SELECT 1 FROM openings LIMIT 1").fetchone()
    if existing_row is not None:
        return

    opening_rows: list[tuple[str, str, str]] = []

    for tsv_path in sorted(openings_directory.glob("*.tsv")):
        with tsv_path.open(encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t")
            next(reader, None)

            for row in reader:
                if len(row) != 3:
                    continue

                opening_rows.append((row[0], row[1], row[2]))

    connection.executemany(
        "INSERT INTO openings (eco, name, pgn) VALUES (?, ?, ?)",
        opening_rows,
    )


if __name__ == "__main__":
    main()
