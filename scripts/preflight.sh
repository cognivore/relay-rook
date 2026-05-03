#!/usr/bin/env bash
# Preflight: walks each layer of the stack and reports pass/fail.
# Run after `home-manager switch` to find out whether you can actually
# practice chess yet, and where the chain is broken if not.
#
#   ./scripts/preflight.sh           # full check including a SYNC that moves pieces
#   SKIP_SYNC=1 ./scripts/preflight.sh   # everything except the physical move
set -u

SOCKET="${RELAY_ROOK_BLE_SOCKET:-$HOME/.local/state/relay-rook/ble.sock}"
PORT="${RELAY_ROOK_PORT:-8674}"
BRIDGE="http://127.0.0.1:$PORT"
SKIP_SYNC="${SKIP_SYNC:-0}"

if [ -t 1 ]; then C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else                C_G=""; C_R=""; C_Y=""; C_B=""; C_0=""; fi

FAILED=0
section() { printf "\n${C_B}%s${C_0}\n" "$1"; }
pass()    { printf "  ${C_G}✓${C_0} %s\n" "$1"; }
fail()    { printf "  ${C_R}✗${C_0} %s\n    ${C_Y}→ %s${C_0}\n" "$1" "$2"; FAILED=$((FAILED+1)); }

# ---- 1. binaries ------------------------------------------------------------
section "1. binaries"
for bin in relay-rook relay-rook-ble; do
  if path=$(command -v "$bin"); then
    pass "$bin → $path"
  else
    fail "$bin not on PATH" "home-manager switch --flake ~/Github/nixvana/home-manager#pentavus"
  fi
done

# ---- 2. launchd agents ------------------------------------------------------
section "2. launchd agents"
agents=$(launchctl list 2>/dev/null || true)
for svc in relay-rook-ble relay-rook; do
  if printf '%s\n' "$agents" | awk '{print $3}' | grep -qx "$svc"; then
    pid=$(printf '%s\n' "$agents" | awk -v s="$svc" '$3==s{print $1}')
    [ "$pid" = "-" ] && fail "$svc loaded but not running (last exit non-zero)" \
      "tail -n 50 ~/Library/Logs/$svc.log" \
      || pass "$svc running (pid $pid)"
  else
    fail "$svc agent not loaded" \
      "did 'home-manager switch' run cleanly? if it failed on stylix, try 'nix flake update' first"
  fi
done

# ---- 3. socket --------------------------------------------------------------
section "3. BLE daemon socket"
if [ -S "$SOCKET" ]; then
  pass "socket file exists at $SOCKET"
else
  fail "socket missing at $SOCKET" "tail -n 50 ~/Library/Logs/relay-rook-ble.log"
fi

# ---- 4. scan ----------------------------------------------------------------
section "4. BLE scan — does the daemon see your board?"
if [ ! -S "$SOCKET" ]; then
  fail "skipping (no socket)" ""
else
  scan_json=$(python3 - "$SOCKET" <<'PY' 2>/dev/null
import json, socket, sys
sock_path = sys.argv[1]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(8)
    s.connect(sock_path)
    s.sendall(b'{"op":"scan","timeout_ms":5000}\n')
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
    print(buf.split(b"\n", 1)[0].decode())
except Exception as e:
    print("__ERROR__", e)
PY
)
  if [ -z "$scan_json" ] || [[ "$scan_json" == __ERROR__* ]]; then
    fail "could not query the daemon" "${scan_json#__ERROR__ }"
  else
    summary=$(printf '%s' "$scan_json" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ev = d.get('event')
if ev == 'scan_result':
    devices = d.get('devices', [])
    print(len(devices))
    for x in devices:
        print(f'  {x.get(\"address\")}  {x.get(\"name\") or \"(no name)\"}')
elif ev == 'error':
    print('-1')
    print('  daemon error: ' + d.get('message',''))
else:
    print('-2')
    print('  unexpected event: ' + str(d))
")
    count=$(printf '%s' "$summary" | head -1)
    rest=$(printf '%s' "$summary" | tail -n +2)
    case "$count" in
      0)  fail "0 devices visible to BLE" \
            "is the board powered on? has macOS asked for Bluetooth permission? — System Settings → Privacy & Security → Bluetooth → enable for relay-rook-ble" ;;
      -1) fail "daemon refused" "$rest" ;;
      -2) fail "unexpected daemon reply" "$rest" ;;
      *)  pass "$count device(s) found:"
          printf '%s\n' "$rest" ;;
    esac
  fi
fi

# ---- 5. bridge HTTP ---------------------------------------------------------
section "5. bridge HTTP at $BRIDGE"
if h=$(curl -fsS --max-time 3 "$BRIDGE/health" 2>/dev/null); then
  pass "/health → $h"
else
  fail "/health unreachable" "tail -n 50 ~/Library/Logs/relay-rook.log"
fi
if s=$(curl -fsS --max-time 3 "$BRIDGE/api/board/state" 2>/dev/null); then
  pass "/api/board/state → $s"
else
  fail "/api/board/state failed" ""
fi

# ---- 6. SYNC roundtrip (physical move!) -------------------------------------
section "6. SYNC roundtrip"
if [ "$SKIP_SYNC" = "1" ]; then
  printf "  (skipped — SKIP_SYNC=1)\n"
elif [ "$FAILED" -gt 0 ]; then
  printf "  (skipped — earlier checks failed)\n"
else
  printf "  ${C_Y}This will tell the board to move pieces to the Sicilian (1. e4 c5).${C_0}\n"
  printf "  Press ENTER to send, or ctrl-C to skip → "
  if read -r _; then
    if r=$(curl -fsS --max-time 5 -X POST "$BRIDGE/api/board/fen" \
              -H 'Content-Type: application/json' \
              -d '{"fen":"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR"}' 2>&1); then
      pass "bridge accepted SYNC → $r"
      printf "  Board should be moving now. Silent? Codec or device-name port bug — open an issue.\n"
    else
      fail "SYNC POST failed" "$r"
    fi
  fi
fi

# ---- summary ----------------------------------------------------------------
section "summary"
if [ "$FAILED" -eq 0 ]; then
  printf "${C_G}All checks passed.${C_0} Open a Chessable lesson; the badge should turn green.\n"
else
  printf "${C_R}%d check(s) failed.${C_0} See hints above.\n" "$FAILED"
fi
exit "$FAILED"
