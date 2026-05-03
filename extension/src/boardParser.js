"use strict";

// Chessable data-piece codes -> FEN characters
const PIECE_TO_FEN = Object.freeze({
  wK: "K", wQ: "Q", wR: "R", wB: "B", wN: "N", wP: "P",
  bK: "k", bQ: "q", bR: "r", bB: "b", bN: "n", bP: "p",
});

const FILES = "abcdefgh";

/**
 * Parse a chessable.com board DOM element into a FEN placement string
 * and detect the board orientation.
 *
 * @param {Element} boardEl
 * @returns {{ fen: string, orientation: "white" | "black" } | null}
 */
function parseChessableBoard(boardEl) {
  const squareEls = boardEl.querySelectorAll("[data-square]");
  if (squareEls.length === 0) return null;

  const pieces = {};
  squareEls.forEach((sq) => {
    const pieceEl = sq.querySelector("[data-piece]");
    if (pieceEl && pieceEl.dataset.piece) {
      const fenChar = PIECE_TO_FEN[pieceEl.dataset.piece];
      if (fenChar) pieces[sq.dataset.square] = fenChar;
    }
  });

  // First square in DOM order reveals perspective.
  const firstSquare = squareEls[0].dataset.square;
  const firstRank = firstSquare ? firstSquare[1] : "8";
  const orientation = firstRank === "8" ? "white" : "black";

  // Build FEN placement: rank 8 (top) down to rank 1 (bottom).
  const ranks = [];
  for (let rank = 8; rank >= 1; rank--) {
    let empty = 0;
    let row = "";
    for (let f = 0; f < 8; f++) {
      const piece = pieces[FILES[f] + rank];
      if (piece) {
        if (empty > 0) { row += empty; empty = 0; }
        row += piece;
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    ranks.push(row);
  }

  return { fen: ranks.join("/"), orientation };
}

function placementToMap(placement) {
  const map = {};
  const ranks = placement.split("/");
  for (let r = 0; r < ranks.length; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (ch >= "1" && ch <= "8") {
        f += parseInt(ch);
      } else {
        map[FILES[f] + (8 - r)] = ch;
        f++;
      }
    }
  }
  return map;
}

/**
 * Diff two FEN placement strings → { from, to, promotion? } or null.
 * Prioritises king moves so castling returns the king pair.
 */
function fenDiff(oldPlacement, newPlacement) {
  if (oldPlacement === newPlacement) return null;
  const oldMap = placementToMap(oldPlacement);
  const newMap = placementToMap(newPlacement);

  const vacated = [];
  const occupied = [];
  for (let rank = 1; rank <= 8; rank++) {
    for (let f = 0; f < 8; f++) {
      const sq = FILES[f] + rank;
      const oldP = oldMap[sq] || null;
      const newP = newMap[sq] || null;
      if (oldP !== newP) {
        if (oldP) vacated.push({ sq, piece: oldP });
        if (newP) occupied.push({ sq, piece: newP });
      }
    }
  }

  for (const v of vacated) {
    if (v.piece === "K" || v.piece === "k") {
      const d = occupied.find((o) => o.piece === v.piece);
      if (d) return { from: v.sq, to: d.sq };
    }
  }
  for (const v of vacated) {
    const d = occupied.find((o) => o.piece === v.piece);
    if (d) return { from: v.sq, to: d.sq };
  }
  for (const v of vacated) {
    if (v.piece === "P" || v.piece === "p") {
      const lastRank = v.piece === "P" ? "8" : "1";
      const d = occupied.find((o) => o.sq[1] === lastRank);
      if (d) return { from: v.sq, to: d.sq, promotion: d.piece.toLowerCase() };
    }
  }
  return null;
}
