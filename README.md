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

## Offline course video archive

Start the archive helper from this checkout with Nix:

```sh
nix run .#archive
# Choose another disk if desired:
nix run .#archive -- --root /Volumes/MyDisk/Chessable
```

Open the course you want first, then click Relay Rook → **Archive all courses**.
On the archive page, start the scan. It enumerates the signed-in library's **All**
view, prioritizes the course you opened, then visits each chapter in order.
For each video it starts muted playback in its scan tab, captures the actual
Vimeo CDN manifest and license request context, pauses once playback starts, and sends that stream
to the local helper. It waits for the download result before visiting the next
chapter. The scan does not synchronize its positions to your Chessnut board.

The helper uses Nix-provided Python, pywidevine, yt-dlp, Bento4 and FFmpeg. Its dependencies are
pinned separately from the existing board bridge toolchain in `flake.lock`.
There are no alternate installers, anonymous video URL resolvers, or automatic
format fallbacks. The clear-stream format is `bv+ba`; absent streams, unsupported
manifest types, failed authentication and incomplete downloads fail explicitly.
Network/fragment retries and the durable per-video queue provide fault tolerance.
A failed chapter appears immediately in the **Activity log** and the saved report
while the remaining chapters continue. The log survives reloading the archive tab.
Use **View log** beside a video for the downloader's recent output and progress;
signed URLs and request credentials are redacted from that view.

Widevine MPD streams require a valid local device provision (`.wvd`) accepted by
the provider and its public service certificate observed in the player's EME
`setServerCertificate` call. An EME log supplies PSSH, key IDs and encrypted license
messages, **not plaintext content keys or a device provision**. Relay Rook cannot
generate a Google-provisioned device file. Start with explicit private file paths:

```sh
nix run .#archive -- --device /private/path/device.wvd --certificate /private/path/service-certificate.bin
```

Defaults are `.relay-rook/device.wvd` and `.relay-rook/service-certificate.bin` in
the archive folder. Keep the device file outside the repository/Nix store with
permissions `600`. No keys or provision files belong in Git or the Nix closure.

The helper parses the captured MPD, loads the local provision and public provider
certificate, and sends a new privacy-mode challenge to the **exact captured Vimeo
license endpoint**. It supports raw binary Widevine requests/responses; a wrapped
JSON protocol requires an explicit adapter and fails visibly. Redirects are
rejected, and credentials are never sent to a third-party key service. The browser's
original challenge/response is not retained or replayed as the helper's license.

Only after obtaining every required content key does it download the separate
encrypted tracks, decrypt using Bento4, merge them, and decode the full result to
check audio/video integrity. A bad key never produces a completed archive entry.
Keys remain in helper memory and are passed to the local Bento4 process; they are
not persisted in queue state or logs. Missing provisions/certificates and rejected
licenses stop before downloading encrypted media. The queue continues other jobs.

After updating, reload Relay Rook at `chrome://extensions`. This version adds
`webRequest` and access to the Vimeo player/CDN for passive observation. Capture
is restricted to disposable scan tabs explicitly armed by the archive page.
It does not collect cookies from other sites or inspect ordinary browsing tabs.
The helper listens on `127.0.0.1:8675` and requires a random local access token.
The generated `extension/archive/local-config.json` is ignored by Git: do not
commit it or use a `path:` flake containing it. Stream URLs and headers stay in
private local queue metadata. Any observed CDN cookies are supplied through a
short-lived cookie file scoped to the exact CDN host, not a global HTTP header.

Keep the archive tab and helper open while scanning/downloading. Rescanning
refreshes expired stream URLs and does not duplicate completed videos. Missing
completed files are queued again. **Stop scanning** retains queued work;
**Pause after current video** finishes the current file and stops the download
queue. **Retry failed downloads** repeats the same captured request; rescan the
course when the signed URL or authentication has expired. Restarting the helper
resumes pending jobs. Closing Chrome mid-scan requires a new scan.
Jobs saved before browser-stream capture was introduced are marked **need a fresh
scan**. Retry cannot run these incomplete jobs; a new scan captures their request.

Default output is `~/Movies/Relay Rook/`:

```text
Course title [course ID]/
  003 - Chapter title [chapter ID]/
    01 - Video title [Vimeo ID].mp4
```

The helper merges the chosen audio/video tracks with FFmpeg. It preserves partial
files, never overwrites completed videos and aborts on missing fragments. Queue
state, output paths and logs live in the private `.relay-rook/` directory within
the archive. Keep that directory and use the same `--root` when restarting.

Check both the download table and **Save scan report** before going offline.
A completed scan is not a claim that every video was saved. The report records
chapters with no accessible video player and any capture/download failure. The
scanner uses the rendered Chessable chapter markup, so a site redesign must fail
visibly and may require an update. This archives videos, not MoveTrainer.

Checks:

```sh
nix develop .#archive -c python3 -m unittest discover -s archive -p 'test_*.py'
nix develop .#archive -c node archive/test-scanner.cjs
nix develop .#archive -c node archive/test-capture.cjs
nix develop .#archive -c node archive/test-controller.cjs
```

Browser capture has been verified against course 258968's protected MPD streams.
The local download path and CENC decryption/merge/full-decode path have been checked
with generated test media, including rejection of a wrong key. A real course license
has not been acquired: a usable device provision remains required. These local
checks do not establish a successful course archive.

References: [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest),
[yt-dlp](https://github.com/yt-dlp/yt-dlp#usage-and-options).

### OpenWV setup

The archive page links to **OpenWV setup for Chrome on macOS**, including the
device prerequisite, private build command, Chrome directory layout and rollback.
OpenWV requires a device provision too; installing it does not supply one or
automatically provide keys to the separate archive helper.

`nix develop .#openwv -c bash archive/build-openwv.sh /private/device.wvd /private/new-build-dir`
prepares the pinned upstream source and builds outside the Nix store. Nix supplies
the toolchain; Cargo uses the upstream lockfile. The script refuses missing or
invalid device files, shared device permissions and existing build directories.
It produces a private Chrome package without changing the installed browser.
No complete OpenWV build has been verified here because no provision was supplied.
