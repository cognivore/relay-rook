# relay-rook

Bridge between **Chessable** (web) and a **Chessnut Move** robotic chess
board. Two cooperating processes in this repo, one toolchain for each
job:

```
[Chessable web] → ext → [relay-rook (Haskell)] ──unix-socket──→ [relay-rook-ble (Rust)] → BLE → [board]
                                  │
                                  └── SQLite (events + snapshot, shared with future services)
```

- **`relay-rook`** (Haskell + beam-sqlite + scotty) is the brain. Pure
  programs in `RelayRook.Program` are constrained over `MonadBoard`,
  `MonadStore`, `MonadClock` — they cannot do I/O at all (the constraint
  set does not include `MonadIO`, so `callCommand`, `httpLbs`, etc.
  literally fail to typecheck inside them). The Chessnut binary codec
  is also in Haskell.
- **`relay-rook-ble`** (Rust + btleplug + tokio) is the BLE owner. Tiny
  daemon: scan, connect, write bytes to the command characteristic,
  forward notifications back over a Unix socket. No protocol semantics
  on this side; the codec lives in the brain.
- A newline-delimited JSON protocol over the Unix socket connects the
  two. `wire.rs` (Rust) and `RelayRook.Board.Wire` (Haskell) are the
  two sides of that contract.

## Compliance rules

1. `RelayRook.Core`, `.Effects`, `.Program`, `.Board.Codec`, `.Board.Protocol`,
   `.Board.Wire` perform **zero I/O**. Constraints are MtL classes, not `MonadIO`.
2. Programs accept `MonadBoard`/`MonadStore`/`MonadClock` only.
3. All domain identifiers go through validated value constructors
   (`parseFen`, `parseOrientation`).
4. Only `RelayRook.Adapters`, `.Server`, `.Migrate`, and `app/Main.hs`
   touch the OS in the Haskell tree.
5. The Rust crate forbids `unsafe_code` workspace-wide.
6. Events are append-only. Migrations are content-hashed; replays with
   a drifted hash are a startup error.
7. Tests use mock instances of the port classes (see
   `test/RelayRook/ProgramSpec.hs`) and import none of the adapters.

## Module map

### Haskell (`src/RelayRook/`)

| Module                | Purpose                                                      | I/O? |
|-----------------------|--------------------------------------------------------------|------|
| `Core`                | Validated types, ADTs, JSON instances                        | No   |
| `Effects`             | `MonadBoard` / `MonadStore` / `MonadClock` ports             | No   |
| `Program`             | Pure programs (`syncBoardFen`, ...)                          | No   |
| `Board.Protocol`      | Chessnut Move: type tags, lengths, init/config payloads      | No   |
| `Board.Codec`         | Pure encoders (SYNC, LED) and decoders (board-state notify)  | No   |
| `Board.Wire`          | JSON wire types for the Unix socket to the BLE daemon        | No   |
| `Schema`              | beam table types (mirrors `schema.sql`)                      | No   |
| `Migrate`             | Content-hashed migration runner                              | Yes  |
| `Adapters`            | `AppM`, BLE socket I/O, beam-sqlite I/O                      | Yes  |
| `Server`              | scotty routes wiring programs                                | Yes  |
| `app/Main.hs`         | Entry: env, migrate, connect to BLE daemon, scotty           | Yes  |

### Rust (`ble/src/`)

| Module       | Purpose                                                       |
|--------------|---------------------------------------------------------------|
| `chessnut`   | UUIDs, init/config payload bytes, name prefix                 |
| `wire`       | JSON `Op` / `Event` types — mirror of `Board.Wire` in Haskell |
| `ble`        | btleplug wrapper: scan, connect, subscribe, write             |
| `main`       | Unix socket server, async dispatch                            |

## Shared database

`schema.sql` is the canonical source. `migrations/<service>/NNN_*.sql`
are versioned, content-hashed, and replayed by the runner against the
`_schema_versions(service, version, hash, applied_at)` ledger. Sibling
services live in their own namespaces:

```
migrations/
  relay_rook/                # owned by us
    001_init.sql
  bookwright/                # future: LLM book importer (example)
    001_courses.sql
```

A new microservice imports `RelayRook.Effects` for the `MonadStore`
class, declares its own beam tables, and shares the SQLite file
(WAL mode handles cross-service concurrency).

## HTTP API (`relay-rook`, default `:8674`)

| Method | Path                       | Body / Returns                                       |
|--------|----------------------------|------------------------------------------------------|
| GET    | `/health`                  | `{"status":"ok"}`                                    |
| GET    | `/api/board/state`         | snapshot: `fen`, `orientation`, `updated_at`         |
| POST   | `/api/board/fen`           | `{"fen":"...", "force": true}` → `{fen, rollback}`   |
| GET    | `/api/board/fen`           | physical board fen (or null) — last seen on the wire |
| POST   | `/api/board/orientation`   | `{"orientation":"white"\|"black"}`                   |

## Unix socket protocol (between `relay-rook` and `relay-rook-ble`)

Newline-delimited JSON. Default socket path: `~/.local/state/relay-rook/ble.sock`.

```
Client → daemon
  {"op":"connect","address":null}
  {"op":"write","data":"<base64 bytes>"}
  {"op":"latest_fen"}
  {"op":"status"}
  {"op":"scan","timeout_ms":3000}

Daemon → client
  {"event":"connected","address":"AB:..","name":"Chessnut"}
  {"event":"notification","characteristic":"fen","data":"<b64>"}
  {"event":"ack"}
  {"event":"error","message":"..."}
```

## Running locally

```
nix develop
cabal build && cabal test                            # in-tree, with full toolchain
nix build .#relay-rook-ble && nix build .#default    # both via nix

# Two-process boot (debug):
nix run .#relay-rook-ble &
RELAY_ROOK_DB=/tmp/relay.db nix run .#default
```

Environment for the bridge:
- `RELAY_ROOK_DB`           — SQLite path (default `relay.db`)
- `RELAY_ROOK_BLE_SOCKET`   — daemon socket (default `/tmp/relay-rook-ble.sock`)
- `RELAY_ROOK_PORT`         — bind port (default `8674`)
- `RELAY_ROOK_MIGRATIONS`   — migrations directory

## Deploying via home-manager (nixvana)

Add this flake as an input, import the module, enable the service:

```nix
{
  inputs.relay-rook.url = "github:cognivore/relay-rook";

  outputs = { ..., relay-rook }: {
    homeConfigurations.<host> = home-manager.lib.homeManagerConfiguration {
      modules = [
        relay-rook.homeManagerModules.default
        ({
          services.relay-rook = {
            enable = true;
            # all options have defaults; override as needed:
            # port = 8674;
            # dbPath = "/Users/.../relay.db";
            # bleSocket = "/Users/.../ble.sock";
          };
        })
      ];
    };
  };
}
```

This generates **two coordinated services**:
- `relay-rook-ble`  (launchd agent / systemd user unit) — BLE daemon
- `relay-rook`      (launchd agent / systemd user unit) — bridge,
  ordered after the BLE daemon; retries the socket on boot

The state directory (`~/.local/state/relay-rook/`) is created by
home-manager activation.

The user's `nixvana/home-manager/flake.nix` already imports this flake;
`pentavus/home.nix` enables it with default options.

## Public exposure via tuntun

`tuntun.nix` declares `rook.<tenant>.<domain>` with the standard
tenant-password gate. Run `tuntun .` from this directory to register;
tuntun handles DNS, Caddy, ACME. The BLE daemon stays local — only the
bridge HTTP gets a public URL.

## Browser extension

`extension/` contains the Chessable content + background scripts. Load
as an unpacked extension in Chrome (`chrome://extensions` → Developer
mode → Load unpacked → `extension/`). Default API URL `http://127.0.0.1:8674`
matches the bridge default.

## Why this shape

A pure-Haskell BLE driver does not exist on macOS — `bleak` works in
Python because CPython has CoreBluetooth via PyObjC, and Rust has
`btleplug`, but Haskell's BLE binding ecosystem is essentially Linux +
DBus. Two-language is the honest answer:

- Rust where the OS forces it (BLE on macOS / Linux / Windows via
  `btleplug` is the only sane cross-platform option). Daemon stays
  small (~600 LoC) and dumb — no protocol semantics.
- Haskell for everything that benefits from compile-time effect
  tracking and typed-SQL queries (beam-sqlite). The Chessnut codec
  becomes a typed encoder/decoder you can test without hardware.

Communication is a Unix socket with a newline-JSON contract. Both sides
of the contract are specified in code (`ble/src/wire.rs` and
`src/RelayRook/Board/Wire.hs`); a typo on either side surfaces as a
JSON decode error on the next message rather than silent corruption.

The pure/impure split inside the Haskell tree is the same as before:
`Core` / `Effects` / `Program` / `Board.Codec` / `Board.Protocol` /
`Board.Wire` are zero-I/O; only `Adapters`, `Migrate`, `Server`, `Main`
touch the OS. Tests in `test/RelayRook/ProgramSpec.hs` import no
adapters and use mock instances of all three port classes — so the
suite proves the architectural claim, not just the behaviour.

## Course book archive

Open Relay Rook → **Archive course books**. **Lichess instance** defaults to
`https://lichess.org/`; enter the origin of your self-hosted Lichess to import there.
Sign in to that instance first. No API token or separate download helper is needed.

Use **Archive selected book** for the priority course, or **Archive all books**
for your signed-in Chessable library. The scanner temporarily clears the video
filter, visits each book lesson, rewinds to its starting position, and reads its
rendered moves and commentary. It never starts MoveTrainer or moves the physical
Chessnut board. Completed lessons persist in the extension's IndexedDB; starting
again resumes them. Unexpected markup and incomplete chapters fail explicitly.

Each completed course is saved in Chrome's download directory:

```
Relay Rook Books/Course title [course ID]/
  Book 01.pgn
  Book 02.pgn
  Book.html
  Source.json
```

Original PGN volumes hold at most 64 lessons. HTML is a standalone readable book; JSON
retains the captured commentary HTML, FENs, move tokens and source metadata.
PGN preserves commentary text and chess notation, not HTML typography. A book is
not marked complete if any lesson failed. Check the activity log and scan report.

Private Lichess studies use the chosen instance's existing browser login. The
importer creates a blank study, sets **Invite only**, reopens the settings to
verify privacy, then imports the PGN. It exports the resulting study and compares
starting positions, move trees, annotations and comment text with the source.
Whitespace and PGN annotation spelling are normalized for this comparison.
Lichess rejects PGN null moves. For lessons where one side moves several times
in a row, the importer explicitly starts a new chapter at each recorded post-null
position. It preserves every real move and commentary; the local original PGN
still contains the null moves. Informational lessons become position-only chapters.
The 64-chapter volume limit is applied after this conversion. Artificial positions
without both kings can be studied, but Lichess's engine cannot analyze them.
Interrupted uploads are recorded before sending. Resuming first verifies what is
already on the server and stops for inspection if it differs, rather than silently
appending duplicate chapters. Verified volumes are not repeated.

The extension requests access only to the instance you select. Extra hosts are
optional permissions for self-hosted installations; changing the field does not
transmit any course data. Remote instances require HTTPS, while local loopback
instances can use HTTP. The default Lichess origin has a manifest permission.

Reload the unpacked extension after updating. Version 0.4 replaces video capture
permissions with scripting and downloads. Video experiments are preserved in
commit `4d39fd9`; no video helper or CDM integration runs in the book workflow.
The old ignored local helper configuration and any existing downloads are retained.

A self-hosted Lichess installation has its own accounts and database. Saving a
study on lichess.org does not synchronize that server to your laptop. Keep the
local files and import the PGNs into your local instance before going offline.

Checks (Nix supplies Node):

```sh
nix develop .#books -c node archive/test-book.cjs
nix develop .#books -c node archive/test-scanner.cjs
```

Lichess's website forms and study import routes are used with its session login;
upstream UI changes can require an adapter update. The field and endpoint checks
fail explicitly instead of choosing another instance or authentication method.

Live validation on lichess.org imported course 258968's introduction, an annotated
lesson with a side variation, and a repeated-turn rook exercise split into two
chapters. The exported annotated lesson retained all four commentary blocks;
the split exercise retained its recorded FEN and final commentary. These checks
cover the conversion/import format, not a completed full-library extension scan.
