//! relay-rook-ble — Chessnut Move BLE daemon.
//!
//! Single binary. Listens on a Unix socket; speaks newline-delimited
//! JSON to whoever connects (the Haskell bridge in production, `socat`
//! during debugging). All Chessnut-specific bytes flow through us
//! opaquely — the codec lives in Haskell so type-checking spans the
//! whole protocol.
//!
//! BLE init runs as a retrying background task so launchd-spawned
//! daemons stay responsive even before the user has granted CoreBluetooth
//! permission. Clients calling Op::Connect / Op::Write before BLE is
//! ready receive an Event::Error with a clear message.

#![forbid(unsafe_code)]

mod ble;
mod chessnut;
mod wire;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, Mutex};

use crate::ble::{Ble, Notification};
use crate::wire::{DeviceInfo, Event, Op};

#[derive(Parser, Debug)]
#[command(name = "relay-rook-ble", about)]
struct Args {
    /// Unix socket path to listen on.
    #[arg(long, env = "RELAY_ROOK_BLE_SOCKET",
          default_value = "/tmp/relay-rook-ble.sock")]
    socket: PathBuf,
}

/// Shared handle: `None` until BLE init succeeds, then `Some(Arc<Ble>)`.
type BleSlot = Arc<Mutex<Option<Arc<Ble>>>>;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    if args.socket.exists() {
        std::fs::remove_file(&args.socket)
            .with_context(|| format!("removing stale socket at {:?}", args.socket))?;
    }
    if let Some(dir) = args.socket.parent() {
        std::fs::create_dir_all(dir).ok();
    }

    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("binding socket {:?}", args.socket))?;
    tracing::info!(socket=?args.socket, "relay-rook-ble listening (BLE init pending)");

    let ble_slot: BleSlot = Arc::new(Mutex::new(None));
    spawn_ble_init(ble_slot.clone());

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error=?e, "accept failed");
                continue;
            }
        };
        let slot = ble_slot.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, slot).await {
                tracing::warn!(error=?e, "client disconnected with error");
            }
        });
    }
}

/// Background task: keep trying to bring BLE up. Each failure is logged
/// with a hint at what the user has to do; on success the slot is
/// populated and the auto-connect loop is started.
fn spawn_ble_init(slot: BleSlot) {
    tokio::spawn(async move {
        let mut warned = false;
        loop {
            match Ble::new().await {
                Ok(b) => {
                    let arc_b = Arc::new(b);
                    arc_b.start_autoconnect();
                    let mut g = slot.lock().await;
                    *g = Some(arc_b);
                    tracing::info!(
                        "BLE adapter ready; auto-connect loop is now scanning."
                    );
                    return;
                }
                Err(e) => {
                    if !warned {
                        tracing::warn!(
                            "BLE adapter not ready: {e:#}\n  \
                            Almost always this means macOS Bluetooth permission has not been granted to relay-rook-ble.\n  \
                            Open System Settings → Privacy & Security → Bluetooth and enable relay-rook-ble.\n  \
                            (Will keep retrying every 5s; this message won't repeat.)"
                        );
                        warned = true;
                    } else {
                        tracing::debug!("BLE init still failing: {e:#}");
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

async fn handle_client(stream: UnixStream, slot: BleSlot) -> Result<()> {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half).lines();
    let writer = Arc::new(tokio::sync::Mutex::new(write_half));

    // Subscribe to notifications even if BLE isn't up yet — the channel
    // exists in the slot once BLE initializes; for now subscribe to
    // whatever's available, re-subscribe when BLE becomes ready.
    let notif_handle = {
        let slot_guard = slot.lock().await;
        slot_guard.as_ref().map(|b| b.notifications.subscribe())
    };
    let writer_for_notif = writer.clone();
    let notif_task = if let Some(rx) = notif_handle {
        Some(tokio::spawn(forward_notifications(rx, writer_for_notif)))
    } else {
        // Spawn a deferred subscriber: poll the slot until it's ready,
        // then forward.
        let slot2 = slot.clone();
        let writer2 = writer.clone();
        Some(tokio::spawn(async move {
            loop {
                let rx = {
                    let g = slot2.lock().await;
                    g.as_ref().map(|b| b.notifications.subscribe())
                };
                if let Some(rx) = rx {
                    forward_notifications(rx, writer2).await;
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }))
    };

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event = match serde_json::from_str::<Op>(trimmed) {
            Ok(op) => dispatch(op, &slot).await,
            Err(e) => Event::Error {
                message: format!("parse error: {e}"),
            },
        };
        send(&writer, event).await?;
    }

    if let Some(t) = notif_task {
        t.abort();
    }
    Ok(())
}

async fn dispatch(op: Op, slot: &BleSlot) -> Event {
    let ble: Option<Arc<Ble>> = {
        let g = slot.lock().await;
        g.as_ref().cloned()
    };
    let ble = match ble {
        Some(b) => b,
        None => {
            return Event::Error {
                message: "BLE adapter not ready — grant macOS Bluetooth \
                         permission for relay-rook-ble (System Settings → \
                         Privacy & Security → Bluetooth)."
                    .into(),
            }
        }
    };

    match op {
        Op::Connect { address } => match ble.connect(address).await {
            Ok((addr, name)) => Event::Connected { address: addr, name },
            Err(e) => Event::Error { message: format!("{e:#}") },
        },
        Op::Disconnect => match ble.disconnect().await {
            Ok(()) => Event::Disconnected,
            Err(e) => Event::Error { message: format!("{e:#}") },
        },
        Op::Write { data } => match B64.decode(&data) {
            Ok(bytes) => match ble.write_command(&bytes).await {
                Ok(()) => Event::Ack,
                Err(e) => Event::Error { message: format!("{e:#}") },
            },
            Err(e) => Event::Error { message: format!("base64: {e}") },
        },
        Op::LatestFen => Event::LatestFen {
            data: ble.last_fen().await.map(|b| B64.encode(b)),
        },
        Op::Status => {
            let (connected, address) = ble.snapshot().await;
            Event::Status { connected, address }
        }
        Op::Scan { timeout_ms } => match ble.scan(Duration::from_millis(timeout_ms)).await {
            Ok(items) => Event::ScanResult {
                devices: items
                    .into_iter()
                    .map(|(addr, name)| DeviceInfo {
                        address: addr.to_string(),
                        name,
                    })
                    .collect(),
            },
            Err(e) => Event::Error { message: format!("{e:#}") },
        },
    }
}

async fn forward_notifications(
    mut rx: broadcast::Receiver<Notification>,
    writer: Arc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
) {
    loop {
        match rx.recv().await {
            Ok(n) => {
                let event = match n {
                    Notification::Fen(b) => Event::Notification {
                        characteristic: "fen",
                        data: B64.encode(b),
                    },
                    Notification::Cmd(b) => Event::Notification {
                        characteristic: "cmd",
                        data: B64.encode(b),
                    },
                };
                if send(&writer, event).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn send(
    writer: &Arc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
    event: Event,
) -> Result<()> {
    let mut line = serde_json::to_string(&event)?;
    line.push('\n');
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes()).await?;
    Ok(())
}
