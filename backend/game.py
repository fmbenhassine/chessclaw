"""Game loading primitives."""

from dataclasses import dataclass
from io import StringIO
from pathlib import Path
import re
import sqlite3

import chess.pgn


class InvalidPgnError(ValueError):
    """Raised when a PGN file cannot be parsed into a game."""


@dataclass(slots=True)
class GameInput:
    """Represents a game source to be analyzed."""

    raw_text: str


@dataclass(slots=True)
class DatabaseGame:
    """Represents one stored game row from the SQLite database."""

    id: int
    white: str
    black: str
    result: str
    utc_date: str
    utc_time: str
    white_elo: str
    black_elo: str
    eco: str
    termination: str
    site: str
    raw_pgn: str

    def to_pgn_game(self) -> chess.pgn.Game:
        """Reconstruct a PGN game from the stored database fields."""

        tag_pairs = [
            ("Event", "?"),
            ("Site", self.site),
            ("Date", self.utc_date),
            ("Round", "?"),
            ("White", self.white),
            ("Black", self.black),
            ("Result", self.result),
            ("UTCDate", self.utc_date),
            ("UTCTime", self.utc_time),
            ("WhiteElo", self.white_elo),
            ("BlackElo", self.black_elo),
            ("ECO", self.eco),
            ("Termination", self.termination),
        ]
        header_text = "\n".join(
            f'[{name} "{_escape_pgn_header(value)}"]' for name, value in tag_pairs
        )
        raw_text = f"{header_text}\n\n{self.raw_pgn.strip()}\n"
        game = chess.pgn.read_game(StringIO(raw_text))
        if game is None:
            raise InvalidPgnError(f"No PGN game could be reconstructed for database row {self.id}.")

        return game


def load_game_from_pgn_file(path: str | Path) -> chess.pgn.Game:
    """Load the first game from a PGN file."""

    pgn_path = Path(path).expanduser().resolve()
    raw_text = pgn_path.read_text(encoding="utf-8")
    game = chess.pgn.read_game(StringIO(raw_text))

    if game is None:
        raise InvalidPgnError(f"No PGN game found in {pgn_path}.")

    return game


def load_game_from_database(
    connection: sqlite3.Connection,
    game_id: int,
) -> DatabaseGame | None:
    """Load one stored game row from the SQLite database."""

    row = connection.execute(
        """
        SELECT id, white, black, result, utc_date, utc_time, white_elo, black_elo,
               eco, termination, site, raw_pgn
        FROM games
        WHERE id = ?
        """,
        (game_id,),
    ).fetchone()
    if row is None:
        return None

    return DatabaseGame(
        id=int(row[0]),
        white=str(row[1] or ""),
        black=str(row[2] or ""),
        result=str(row[3] or ""),
        utc_date=str(row[4] or ""),
        utc_time=str(row[5] or ""),
        white_elo=str(row[6] or ""),
        black_elo=str(row[7] or ""),
        eco=str(row[8] or ""),
        termination=str(row[9] or ""),
        site=str(row[10] or ""),
        raw_pgn=str(row[11] or ""),
    )


def split_pgn_file(path: str | Path) -> list[Path]:
    """Split a PGN file containing multiple games into one file per game."""

    pgn_path = Path(path).expanduser().resolve()
    written_files: list[Path] = []

    with pgn_path.open(encoding="utf-8") as handle:
        game_index = 1
        while True:
            game = chess.pgn.read_game(handle)
            if game is None:
                break

            output_path = pgn_path.parent / _build_game_filename(game.headers, game_index)
            exporter = chess.pgn.StringExporter(
                headers=True,
                variations=True,
                comments=True,
            )
            output_path.write_text(f"{game.accept(exporter)}\n", encoding="utf-8")
            written_files.append(output_path)
            game_index += 1

    return written_files


def _build_game_filename(headers: chess.pgn.Headers, game_index: int) -> str:
    """Build a stable output filename from PGN headers."""

    white_name = _slugify(headers.get("White", "unknown-white"))
    black_name = _slugify(headers.get("Black", "unknown-black"))
    game_id = _slugify(_extract_game_id(headers, game_index))
    return f"{white_name}-{black_name}-{game_id}.pgn"


def _extract_game_id(headers: chess.pgn.Headers, game_index: int) -> str:
    """Extract the best available game identifier from PGN headers."""

    for key in ("GameId", "GameID", "gameId", "Site", "Event", "Round"):
        value = headers.get(key)
        if value and value != "?":
            return value

    return str(game_index)


def _slugify(value: str) -> str:
    """Convert PGN header text into a filesystem-friendly filename part."""

    normalized = value.strip().lower()
    normalized = re.sub(r"https?://", "", normalized)
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    return normalized or "unknown"


def _escape_pgn_header(value: str) -> str:
    """Escape a value for inclusion in a PGN header."""

    return value.replace("\\", "\\\\").replace('"', '\\"')
