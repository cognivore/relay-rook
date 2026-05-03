from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from relay_rook.core import Event, EventKind, Fen, Orientation, Snapshot
from relay_rook.program import observe_physical, sync_fen, sync_orientation

START = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")
AFTER_E4 = Fen.parse("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
AFTER_E5 = Fen.parse("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


@dataclass
class FakeBoard:
    fens_set: list[tuple[Fen, bool]] = field(default_factory=list)
    orientations_set: list[Orientation] = field(default_factory=list)
    physical_fen: Fen | None = None

    def set_fen(self, fen: Fen, *, force: bool = True) -> None:
        self.fens_set.append((fen, force))

    def get_fen(self) -> Fen | None:
        return self.physical_fen

    def set_orientation(self, orientation: Orientation) -> None:
        self.orientations_set.append(orientation)


@dataclass
class FakeStore:
    events: list[Event] = field(default_factory=list)
    applied: list[Fen] = field(default_factory=list)
    _snap: Snapshot = field(
        default_factory=lambda: Snapshot(START, Orientation.WHITE, T0)
    )

    def append(self, event: Event) -> None:
        self.events.append(event)
        if event.kind == EventKind.FEN_APPLIED:
            self.applied.append(Fen.parse(event.payload["fen"]))

    def recent_applied_fens(self, limit: int) -> list[Fen]:
        return list(reversed(self.applied))[:limit]

    def snapshot(self) -> Snapshot:
        return self._snap

    def update_snapshot(self, snap: Snapshot) -> None:
        self._snap = snap


class FixedClock:
    def __init__(self, t: datetime) -> None:
        self._t = t

    def now(self) -> datetime:
        return self._t


def _wired() -> tuple[FakeBoard, FakeStore, FixedClock]:
    return FakeBoard(), FakeStore(), FixedClock(T0)


def test_sync_fen_pushes_to_board_and_records_events() -> None:
    board, store, clock = _wired()
    result = sync_fen(AFTER_E4, board=board, store=store, clock=clock)
    assert result.fen == AFTER_E4
    assert result.rollback is False
    assert board.fens_set == [(AFTER_E4, True)]
    kinds = [e.kind for e in store.events]
    assert kinds == [EventKind.FEN_REQUESTED, EventKind.FEN_APPLIED]
    assert store.snapshot().fen == AFTER_E4


def test_sync_fen_does_not_flag_rollback_on_repeat() -> None:
    board, store, clock = _wired()
    sync_fen(AFTER_E4, board=board, store=store, clock=clock)
    second = sync_fen(AFTER_E4, board=board, store=store, clock=clock)
    assert second.rollback is False
    assert all(e.kind != EventKind.ROLLBACK for e in store.events)


def test_sync_fen_detects_rollback_on_navigate_back() -> None:
    board, store, clock = _wired()
    sync_fen(START, board=board, store=store, clock=clock)
    sync_fen(AFTER_E4, board=board, store=store, clock=clock)
    sync_fen(AFTER_E5, board=board, store=store, clock=clock)
    rolled = sync_fen(START, board=board, store=store, clock=clock)
    assert rolled.rollback is True
    rollback_events = [e for e in store.events if e.kind == EventKind.ROLLBACK]
    assert len(rollback_events) == 1
    assert rollback_events[0].payload["fen"] == START.value


def test_sync_fen_force_flag_forwarded_to_board() -> None:
    board, store, clock = _wired()
    sync_fen(AFTER_E4, board=board, store=store, clock=clock, force=False)
    assert board.fens_set == [(AFTER_E4, False)]


def test_sync_orientation_updates_snapshot_and_board() -> None:
    board, store, clock = _wired()
    snap = sync_orientation(Orientation.BLACK, board=board, store=store, clock=clock)
    assert snap.orientation == Orientation.BLACK
    assert board.orientations_set == [Orientation.BLACK]
    assert store.events[0].kind == EventKind.ORIENTATION_SET


def test_observe_physical_returns_none_when_disconnected() -> None:
    board, store, clock = _wired()
    assert observe_physical(board=board, store=store, clock=clock) is None
    assert store.events == []


def test_observe_physical_records_event_when_present() -> None:
    board, store, clock = _wired()
    board.physical_fen = AFTER_E4
    fen = observe_physical(board=board, store=store, clock=clock)
    assert fen == AFTER_E4
    assert store.events[0].kind == EventKind.PHYSICAL_OBSERVED
