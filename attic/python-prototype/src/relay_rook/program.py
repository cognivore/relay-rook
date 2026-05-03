"""Pure programs that drive the bridge.

Each program is a function over ``Board``, ``Store``, and ``Clock`` ports.
No I/O, no globals, no concrete adapters — programs describe *what* should
happen; interpreters in ``relay_rook.adapters`` decide *how*.
"""

from __future__ import annotations

from dataclasses import dataclass

from .core import (
    Board,
    Clock,
    Event,
    EventKind,
    Fen,
    Orientation,
    Snapshot,
    Store,
)

ROLLBACK_WINDOW = 32


@dataclass(frozen=True, slots=True)
class SyncResult:
    fen: Fen
    rollback: bool
    snapshot: Snapshot


def sync_fen(
    fen: Fen,
    *,
    board: Board,
    store: Store,
    clock: Clock,
    force: bool = True,
) -> SyncResult:
    """Apply a desired FEN: detect rollback, push to the board, record events.

    A rollback is a re-occurrence of an earlier applied FEN that is *not*
    the most recent one — i.e. the user navigated backwards through a line.
    """
    now = clock.now()
    recent = store.recent_applied_fens(ROLLBACK_WINDOW)
    rollback = bool(recent) and fen != recent[0] and fen in recent
    store.append(Event(EventKind.FEN_REQUESTED, {"fen": fen.value, "force": force}, now))
    board.set_fen(fen, force=force)
    snap = Snapshot(fen=fen, orientation=store.snapshot().orientation, updated_at=now)
    store.update_snapshot(snap)
    store.append(Event(EventKind.FEN_APPLIED, {"fen": fen.value}, now))
    if rollback:
        store.append(Event(EventKind.ROLLBACK, {"fen": fen.value}, now))
    return SyncResult(fen=fen, rollback=rollback, snapshot=snap)


def sync_orientation(
    orientation: Orientation,
    *,
    board: Board,
    store: Store,
    clock: Clock,
) -> Snapshot:
    """Forward an orientation change to the board and record it."""
    now = clock.now()
    board.set_orientation(orientation)
    current = store.snapshot()
    snap = Snapshot(fen=current.fen, orientation=orientation, updated_at=now)
    store.update_snapshot(snap)
    store.append(Event(EventKind.ORIENTATION_SET, {"orientation": orientation.value}, now))
    return snap


def observe_physical(
    *,
    board: Board,
    store: Store,
    clock: Clock,
) -> Fen | None:
    """Read the physical board, append an event if a FEN is available."""
    fen = board.get_fen()
    if fen is None:
        return None
    store.append(Event(EventKind.PHYSICAL_OBSERVED, {"fen": fen.value}, clock.now()))
    return fen
