"use strict";

// Relay-rook server endpoints. The server owns rollback detection now;
// we use its `rollback` flag to lock the physical board until it complies.

const DEFAULT_API_URL = "http://127.0.0.1:8674";
const POLL_MS = 500;

const BADGE_SYNCING = "#4CAF50";
const BADGE_IDLE = "#9E9E9E";
const BADGE_ERROR = "#F44336";

const state = {
  enabled: true,
  apiUrl: DEFAULT_API_URL,
  orientationMode: "auto",
  lastFen: null,
  lastOrientation: null,
  lastSyncTime: null,
  boardPresent: false,
};

let chessableTabId = null;
let pollTimer = null;

// Lock state: when the server flags a rollback (or we push a new FEN),
// don't echo the physical board back to chessable until it complies.
let lockFen = null;
let lastSentPlacement = null;

const setBadge = (text, color) => {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

async function loadConfig() {
  try {
    const cfg = await chrome.storage.sync.get({
      apiUrl: DEFAULT_API_URL,
      enabled: true,
      orientationMode: "auto",
    });
    state.apiUrl = cfg.apiUrl;
    state.enabled = cfg.enabled;
    state.orientationMode = cfg.orientationMode;
  } catch { /* keep defaults */ }
}

async function postFen(fen, force) {
  try {
    const resp = await fetch(`${state.apiUrl}/api/board/fen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, force }),
    });
    if (!resp.ok) {
      console.warn("[relay-rook] post fen failed:", resp.status);
      setBadge("!", BADGE_ERROR);
      return null;
    }
    state.lastSyncTime = Date.now();
    setBadge("ON", BADGE_SYNCING);
    return await resp.json();
  } catch (err) {
    console.warn("[relay-rook] post fen error:", err.message);
    setBadge("!", BADGE_ERROR);
    return null;
  }
}

async function postOrientation(orientation) {
  try {
    await fetch(`${state.apiUrl}/api/board/orientation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orientation }),
    });
  } catch { /* best-effort */ }
}

const startPoll = () => { stopPoll(); pollTimer = setInterval(pollPhysical, POLL_MS); };
const stopPoll  = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

async function pollPhysical() {
  if (!state.enabled || !state.boardPresent || chessableTabId === null) return;
  try {
    const resp = await fetch(`${state.apiUrl}/api/board/fen`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return;
    const data = await resp.json();
    const placement = data.fen ? data.fen.split(" ")[0] : null;
    if (!placement) return;

    if (lockFen !== null) {
      if (placement === lockFen) lockFen = null; // physical complied
      return;
    }
    if (placement === state.lastFen) { lastSentPlacement = null; return; }
    if (placement === lastSentPlacement) return;

    lastSentPlacement = placement;
    chrome.tabs.sendMessage(chessableTabId, { type: "PHYSICAL_FEN", placement }).catch(() => {});
  } catch { /* poll failure, ignore */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) chessableTabId = sender.tab.id;

  if (!state.enabled && msg.type !== "GET_STATE" && msg.type !== "SET_CONFIG") {
    sendResponse({ ok: false, reason: "disabled" });
    return false;
  }

  switch (msg.type) {
    case "FEN_UPDATE": {
      const tasks = [];
      if (msg.fenChanged) {
        state.lastFen = msg.fen;
        const fromPhysical = msg.fen === lastSentPlacement;
        if (!fromPhysical) {
          lockFen = msg.fen;
          tasks.push(postFen(msg.fen, true));
        }
      }
      if (!state.boardPresent) {
        state.boardPresent = true;
        setBadge("ON", BADGE_SYNCING);
        startPoll();
      }
      if (state.orientationMode === "auto"
          && msg.orientation
          && msg.orientation !== state.lastOrientation) {
        state.lastOrientation = msg.orientation;
        tasks.push(postOrientation(msg.orientation));
      }
      Promise.all(tasks).then(() => sendResponse({ ok: true }));
      return true;
    }

    case "BOARD_FOUND":
      state.boardPresent = true;
      setBadge("ON", BADGE_SYNCING);
      startPoll();
      sendResponse({ ok: true });
      return false;

    case "BOARD_LOST":
      state.boardPresent = false;
      state.lastFen = null;
      lockFen = null;
      lastSentPlacement = null;
      stopPoll();
      setBadge("", BADGE_IDLE);
      sendResponse({ ok: true });
      return false;

    case "RECONNECT":
      lockFen = null;
      lastSentPlacement = null;
      stopPoll();
      if (chessableTabId !== null) {
        chrome.tabs.sendMessage(chessableTabId, { type: "RECONNECT" }, (r) =>
          sendResponse(r || { ok: false }));
        return true;
      }
      sendResponse({ ok: false, reason: "no tab" });
      return false;

    case "HEARTBEAT":
      if (state.boardPresent && !pollTimer) startPoll();
      sendResponse({ ok: true });
      return false;

    case "CONTENT_READY":
      sendResponse({ ok: true });
      return false;

    case "GET_STATE":
      sendResponse({ ...state });
      return false;

    case "SET_CONFIG":
      if (msg.apiUrl !== undefined) state.apiUrl = msg.apiUrl.replace(/\/+$/, "");
      if (msg.enabled !== undefined) state.enabled = msg.enabled;
      if (msg.orientationMode !== undefined) {
        state.orientationMode = msg.orientationMode;
        const target = msg.orientationMode === "auto"
          ? state.lastOrientation
          : msg.orientationMode;
        if (target) {
          state.lastOrientation = target;
          postOrientation(target);
        }
      }
      chrome.storage.sync.set({
        apiUrl: state.apiUrl,
        enabled: state.enabled,
        orientationMode: state.orientationMode,
      });
      setBadge(
        !state.enabled ? "OFF" : state.boardPresent ? "ON" : "",
        state.enabled && state.boardPresent ? BADGE_SYNCING : BADGE_IDLE,
      );
      sendResponse({ ok: true });
      return false;

    default:
      sendResponse({ ok: false, reason: "unknown message type" });
      return false;
  }
});

loadConfig().then(() => setBadge(state.enabled ? "" : "OFF", BADGE_IDLE));
