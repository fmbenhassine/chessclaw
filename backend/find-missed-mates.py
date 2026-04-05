#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import argparse
import importlib.util
import sqlite3
import sys

import chess

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.engine import EngineConfig, StockfishEngine
from backend.game import InvalidPgnError, load_game_from_database
from backend.paths import DATABASE_PATH


def _load_find_missed_mates() -> callable:
    module_path = Path(__file__).with_name("missed-mates.py")
    spec = importlib.util.spec_from_file_location("backend.missed_mates_cli", module_path)
    if spec is None or spec.loader is None:
        print(f"Error: could not load missed-mates module: {module_path}.", file=sys.stderr)
        raise SystemExit(1)

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.find_missed_mates


FIND_MISSED_MATES = _load_find_missed_mates()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze stored games for missed mate opportunities and persist the results."
    )
    parser.add_argument("player_name", help="Player name to analyze.")
    parser.add_argument(
        "game_id",
        nargs="?",
        type=int,
        help="Database id of the game to analyze. Omit to run batch mode.",
    )
    args = parser.parse_args()

    try:
        total_inserted_rows = 0
        with sqlite3.connect(str(DATABASE_PATH)) as connection, StockfishEngine(
            EngineConfig.load()
        ) as engine:
            if args.game_id is not None:
                _log_game_analysis(connection, args.game_id)
                total_inserted_rows = _analyze_one_game(
                    connection=connection,
                    engine=engine,
                    game_id=args.game_id,
                    player_name=args.player_name,
                )
                connection.commit()
            else:
                game_ids = _find_unanalyzed_game_ids(connection, args.player_name)
                print(f"Found {len(game_ids)} non-analyzed games.")
                for game_id in game_ids:
                    _log_game_analysis(connection, game_id)
                    total_inserted_rows += _analyze_one_game(
                        connection=connection,
                        engine=engine,
                        game_id=game_id,
                        player_name=args.player_name,
                    )
                    connection.commit()
    except sqlite3.Error as exc:
        print(f"Error: database failure: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    print(f"Inserted {total_inserted_rows} analysis rows.")


def _analyze_one_game(
    connection: sqlite3.Connection,
    engine: StockfishEngine,
    game_id: int,
    player_name: str,
) -> int:
    if _has_existing_analysis(connection, game_id):
        print(f"Skipping game {game_id}: analysis already exists.")
        return 0

    game_row = load_game_from_database(connection, game_id)
    if game_row is None:
        print(f"Error: no game found with id {game_id}.", file=sys.stderr)
        raise SystemExit(1)

    side = _resolve_player_side(game_row.white, game_row.black, player_name)
    if side is None:
        print(
            f"Error: player '{player_name}' is not part of game {game_id}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    try:
        game = game_row.to_pgn_game()
    except InvalidPgnError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    missed_mates = FIND_MISSED_MATES(game=game, side=side, engine=engine)

    if missed_mates:
        connection.executemany(
            """
            INSERT INTO missed_mates (
                game_id,
                move_number,
                side,
                fen,
                played_san,
                mating_move_san,
                mating_move_uci,
                mate_in
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    game_id,
                    missed_mate.move_number,
                    missed_mate.side,
                    missed_mate.fen,
                    missed_mate.played_san,
                    missed_mate.mating_move_san,
                    missed_mate.mating_move_uci,
                    missed_mate.mate_in,
                )
                for missed_mate in missed_mates
            ],
        )
        return len(missed_mates)

    player_side = "White" if side == chess.WHITE else "Black"
    connection.execute(
        """
        INSERT INTO missed_mates (game_id, side) VALUES (?, ?)
        """,
        (game_id, player_side),
    )
    return 1


def _has_existing_analysis(connection: sqlite3.Connection, game_id: int) -> bool:
    row = connection.execute(
        """
        SELECT 1
        FROM missed_mates
        WHERE game_id = ?
        LIMIT 1
        """,
        (game_id,),
    ).fetchone()
    return row is not None


def _find_unanalyzed_game_ids(
    connection: sqlite3.Connection,
    player_name: str,
) -> list[int]:
    rows = connection.execute(
        """
        SELECT games.id
        FROM games
        WHERE (lower(games.white) = lower(?) OR lower(games.black) = lower(?))
          AND NOT EXISTS (
              SELECT 1
              FROM missed_mates
              WHERE missed_mates.game_id = games.id
          )
        ORDER BY games.id
        """,
        (player_name, player_name),
    ).fetchall()
    return [int(row[0]) for row in rows]


def _log_game_analysis(connection: sqlite3.Connection, game_id: int) -> None:
    game_row = load_game_from_database(connection, game_id)
    if game_row is None:
        print(f"Analyzing game {game_id}")
        return

    platform = _resolve_platform_name(game_row.site)
    utc_datetime = f"{game_row.utc_date} {game_row.utc_time}".strip()
    print(
        f"Analyzing game {game_id} played on {platform} "
        f"between {game_row.white} vs {game_row.black} on {utc_datetime}"
    )


def _resolve_platform_name(site: str) -> str:
    normalized = site.strip().lower()
    if "lichess" in normalized:
        return "Lichess.org"
    if "chess.com" in normalized:
        return "Chess.com"

    return "Unknown"


def _resolve_player_side(
    white_player: str,
    black_player: str,
    player_name: str,
) -> chess.Color | None:
    normalized = player_name.strip().lower()
    if normalized == white_player.strip().lower():
        return chess.WHITE
    if normalized == black_player.strip().lower():
        return chess.BLACK

    return None


if __name__ == "__main__":
    main()
