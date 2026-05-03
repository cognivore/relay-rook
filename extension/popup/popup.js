"use strict";

const $ = (id) => document.getElementById(id);

const enabledToggle = $("enabled-toggle");
const toggleLabel = $("toggle-label");
const statusDot = $("status-dot");
const statusText = $("status-text");
const fenDisplay = $("fen-display");
const apiUrlInput = $("api-url");
const reconnectBtn = $("reconnect-btn");
const orientBtns = document.querySelectorAll(".orient-btn");

const setStatus = (cls, text) => {
  statusDot.className = "dot " + cls;
  statusText.textContent = text;
};

function renderState(s) {
  enabledToggle.checked = s.enabled;
  toggleLabel.textContent = s.enabled ? "ON" : "OFF";
  apiUrlInput.value = s.apiUrl || "http://127.0.0.1:8674";
  const mode = s.orientationMode || "auto";
  orientBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.orient === mode));

  if (!s.enabled) { setStatus("gray", "Sync disabled"); fenDisplay.textContent = "--"; return; }
  if (s.boardPresent && s.lastFen) { setStatus("green", "Syncing board"); fenDisplay.textContent = s.lastFen; }
  else if (s.boardPresent) { setStatus("green", "Board detected, waiting..."); fenDisplay.textContent = "--"; }
  else { setStatus("gray", "No board found — open a Chessable lesson"); fenDisplay.textContent = "--"; }
}

const fetchState = () =>
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (r) => r && renderState(r));

enabledToggle.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "SET_CONFIG", enabled: enabledToggle.checked }, fetchState));

let urlTimer = null;
apiUrlInput.addEventListener("input", () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const apiUrl = apiUrlInput.value.replace(/\/+$/, "");
    chrome.runtime.sendMessage({ type: "SET_CONFIG", apiUrl }, fetchState);
  }, 500);
});

orientBtns.forEach((btn) =>
  btn.addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "SET_CONFIG", orientationMode: btn.dataset.orient }, fetchState)));

reconnectBtn.addEventListener("click", () => {
  reconnectBtn.textContent = "Reconnecting...";
  reconnectBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "RECONNECT" }, () => {
    setTimeout(() => {
      reconnectBtn.textContent = "Reconnect";
      reconnectBtn.disabled = false;
      fetchState();
    }, 500);
  });
});

fetchState();
setInterval(fetchState, 2000);
