"""Pure core: validated value types, port protocols, FEN logic.

This module performs no I/O. External interactions are described as
``Protocol`` ports (``Board``, ``Store``, ``Clock``) so programs are
generic over interpreters; concrete adapters live in ``relay_rook.adapters``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Protocol, runtime_checkable


# --- Validated value types ---------------------------------------------------


class Orientation(Enum):
    WHITE = "white"
    BLACK = "black"

    @classmethod
    def parse(cls, raw: str) -> "Orientation":
        try:
            return cls(raw.strip().lower())
        except ValueError as exc:
            raise ValueError(
                f"orientation must be 'white' or 'black', got {raw!r}"
            ) from exc


_DEFAULTS = ["w", "KQkq", "-", "0", "1"]
_PLACEMENT_RE = re.compile(r"^[rnbqkpRNBQKP1-8]+(?:/[rnbqkpRNBQKP1-8]+){7}$")


@dataclass(frozen=True, slots=True)
class Fen:
    """A normalized full FEN. Build via ``Fen.parse``."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> "Fen":
        parts = raw.strip().split()
        if not parts:
            raise ValueError("empty FEN")
        placement = parts[0]
        if not _PLACEMENT_RE.match(placement):
            raise ValueError(f"invalid FEN placement: {placement!r}")
        for rank in placement.split("/"):
            files = sum(int(c) if c.isdigit() else 1 for c in rank)
            if files != 8:
                raise ValueError(f"rank {rank!r} does not sum to 8 files")
        completed = parts + _DEFAULTS[len(parts) - 1:]
        return cls(" ".join(completed[:6]))

    @property
    def placement(self) -> str:
        return self.value.split(" ", 1)[0]


# --- Events & snapshot -------------------------------------------------------


class EventKind(str, Enum):
    FEN_REQUESTED = "fen.requested"
    FEN_APPLIED = "fen.applied"
    ROLLBACK = "rollback.detected"
    ORIENTATION_SET = "orientation.set"
    PHYSICAL_OBSERVED = "physical.fen.observed"


@dataclass(frozen=True, slots=True)
class Event:
    kind: EventKind
    payload: dict[str, Any]
    ts: datetime


@dataclass(frozen=True, slots=True)
class Snapshot:
    fen: Fen
    orientation: Orientation
    updated_at: datetime


# --- Ports -------------------------------------------------------------------


@runtime_checkable
class Board(Protocol):
    """The robotic board (or any stand-in)."""

    def set_fen(self, fen: Fen, *, force: bool = True) -> None: ...
    def get_fen(self) -> Fen | None: ...
    def set_orientation(self, orientation: Orientation) -> None: ...


@runtime_checkable
class Store(Protocol):
    """Append-only event log + per-key snapshot persistence."""

    def append(self, event: Event) -> None: ...
    def recent_applied_fens(self, limit: int) -> list[Fen]: ...
    def snapshot(self) -> Snapshot: ...
    def update_snapshot(self, snap: Snapshot) -> None: ...


@runtime_checkable
class Clock(Protocol):
    def now(self) -> datetime: ...
