"""Entry: assemble adapters and run uvicorn."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from .adapters import HttpBoard, SqliteStore, SystemClock
from .server import create_app


def main() -> None:
    db_path = Path(os.environ.get("RELAY_ROOK_DB", "relay.db"))
    schema_path = Path(__file__).resolve().parents[2] / "schema.sql"
    board_url = os.environ.get("RELAY_ROOK_BOARD", "http://127.0.0.1:8675")
    host = os.environ.get("RELAY_ROOK_HOST", "127.0.0.1")
    port = int(os.environ.get("RELAY_ROOK_PORT", "8674"))
    log_level = os.environ.get("RELAY_ROOK_LOG_LEVEL", "info")

    store = SqliteStore(db_path, schema=schema_path if schema_path.exists() else None)
    board = HttpBoard(board_url)
    app = create_app(board=board, store=store, clock=SystemClock())
    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
