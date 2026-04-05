# Chess Backend

The chess backend is a Python codebase that provides the following features:

- Downloading games from Lichess.org and Chess.com for a given user
- Storing games in a SQLite database
- Analyzing games for missed checkmate opportunities using Stockfish
- Rendering puzzle images for missed mate puzzles
- Rendering platform-specific rating evolution charts

## Usage

Install dependencies and create the virtual environment with `uv`:

```bash
uv sync
```

Initialize the SQLite database in the current directory:

```bash
uv run python backend/setup-database.py
```

This creates `data/db.sqlite` if it does not already exist, initializes it with `init.sql`, and loads chess opening data from the bundled files sourced from https://github.com/lichess-org/chess-openings.

All backend scripts resolve the database path from `CHESSCLAW_DATABASE_PATH` when that environment variable is set. Otherwise, they use the default `data/db.sqlite`.

Download games from Lichess.org or Chess.com with one unified script:

```bash
uv run python backend/download-games.py username --platform lichess --mode init
uv run python backend/download-games.py username --platform lichess --mode sync
uv run python backend/download-games.py username --platform chesscom --mode init
uv run python backend/download-games.py username --platform chesscom --mode sync
```

Use `--mode init` to download all available games for the user. Use `--mode sync` to download only recent games based on the latest matching game already stored in `data/db.sqlite`. For Lichess, the script uses `LICHESS_API_KEY` as a bearer token when that environment variable is set. Lichess downloads create `lichess-username-games/` and write either `lichess-username.pgn` or `lichess-username-since-date-time.pgn` inside that directory. Chess.com init downloads create `chesscom-username-games/` with one `YYYY-MM.pgn` file per monthly archive, while Chess.com sync writes `chesscom-username-since-date-time.pgn`.

Load games into the `games` table:

```bash
uv run python backend/ingest-games.py
uv run python backend/ingest-games.py path/to/game.pgn
```

With no argument, the script recursively ingests every `.pgn` file under `data/games` and logs `Ingesting games from file: ...` for each file. If a PGN path is provided, it ingests only that file. In both cases it extracts only the PGN tags that match the `games` table columns. If a game with the same `(white, black, result, utc_date, utc_time)` already exists, it prints `Game already exists.`. If a PGN file cannot be parsed, it prints an error.

Download recent games, ingest them, and remove the downloaded sync file in one step:

```bash
uv run python backend/sync-games.py username
uv run python backend/sync-games.py username --platform lichess
uv run python backend/sync-games.py username --platform chesscom
```

If `--platform` is omitted, the script syncs both Lichess and Chess.com for the given user. If `--platform` is provided, it syncs only that platform. In every case it ingests the downloaded PGN into `data/db.sqlite` and then deletes the downloaded file after a successful ingest.

Analyze stored games for missed mates:

```bash
uv run python backend/find-missed-mates.py player_name game_id
uv run python backend/find-missed-mates.py player_name
```

The first form analyzes one game already stored in `data/db.sqlite`. The second form runs batch mode and analyzes every non-analyzed game in the database for that player.

Rows in `missed_mates` store the player's `side` (`White` or `Black`) so rendering and downstream queries do not need to infer color from the game headers.

Render one stored missed-mates row from the database as a PNG puzzle image:

```bash
uv run python backend/render-png.py missed_mate_id
uv run python backend/render-png.py missed_mate_id output.png
```

The script loads the row from `missed_mates` in `data/db.sqlite` and generates a PNG image showing the board position, the puzzle text, and the played move highlighted in red. If `output.png` is omitted, the file is written as `missed-mate-missed_mate_id.png` in the current directory.

Render a platform-specific rating evolution chart:

```bash
uv run python backend/render-rating-plot.py player_name --platform lichess
uv run python backend/render-rating-plot.py player_name --platform chesscom output.png --days 90
```

The script reads the stored games for one player on one platform, builds a daily rating series, and renders a PNG chart.
