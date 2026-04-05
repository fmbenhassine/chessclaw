"""Analysis primitives for missed-mate detection."""

from dataclasses import dataclass
from typing import Callable

import chess
import chess.pgn

from backend.engine import StockfishEngine


@dataclass(slots=True)
class MissedMate:
    """Represents a missed mating opportunity in a game."""

    game_url: str
    move_number: int
    side: str
    fen: str
    played_san: str
    mating_move_san: str
    mating_move_uci: str
    mate_in: int


def find_missed_mates(
    game: chess.pgn.Game,
    side: chess.Color,
    engine: StockfishEngine,
    verbose_logger: Callable[[int], None] | None = None,
) -> list[MissedMate]:
    """Find missed mate-in-1, mate-in-2, or mate-in-3 opportunities for a side."""

    board = game.board()
    missed_mates: list[MissedMate] = []
    game_url = game.headers.get("Site", "").strip()

    for move in game.mainline_moves():
        if board.turn == side:
            if verbose_logger is not None:
                verbose_logger(board.fullmove_number)

            played_san = board.san(move)
            search = engine.find_mate(board.fen(), max_mate_in=3)
            forced_mate = _find_shortest_forced_mate(board, side, max_mate_in=3)

            if forced_mate is not None and not _move_preserves_forced_mate(
                board,
                move,
                side,
                forced_mate.mate_in,
            ):
                position_fen = board.fen()
                mating_move = forced_mate.move

                if search is not None and search.bestmove_uci == mating_move.uci():
                    mating_move_uci = search.bestmove_uci
                else:
                    mating_move_uci = mating_move.uci()

                mating_move_san = board.san(mating_move)
                side_name = "White" if side == chess.WHITE else "Black"
                missed_mates.append(
                    MissedMate(
                        game_url=game_url,
                        move_number=board.fullmove_number,
                        side=side_name,
                        fen=position_fen,
                        played_san=played_san,
                        mating_move_san=mating_move_san,
                        mating_move_uci=mating_move_uci,
                        mate_in=forced_mate.mate_in,
                    )
                )

        board.push(move)

    return missed_mates


def _move_is_checkmate(board: chess.Board, move: chess.Move) -> bool:
    """Return whether the given legal move ends the game by checkmate."""

    board.push(move)
    try:
        return board.is_checkmate()
    finally:
        board.pop()


@dataclass(slots=True)
class ForcedMate:
    """Represents a shortest forced mating move from a position."""

    move: chess.Move
    mate_in: int


def _find_shortest_forced_mate(
    board: chess.Board,
    side: chess.Color,
    max_mate_in: int,
) -> ForcedMate | None:
    """Return the shortest forced mate for the given side, if one exists."""

    for mate_in in range(1, max_mate_in + 1):
        move = _find_forced_mate(board, side, mate_in)
        if move is not None:
            return ForcedMate(move=move, mate_in=mate_in)

    return None


def _find_forced_mate(
    board: chess.Board,
    side: chess.Color,
    mate_in: int,
) -> chess.Move | None:
    """Return a move that forces mate in the given number of moves."""

    if board.turn != side:
        return None

    for move in board.legal_moves:
        board.push(move)
        try:
            if board.is_checkmate():
                if mate_in == 1:
                    return move
                continue

            if mate_in > 1 and _opponent_is_forced(board, side, mate_in - 1):
                return move
        finally:
            board.pop()

    return None


def _opponent_is_forced(
    board: chess.Board,
    side: chess.Color,
    mate_in: int,
) -> bool:
    """Return whether every opponent reply still allows a forced mate."""

    if board.turn == side:
        return _find_forced_mate(board, side, mate_in) is not None

    legal_replies = list(board.legal_moves)
    if not legal_replies:
        return board.is_checkmate()

    for reply in legal_replies:
        board.push(reply)
        try:
            if _find_forced_mate(board, side, mate_in) is None:
                return False
        finally:
            board.pop()

    return True


def _move_preserves_forced_mate(
    board: chess.Board,
    move: chess.Move,
    side: chess.Color,
    mate_in: int,
) -> bool:
    """Return whether the played move preserves the shortest forced mate length."""

    board.push(move)
    try:
        if board.is_checkmate():
            return mate_in == 1

        if mate_in == 1:
            return False

        return _opponent_is_forced(board, side, mate_in - 1)
    finally:
        board.pop()
