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
  startAdvanceWatch();
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
      stopAdvanceWatch();
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

// --- Auto-advance: start the next puzzle without touching the screen ---

// Chessable ships its own "Auto-next" toggle in the MoveTrainer footer. When
// it is off the session parks on a finished variation until someone clicks,
// which is invisible to a student training on the physical board. We turn the
// native toggle on where we find it, and click the forward control ourselves
// for the states it does not cover.
//
// The test ids below are Chessable's own, read out of its production bundle.
// Only controls that move forward inside the session are listed. giveUpButton,
// skipButton and exitButton are deliberately absent: an unattended session must
// never abandon a puzzle or leave the trainer.
const ADVANCE_SELECTOR = '[data-testid="nextLessonButton"], [data-testid="continueButton"]';
const AUTO_NEXT_SELECTOR = '[data-testid="autoNextLessonButton"]';
// nextLessonButton is reused for "Next variation", "Next chapter" and "Next
// course". Only the first stays inside the material being trained, so the
// other two are vetoed by label rather than by selector.
const ADVANCE_ALLOW = /continue|next variation/i;
const ADVANCE_VETO = /exit|quit|leave|finish|chapter|course/i;
const ADVANCE_POLL_MS = 600;

let advanceTimer = null;
let autoNextChecked = false;
let lastAdvanceClick = 0;

const log = (...args) => console.log("[relay-rook]", ...args);

function isVisible(el) {
  if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function controlLabel(el) {
  return (el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.title || "");
}

// Chessable's own toggle, flipped on once per page. We only ever turn it ON:
// the label says which state it is in, and an unrecognised label is left alone
// rather than guessed at, because guessing wrong turns the feature off.
function enableChessableAutoNext() {
  if (autoNextChecked) return;
  const btn = document.querySelector(AUTO_NEXT_SELECTOR);
  if (!btn || !isVisible(btn)) return;
  autoNextChecked = true;
  const label = controlLabel(btn);
  if (/auto-next is off/i.test(label)) {
    log("turning on Chessable's own Auto-next");
    simulateClick(btn);
  } else if (/auto-next is on/i.test(label)) {
    log("Chessable's Auto-next is already on");
  } else {
    log("Auto-next control found but its state is unreadable; leaving it alone:", label.trim());
  }
}

function findAdvanceControl() {
  for (const el of document.querySelectorAll(ADVANCE_SELECTOR)) {
    if (!isVisible(el)) continue;
    const label = controlLabel(el);
    if (ADVANCE_VETO.test(label)) continue;
    if (!ADVANCE_ALLOW.test(label)) continue;
    return el;
  }
  return null;
}

// The physical board is the reason this exists, so it also gets a veto: the
// background script knows whether the board has caught up with the position we
// last pushed to it. Advancing while they disagree would score a variation the
// student never saw.
function tryAdvance() {
  if (awaitingSimResult) return;
  enableChessableAutoNext();
  const control = findAdvanceControl();
  if (!control) return;
  if (Date.now() - lastAdvanceClick < 1500) return;

  chrome.runtime.sendMessage({ type: "MAY_ADVANCE" })
    .then((reply) => {
      if (!reply || !reply.ok) {
        log("holding: " + ((reply && reply.reason) || "no answer from the bridge"));
        return;
      }
      if (!isVisible(control)) return;
      lastAdvanceClick = Date.now();
      log("advancing:", controlLabel(control).trim().slice(0, 40));
      simulateClick(control);
    })
    .catch(() => { /* service worker restarting; next tick retries */ });
}

function startAdvanceWatch() {
  if (advanceTimer) return;
  advanceTimer = setInterval(tryAdvance, ADVANCE_POLL_MS);
}

function stopAdvanceWatch() {
  if (advanceTimer) { clearInterval(advanceTimer); advanceTimer = null; }
  autoNextChecked = false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PHYSICAL_FEN" && lastFen) {
    const move = fenDiff(lastFen, msg.placement);
    if (move) playMoveOnBoard(move.from, move.to);
    sendResponse({ ok: !!move });
  } else if (msg.type === "RECONNECT") {
    detachBoardObserver();
    stopAdvanceWatch();
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
