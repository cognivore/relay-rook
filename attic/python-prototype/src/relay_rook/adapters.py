"""Concrete interpreters: the only I/O in the package.

- ``SqliteStore``: SQLite-backed event log + snapshot. Schema is in
  ``schema.sql`` and is applied idempotently; future microservices add
  their own tables alongside ours.
- ``HttpBoard``: HTTP client to an ``openchessnutmove`` server.
- ``SystemClock``: wall-clock UTC.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .core import Event, EventKind, Fen, Orientation, Snapshot

_SNAPSHOT_KEY = "board"
_INITIAL_FEN = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")


class SystemClock:
    @staticmethod
    def now() -> datetime:
        return datetime.now(timezone.utc)


class SqliteStore:
    """SQLite Store. Autocommit; safe to share across threads."""

    def __init__(self, path: Path | str, schema: Path | str | None = None) -> None:
        self._conn = sqlite3.connect(str(path), isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        if schema is not None:
            self._conn.executescript(Path(schema).read_text())

    def close(self) -> None:
        self._conn.close()

    def append(self, event: Event) -> None:
        self._conn.execute(
            "INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)",
            (event.ts.isoformat(), event.kind.value, json.dumps(event.payload)),
        )

    def recent_applied_fens(self, limit: int) -> list[Fen]:
        rows = self._conn.execute(
            "SELECT payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?",
            (EventKind.FEN_APPLIED.value, limit),
        ).fetchall()
        return [Fen.parse(json.loads(p)["fen"]) for (p,) in rows]

    def snapshot(self) -> Snapshot:
        row = self._conn.execute(
            "SELECT value, updated_at FROM snapshot WHERE key = ?",
            (_SNAPSHOT_KEY,),
        ).fetchone()
        if row is None:
            return Snapshot(_INITIAL_FEN, Orientation.WHITE, datetime.now(timezone.utc))
        value, updated_at = row
        body = json.loads(value)
        return Snapshot(
            fen=Fen.parse(body["fen"]),
            orientation=Orientation.parse(body["orientation"]),
            updated_at=datetime.fromisoformat(updated_at),
        )

    def update_snapshot(self, snap: Snapshot) -> None:
        body = json.dumps({"fen": snap.fen.value, "orientation": snap.orientation.value})
        self._conn.execute(
            "INSERT INTO snapshot (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at",
            (_SNAPSHOT_KEY, body, snap.updated_at.isoformat()),
        )


class HttpBoard:
    """HTTP client for an openchessnutmove server (the BLE owner)."""

    def __init__(self, base_url: str, timeout: float = 5.0) -> None:
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def set_fen(self, fen: Fen, *, force: bool = True) -> None:
        r = self._client.post("/api/state/fen", json={"fen": fen.value, "force": force})
        r.raise_for_status()

    def get_fen(self) -> Fen | None:
        try:
            r = self._client.get("/api/state")
            r.raise_for_status()
        except httpx.HTTPError:
            return None
        body: dict[str, Any] = r.json()
        raw = body.get("fen")
        if not raw:
            return None
        try:
            return Fen.parse(raw)
        except ValueError:
            return None

    def set_orientation(self, orientation: Orientation) -> None:
        r = self._client.post(
            "/api/state/orientation", json={"orientation": orientation.value}
        )
        r.raise_for_status()
