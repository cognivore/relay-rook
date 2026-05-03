"""SqliteStore smoke test — exercises the only adapter doing local I/O."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from relay_rook.adapters import SqliteStore
from relay_rook.core import Event, EventKind, Fen, Orientation, Snapshot

SCHEMA = Path(__file__).resolve().parents[1] / "schema.sql"


@pytest.fixture()
def store(tmp_path: Path) -> SqliteStore:
    return SqliteStore(tmp_path / "test.db", schema=SCHEMA)


def test_initial_snapshot_is_starting_position(store: SqliteStore) -> None:
    snap = store.snapshot()
    assert snap.fen.placement == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
    assert snap.orientation == Orientation.WHITE


def test_round_trip_snapshot(store: SqliteStore) -> None:
    fen = Fen.parse("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    when = datetime(2026, 5, 1, tzinfo=timezone.utc)
    store.update_snapshot(Snapshot(fen, Orientation.BLACK, when))
    snap = store.snapshot()
    assert snap.fen == fen
    assert snap.orientation == Orientation.BLACK
    assert snap.updated_at == when


def test_recent_applied_fens_returns_in_reverse_insertion_order(store: SqliteStore) -> None:
    fens = [
        Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"),
        Fen.parse("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"),
        Fen.parse("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR"),
    ]
    now = datetime.now(timezone.utc)
    for f in fens:
        store.append(Event(EventKind.FEN_APPLIED, {"fen": f.value}, now))
    assert store.recent_applied_fens(10) == list(reversed(fens))
    assert store.recent_applied_fens(2) == [fens[2], fens[1]]
