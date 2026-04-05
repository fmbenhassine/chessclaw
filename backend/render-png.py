#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import argparse
import sqlite3
import sys

import chess
from PIL import Image, ImageDraw, ImageFont

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.paths import DATABASE_PATH

PIECE_ASSETS_DIRECTORY = Path(__file__).resolve().parents[1] / "assets" / "chesspieces"
BOARD_SIZE = 640
SQUARE_SIZE = BOARD_SIZE // 8
PAGE_PADDING = 48
TEXT_GAP = 28
BACKGROUND_COLOR = "#f3ecdf"
LIGHT_SQUARE_COLOR = "#f0d9b5"
DARK_SQUARE_COLOR = "#b58863"
HIGHLIGHT_COLOR = (183, 28, 28, 122)
TEXT_COLOR = "#221b16"
MUTED_TEXT_COLOR = "#66584a"
COORDINATE_PADDING = 6


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a PNG puzzle image from one missed-mates row stored in the database."
    )
    parser.add_argument("missed_mate_id", type=int, help="Database id of the missed-mates row.")
    parser.add_argument(
        "output_png",
        nargs="?",
        type=Path,
        help='Path to the generated PNG file. Defaults to "missed-mate-{missed_mate_id}.png".',
    )
    args = parser.parse_args()
    output_png = args.output_png or Path(f"missed-mate-{args.missed_mate_id}.png")

    if not DATABASE_PATH.exists():
        print(
            f"Error: database file not found: {DATABASE_PATH}. Run setup-database.py first.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if not PIECE_ASSETS_DIRECTORY.exists():
        print(
            f"Error: chess piece assets directory not found: {PIECE_ASSETS_DIRECTORY}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    try:
        with sqlite3.connect(DATABASE_PATH) as connection:
            missed_mates = _load_missed_mate_results(connection, args.missed_mate_id)
    except sqlite3.Error as exc:
        print(f"Error: database failure: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    if not missed_mates:
        print(f"Missed-mates row {args.missed_mate_id} is a sentinel row with no missed mates.")
        return

    image = _render_png(missed_mates, missed_mate_id=args.missed_mate_id)
    image.save(output_png)


def _load_missed_mate_results(
    connection: sqlite3.Connection,
    missed_mate_id: int,
) -> list[dict[str, object]]:
    row = connection.execute(
        """
        SELECT
            missed_mates.id,
            missed_mates.game_id,
            missed_mates.move_number,
            missed_mates.side,
            missed_mates.fen,
            missed_mates.played_san,
            missed_mates.mating_move_san,
            missed_mates.mating_move_uci,
            missed_mates.mate_in,
            games.site,
            games.white,
            games.black
        FROM missed_mates
        JOIN games ON games.id = missed_mates.game_id
        WHERE missed_mates.id = ?
        """,
        (missed_mate_id,),
    ).fetchone()
    if row is None:
        print(f"Error: no missed-mates row found with id {missed_mate_id}.", file=sys.stderr)
        raise SystemExit(1)

    move_number = row[2]
    if move_number is None:
        return []

    side = row[3] or ""

    return [
        {
            "game_url": row[9] or "",
            "move_number": move_number,
            "side": side,
            "fen": row[4] or "",
            "played_san": row[5] or "",
            "mating_move_san": row[6] or "",
            "mating_move_uci": row[7] or "",
            "mate_in": row[8],
        }
    ]


def _render_png(missed_mates: list[dict[str, object]], *, missed_mate_id: int) -> Image.Image:
    missed_mate = missed_mates[0]
    fen = str(missed_mate["fen"])
    board = chess.Board(fen)
    played_move = _parse_played_move(board, str(missed_mate["played_san"]))
    orientation = _orientation_from_fen(fen)

    title_font = _load_font(34)
    body_font = _load_font(24)
    message = (
        f'In this position, you played {missed_mate["played_san"]} and missed a mate in '
        f'#{missed_mate["mate_in"]}. Find the mate in #{missed_mate["mate_in"]} for '
        f'{missed_mate["side"]}.'
    )
    wrapped_message = _wrap_text(message, body_font, BOARD_SIZE, max_width=BOARD_SIZE)
    message_height = _measure_multiline_text(wrapped_message, body_font)[1]

    image_height = (
        PAGE_PADDING
        + message_height
        + TEXT_GAP
        + BOARD_SIZE
        + PAGE_PADDING
    )
    image = Image.new("RGBA", (BOARD_SIZE + PAGE_PADDING * 2, image_height), BACKGROUND_COLOR)
    draw = ImageDraw.Draw(image)

    current_y = PAGE_PADDING
    draw.multiline_text(
        (PAGE_PADDING, current_y),
        wrapped_message,
        fill=TEXT_COLOR,
        font=body_font,
        spacing=8,
    )
    current_y += message_height + TEXT_GAP
    _draw_board(
        image,
        board,
        played_move=played_move,
        top_left=(PAGE_PADDING, current_y),
        orientation=orientation,
    )
    return image.convert("RGB")


def _draw_board(
    image: Image.Image,
    board: chess.Board,
    *,
    played_move: chess.Move | None,
    top_left: tuple[int, int],
    orientation: str,
) -> None:
    board_image = Image.new("RGBA", (BOARD_SIZE, BOARD_SIZE), (0, 0, 0, 0))
    overlay = Image.new("RGBA", (BOARD_SIZE, BOARD_SIZE), (0, 0, 0, 0))
    coordinate_font = _load_font(16)
    board_draw = ImageDraw.Draw(board_image)
    overlay_draw = ImageDraw.Draw(overlay)

    for rank_index in range(8):
        for file_index in range(8):
            square = _square_at(file_index, rank_index, orientation)
            x0 = file_index * SQUARE_SIZE
            y0 = rank_index * SQUARE_SIZE
            x1 = x0 + SQUARE_SIZE
            y1 = y0 + SQUARE_SIZE
            color = (
                LIGHT_SQUARE_COLOR
                if (file_index + rank_index) % 2 == 0
                else DARK_SQUARE_COLOR
            )
            board_draw.rectangle((x0, y0, x1, y1), fill=color)

            if played_move is not None and square in {played_move.from_square, played_move.to_square}:
                overlay_draw.rectangle((x0, y0, x1, y1), fill=HIGHLIGHT_COLOR)

            piece = board.piece_at(square)
            if piece is None:
                _draw_coordinates(
                    board_draw,
                    coordinate_font,
                    file_index=file_index,
                    rank_index=rank_index,
                    orientation=orientation,
                    x0=x0,
                    y0=y0,
                    x1=x1,
                    y1=y1,
                )
                continue

            piece_image = _load_piece_image(piece.symbol())
            if piece_image is not None:
                resized = piece_image.resize((SQUARE_SIZE, SQUARE_SIZE))
                board_image.alpha_composite(resized, (x0, y0))

            _draw_coordinates(
                board_draw,
                coordinate_font,
                file_index=file_index,
                rank_index=rank_index,
                orientation=orientation,
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
            )

    board_image.alpha_composite(overlay)
    image.alpha_composite(board_image, top_left)


def _square_at(file_index: int, rank_index: int, orientation: str) -> chess.Square:
    if orientation == "black":
        file_number = 7 - file_index
        rank_number = rank_index
    else:
        file_number = file_index
        rank_number = 7 - rank_index

    return chess.square(file_number, rank_number)


def _load_piece_image(piece_symbol: str) -> Image.Image | None:
    color_prefix = "w" if piece_symbol.isupper() else "b"
    piece_name = piece_symbol.upper()
    image_path = PIECE_ASSETS_DIRECTORY / f"{color_prefix}{piece_name}.png"
    if not image_path.exists():
        return None

    return Image.open(image_path).convert("RGBA")


def _draw_coordinates(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.ImageFont,
    *,
    file_index: int,
    rank_index: int,
    orientation: str,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
) -> None:
    text_color = MUTED_TEXT_COLOR

    if rank_index == 7:
        file_label = chr(ord("a") + file_index) if orientation == "white" else chr(ord("h") - file_index)
        file_bbox = draw.textbbox((0, 0), file_label, font=font)
        file_width = file_bbox[2] - file_bbox[0]
        file_height = file_bbox[3] - file_bbox[1]
        draw.text(
            (
                x0 + COORDINATE_PADDING,
                y1 - file_height - COORDINATE_PADDING,
            ),
            file_label,
            fill=text_color,
            font=font,
        )

    if file_index == 7:
        rank_label = str(8 - rank_index) if orientation == "white" else str(rank_index + 1)
        rank_bbox = draw.textbbox((0, 0), rank_label, font=font)
        rank_width = rank_bbox[2] - rank_bbox[0]
        rank_height = rank_bbox[3] - rank_bbox[1]
        draw.text(
            (
                x1 - rank_width - COORDINATE_PADDING,
                y0 + COORDINATE_PADDING,
            ),
            rank_label,
            fill=text_color,
            font=font,
        )


def _parse_played_move(board: chess.Board, played_san: str) -> chess.Move | None:
    try:
        return board.parse_san(played_san)
    except ValueError:
        return None


def _wrap_text(text: str, font: ImageFont.ImageFont, width: int, *, max_width: int) -> str:
    dummy = Image.new("RGB", (width, 1000), BACKGROUND_COLOR)
    draw = ImageDraw.Draw(dummy)
    words = text.split()
    if not words:
        return ""

    lines: list[str] = []
    current_line = words[0]
    for word in words[1:]:
        candidate = f"{current_line} {word}"
        if draw.textlength(candidate, font=font) <= max_width:
            current_line = candidate
            continue
        lines.append(current_line)
        current_line = word

    lines.append(current_line)
    return "\n".join(lines)


def _measure_multiline_text(text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    dummy = Image.new("RGB", (10, 10), BACKGROUND_COLOR)
    draw = ImageDraw.Draw(dummy)
    bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=8)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _load_font(size: int) -> ImageFont.ImageFont:
    for font_name in ("DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(font_name, size)
        except OSError:
            continue

    return ImageFont.load_default()


def _orientation_from_fen(fen: str) -> str:
    parts = fen.split()
    if len(parts) >= 2 and parts[1] == "b":
        return "black"

    return "white"

if __name__ == "__main__":
    main()
