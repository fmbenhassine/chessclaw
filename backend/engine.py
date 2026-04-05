"""Stockfish engine integration boundary."""

from dataclasses import dataclass
from pathlib import Path
from shutil import which
import select
import subprocess
import os
import time


DEFAULT_ENGINE_ENV_VAR = "STOCKFISH_BINARY"


class EngineNotFoundError(FileNotFoundError):
    """Raised when the Stockfish binary cannot be located."""


class EngineProtocolError(RuntimeError):
    """Raised when Stockfish does not respond as expected."""


class EngineTimeoutError(TimeoutError):
    """Raised when Stockfish does not respond before the timeout."""


@dataclass(slots=True)
class EngineConfig:
    """Configuration for a local Stockfish binary."""

    binary_path: Path

    @classmethod
    def load(cls, binary_path: str | Path | None = None) -> "EngineConfig":
        """Load a Stockfish configuration from an explicit path or the system."""

        resolved_path = _resolve_binary_path(binary_path)
        return cls(binary_path=resolved_path)


@dataclass(slots=True)
class MateSearchResult:
    """Represents a successful mate search result from Stockfish."""

    bestmove_uci: str
    mate_in: int


class StockfishEngine:
    """Minimal UCI client for interacting with Stockfish."""

    def __init__(self, config: EngineConfig) -> None:
        self._config = config
        self._process: subprocess.Popen[str] | None = None

    def __enter__(self) -> "StockfishEngine":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def start(self) -> None:
        """Start the engine process and perform the UCI handshake."""

        if self._process is not None:
            return

        self._process = subprocess.Popen(
            [str(self._config.binary_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._send("uci")
        self._read_until("uciok")
        self._send("isready")
        self._read_until("readyok")

    def close(self) -> None:
        """Terminate the engine process."""

        if self._process is None:
            return

        try:
            self._send("stop")
        except EngineProtocolError:
            pass

        try:
            self._send("quit")
        except EngineProtocolError:
            pass

        try:
            self._process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            try:
                self._process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=1)

        self._process = None

    def find_mate(
        self,
        fen: str,
        *,
        max_mate_in: int = 3,
        timeout_seconds: float = 0.1,
    ) -> MateSearchResult | None:
        """Return Stockfish's mating move when a mate up to the given depth exists."""

        self._send(f"position fen {fen}")
        self._send(f"go mate {max_mate_in}")

        bestmove_uci: str | None = None
        mate_in: int | None = None

        try:
            lines = self._read_until_prefix("bestmove ", timeout_seconds=timeout_seconds)
        except EngineTimeoutError:
            self._send("stop")
            self._send("isready")
            try:
                self._read_until("readyok", timeout_seconds=1.0)
            except EngineTimeoutError:
                return None
            return None

        for line in lines:
            score_marker = " score mate "
            if score_marker in line:
                mate_text = line.split(score_marker, maxsplit=1)[1].split()[0]
                mate_in = int(mate_text)

            if line.startswith("bestmove "):
                bestmove_uci = line.split()[1]

        if (
            mate_in is not None
            and 1 <= mate_in <= max_mate_in
            and bestmove_uci not in {None, "(none)"}
        ):
            return MateSearchResult(bestmove_uci=bestmove_uci, mate_in=mate_in)

        return None

    def _send(self, command: str) -> None:
        """Send a command to the engine process."""

        if self._process is None or self._process.stdin is None:
            raise EngineProtocolError("Stockfish process is not running.")

        self._process.stdin.write(f"{command}\n")
        self._process.stdin.flush()

    def _read_until(
        self,
        expected: str,
        *,
        timeout_seconds: float | None = None,
    ) -> list[str]:
        """Read lines until the expected line appears."""

        lines: list[str] = []
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        while True:
            line = self._read_line(deadline=deadline)
            lines.append(line)
            if line == expected:
                return lines

    def _read_until_prefix(
        self,
        prefix: str,
        *,
        timeout_seconds: float | None = None,
    ) -> list[str]:
        """Read lines until a line starting with the given prefix appears."""

        lines: list[str] = []
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        while True:
            line = self._read_line(deadline=deadline)
            lines.append(line)
            if line.startswith(prefix):
                return lines

    def _read_line(self, *, deadline: float | None = None) -> str:
        """Read one line from Stockfish."""

        if self._process is None or self._process.stdout is None:
            raise EngineProtocolError("Stockfish process is not running.")

        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EngineTimeoutError("Timed out while waiting for Stockfish output.")

            ready, _, _ = select.select([self._process.stdout], [], [], remaining)
            if not ready:
                raise EngineTimeoutError("Timed out while waiting for Stockfish output.")

        line = self._process.stdout.readline()
        if line == "":
            raise EngineProtocolError("Stockfish terminated unexpectedly.")

        return line.strip()


def _resolve_binary_path(binary_path: str | Path | None = None) -> Path:
    """Resolve the Stockfish binary path from input, env, or PATH."""

    candidates = [
        Path(binary_path).expanduser() if binary_path is not None else None,
        Path(env_path).expanduser()
        if (env_path := os.environ.get(DEFAULT_ENGINE_ENV_VAR))
        else None,
    ]

    path_binary = which("stockfish")
    if path_binary is not None:
        candidates.append(Path(path_binary))

    for candidate in candidates:
        if candidate is None:
            continue

        resolved = candidate.resolve()
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return resolved

    raise EngineNotFoundError(
        "Stockfish binary not found. Pass a path explicitly, set "
        f"{DEFAULT_ENGINE_ENV_VAR}, or install `stockfish` on your PATH."
    )
