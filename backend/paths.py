from pathlib import Path
import os


BACKEND_DIRECTORY = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIRECTORY.parent
DATA_DIRECTORY = REPO_ROOT / "data"
DATABASE_PATH = Path(
    os.environ.get("CHESSCLAW_DATABASE_PATH", str(DATA_DIRECTORY / "db.sqlite"))
).expanduser()
SQL_INIT_PATH = DATA_DIRECTORY / "sql" / "init.sql"
OPENINGS_DIRECTORY = DATA_DIRECTORY / "chess-openings"
