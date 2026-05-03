"""FastAPI app factory. Wires programs to ports.

This is the only place that knows about all three ports. Routes are 1:1
with programs; request bodies are validated by Pydantic, then lifted to
``Fen`` / ``Orientation`` value objects before reaching pure code.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .core import Board, Clock, Fen, Orientation, Store
from .program import observe_physical, sync_fen, sync_orientation


class FenRequest(BaseModel):
    fen: str
    force: bool = True


class OrientationRequest(BaseModel):
    orientation: str = Field(pattern="^(white|black)$")


def create_app(*, board: Board, store: Store, clock: Clock) -> FastAPI:
    app = FastAPI(title="relay-rook")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/board/state")
    def get_state() -> dict[str, str]:
        snap = store.snapshot()
        return {
            "fen": snap.fen.value,
            "orientation": snap.orientation.value,
            "updated_at": snap.updated_at.isoformat(),
        }

    @app.post("/api/board/fen")
    def post_fen(req: FenRequest) -> dict[str, object]:
        try:
            fen = Fen.parse(req.fen)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        result = sync_fen(fen, board=board, store=store, clock=clock, force=req.force)
        return {"fen": result.fen.value, "rollback": result.rollback}

    @app.get("/api/board/fen")
    def get_physical_fen() -> dict[str, str | None]:
        fen = observe_physical(board=board, store=store, clock=clock)
        return {"fen": fen.value if fen else None}

    @app.post("/api/board/orientation")
    def post_orientation(req: OrientationRequest) -> dict[str, str]:
        snap = sync_orientation(
            Orientation.parse(req.orientation),
            board=board,
            store=store,
            clock=clock,
        )
        return {"orientation": snap.orientation.value}

    return app
