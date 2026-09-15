"use strict";

// boardParser.js (parseChessableBoard, fenDiff) loads first via manifest.

const BOARD_SELECTORS = ["#board", '[data-testid="boardContainer"]'];
const DEBOUNCE_MS = 300;
const SETTLE_MS = 300;

let lastFen = null;
let lastOrientation = null;
let boardObserver = null;
let bodyObserver = null;
let debounceTimer = null;
let settleTimer = null;
let awaitingSimResult = false;

const findBoard = () => {
  for (const sel of BOARD_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
};

function readAndRelay() {
  if (awaitingSimResult) return;
  const boardEl = findBoard();
  if (!boardEl) return;
  const result = parseChessableBoard(boardEl);
  if (!result) return;

  const fenChanged = result.fen !== lastFen;
  const orientationChanged = result.orientation !== lastOrientation;
  if (!fenChanged && !orientationChanged) return;

  lastFen = result.fen;
  lastOrientation = result.orientation;

  chrome.runtime.sendMessage({
    type: "FEN_UPDATE",
    fen: result.fen,
    orientation: result.orientation,
    fenChanged,
    orientationChanged,
  });
}

function onBoardMutation() {
  if (awaitingSimResult) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { awaitingSimResult = false; readAndRelay(); }, SETTLE_MS);
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(readAndRelay, DEBOUNCE_MS);
}

function attachBoardObserver(boardEl) {
  detachBoardObserver();
  boardObserver = new MutationObserver(onBoardMutation);
  boardObserver.observe(boardEl, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-piece", "style"],
  });
  readAndRelay();
  chrome.runtime.sendMessage({ type: "BOARD_FOUND" });
}

function detachBoardObserver() {
  if (boardObserver) { boardObserver.disconnect(); boardObserver = null; }
}

function tryAttach() {
  const boardEl = findBoard();
  if (boardEl) { attachBoardObserver(boardEl); return true; }
  return false;
}

function watchForBoard() {
  if (bodyObserver) bodyObserver.disconnect();
  bodyObserver = new MutationObserver(() => {
    const boardEl = findBoard();
    const isAttached = boardObserver !== null;
    if (boardEl && !isAttached) {
      attachBoardObserver(boardEl);
    } else if (!boardEl && isAttached) {
      detachBoardObserver();
      lastFen = null;
      lastOrientation = null;
      awaitingSimResult = false;
      clearTimeout(settleTimer);
      chrome.runtime.sendMessage({ type: "BOARD_LOST" });
    }
  });
  bodyObserver.observe(document.body, { subtree: true, childList: true });
}

// --- Reverse sync: physical board -> chessable ---

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

function simulateClick(el) {
  const c = centerOf(el);
  const opts = { bubbles: true, cancelable: true, view: window, button: 0, ...c };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

function playMoveOnBoard(from, to) {
  const boardEl = findBoard();
  if (!boardEl) return;
  const fromEl = boardEl.querySelector(`[data-square="${from}"]`);
  const toEl = boardEl.querySelector(`[data-square="${to}"]`);
  if (!fromEl || !toEl) return;
  awaitingSimResult = true;
  simulateClick(fromEl);
  setTimeout(() => simulateClick(toEl), 100);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PHYSICAL_FEN" && lastFen) {
    const move = fenDiff(lastFen, msg.placement);
    if (move) playMoveOnBoard(move.from, move.to);
    sendResponse({ ok: !!move });
  } else if (msg.type === "RECONNECT") {
    detachBoardObserver();
    lastFen = null;
    lastOrientation = null;
    awaitingSimResult = false;
    clearTimeout(settleTimer);
    clearTimeout(debounceTimer);
    sendResponse({ ok: tryAttach() });
  }
  return false;
});

// Heartbeat to recover the service worker if it was restarted.
setInterval(() => {
  try {
    if (boardObserver) chrome.runtime.sendMessage({ type: "HEARTBEAT" }).catch(() => {});
  } catch { /* extension context invalidated */ }
}, 20000);

function init() {
  tryAttach();
  watchForBoard();
  chrome.runtime.sendMessage({ type: "CONTENT_READY" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
