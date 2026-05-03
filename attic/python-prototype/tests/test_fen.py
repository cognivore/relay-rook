import pytest

from relay_rook.core import Fen, Orientation


def test_fen_normalizes_placement_only() -> None:
    fen = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")
    assert fen.value == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def test_fen_preserves_full_form() -> None:
    full = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"
    assert Fen.parse(full).value == full


def test_fen_fills_partial_form() -> None:
    f = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b")
    assert f.value.endswith(" b KQkq - 0 1")


def test_fen_rejects_bad_rank_sum() -> None:
    with pytest.raises(ValueError):
        Fen.parse("rnbqkbnr/9/8/8/8/8/PPPPPPPP/RNBQKBNR")


def test_fen_rejects_empty() -> None:
    with pytest.raises(ValueError):
        Fen.parse("")


def test_fen_rejects_too_few_ranks() -> None:
    with pytest.raises(ValueError):
        Fen.parse("rnbqkbnr/8/8/8/8/8/8")


def test_fen_placement_property() -> None:
    f = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    assert f.placement == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"


def test_fen_value_equality() -> None:
    a = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")
    b = Fen.parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    assert a == b


def test_orientation_parse() -> None:
    assert Orientation.parse("white") == Orientation.WHITE
    assert Orientation.parse("BLACK") == Orientation.BLACK
    with pytest.raises(ValueError):
        Orientation.parse("sideways")
