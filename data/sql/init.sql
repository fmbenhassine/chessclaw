PRAGMA foreign_keys = ON;

BEGIN;

-- Stores one raw PGN game per row.
-- Column names map to the PGN tag names used in this project:
-- White, Black, Result, UTCDate, UTCTime, WhiteElo, BlackElo, ECO,
-- Termination, Site.
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    white TEXT,
    black TEXT,
    result TEXT,
    utc_date TEXT,
    utc_time TEXT,
    white_elo TEXT,
    black_elo TEXT,
    eco TEXT,
    termination TEXT,
    site TEXT,
    raw_pgn TEXT NOT NULL
);

-- Stores chess opening reference data.
CREATE TABLE IF NOT EXISTS openings (
    eco TEXT,
    name TEXT,
    pgn TEXT
);

-- Stores one missed-mate result per row.
-- `side` is the player's color in that game ("White" or "Black").
CREATE TABLE IF NOT EXISTS missed_mates (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL,
    move_number INTEGER,
    side TEXT,
    fen TEXT,
    played_san TEXT,
    mating_move_san TEXT,
    mating_move_uci TEXT,
    mate_in INTEGER,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    CHECK (mate_in >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_site_unique
    ON games (site)
    WHERE site IS NOT NULL AND site <> '' AND site <> '?';

CREATE INDEX IF NOT EXISTS idx_games_white ON games (white);
CREATE INDEX IF NOT EXISTS idx_games_black ON games (black);

CREATE INDEX IF NOT EXISTS idx_missed_mates_game_id ON missed_mates (game_id);
CREATE INDEX IF NOT EXISTS idx_missed_mates_fen ON missed_mates (fen);
CREATE INDEX IF NOT EXISTS idx_missed_mates_mate_in ON missed_mates (mate_in);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_mates_unique_position
    ON missed_mates (game_id, move_number, side, fen, mating_move_uci);

COMMIT;
