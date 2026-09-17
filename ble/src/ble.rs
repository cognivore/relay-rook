//! BLE state — the singleton Chessnut Move connection lives here.
//!
//! `Connection` owns the btleplug peripheral, the characteristic
//! handles, and the cached "last notification" bytes. The socket task
//! consults / mutates this through an Arc<Mutex<…>>; the BLE
//! notification task pushes notifications into it and into a broadcast
//! channel that socket clients subscribe to.

use anyhow::{anyhow, Context, Result};
use btleplug::api::{
    Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _,
    ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::chessnut;

/// How long the board may say nothing before we treat the link as dead. It
/// streams its state about twice a second, so this is a very long silence.
const SILENCE_LIMIT: Duration = Duration::from_secs(15);
/// Upper bound on one connect attempt, scan included.
const CONNECT_LIMIT: Duration = Duration::from_secs(45);
/// How long the Bluetooth stack may stay unusable before we give up on this
/// process and let the service manager restart us.
const STACK_GIVE_UP: Duration = Duration::from_secs(180);
/// The one connect failure that means "nothing wrong, just no board here".
const NO_BOARD: &str = "no Chessnut Move board found";

/// Anything the board does that a socket client needs to hear about. This
/// carries the loss of the link as well as its traffic: a client that is only
/// told about notifications has no way to distinguish a quiet board from one
/// that is gone, and will happily keep serving the last position it saw.
#[derive(Clone)]
pub enum BoardEvent {
    Fen(Vec<u8>),
    Cmd(Vec<u8>),
    Disconnected,
}

/// A discovered Chessnut board. We keep the live `peripheral` handle so
/// we can connect to it directly: on macOS CoreBluetooth hides MAC
/// addresses (every peripheral reports `00:00:00:00:00:00`), so the
/// address is useless for re-identifying a device — the handle is not.
pub struct ScanMatch {
    pub peripheral: Peripheral,
    pub address: String,
    pub name: Option<String>,
}

#[derive(Default)]
pub struct State {
    pub peripheral: Option<Peripheral>,
    pub address: Option<String>,
    pub name: Option<String>,
    pub command_write: Option<Characteristic>,
    pub last_fen_notification: Option<Vec<u8>>,
    /// When the board last said anything. The Chessnut streams its state
    /// continuously, so silence is the most reliable evidence that the link
    /// has died — more reliable than asking btleplug, which on macOS can keep
    /// reporting a peripheral as connected after its event loop has gone.
    pub last_heard: Option<Instant>,
}

pub struct Ble {
    pub adapter: Adapter,
    pub state: Arc<Mutex<State>>,
    pub notifications: broadcast::Sender<BoardEvent>,
    /// Serializes BLE scans. Concurrent `start_scan`/`stop_scan` calls
    /// (e.g. the auto-connect loop racing a client `Op::Scan`) corrupt
    /// btleplug's CoreBluetooth backend — it logs "Event receiver died"
    /// and the adapter goes dead until the process restarts.
    scan_lock: Mutex<()>,
}

impl Ble {
    pub async fn new() -> Result<Self> {
        let manager = Manager::new().await.context("btleplug Manager::new")?;
        // adapters() on macOS blocks until CoreBluetooth reports
        // PoweredOn. If the user has not granted Bluetooth permission
        // yet, that never happens. Time it out so we can surface a
        // clear retry-with-hint instead of hanging forever.
        let adapters = tokio::time::timeout(Duration::from_secs(5), manager.adapters())
            .await
            .map_err(|_| {
                anyhow!(
                    "BLE adapter not ready after 5s — most likely macOS \
                     Bluetooth permission is not granted for this binary. \
                     Open System Settings → Privacy & Security → Bluetooth \
                     and enable `relay-rook-ble`."
                )
            })??;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("no BLE adapter on this system"))?;
        let (tx, _rx) = broadcast::channel(64);
        Ok(Self {
            adapter,
            state: Arc::new(Mutex::new(State::default())),
            notifications: tx,
            scan_lock: Mutex::new(()),
        })
    }

    /// Scan for Chessnut Move boards, returning live peripheral handles.
    ///
    /// We poll `peripherals()` repeatedly during the window and return as
    /// soon as a board appears, rather than sleeping the whole `timeout`
    /// and reading once: on a cold adapter the device is frequently not
    /// in the list until several advertising intervals in, which made the
    /// old fixed-5s single read miss boards that were plainly present.
    /// If nothing shows up we keep looking until `timeout` elapses.
    pub async fn scan(&self, timeout: Duration) -> Result<Vec<ScanMatch>> {
        let _scan_guard = self.scan_lock.lock().await;
        self.adapter.start_scan(ScanFilter::default()).await?;
        let deadline = Instant::now() + timeout;
        let matches = loop {
            let found = self.matching_peripherals().await?;
            if !found.is_empty() || Instant::now() >= deadline {
                break found;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        let _ = self.adapter.stop_scan().await;
        Ok(matches)
    }

    /// One pass over the adapter's currently-known peripherals, keeping
    /// those whose advertised name marks them as a Chessnut board.
    async fn matching_peripherals(&self) -> Result<Vec<ScanMatch>> {
        let peripherals = self.adapter.peripherals().await?;
        let mut out = Vec::new();
        for p in peripherals {
            let props = match p.properties().await? {
                Some(props) => props,
                None => continue,
            };
            let is_chessnut = props
                .local_name
                .as_deref()
                .map(|n| n.contains(chessnut::NAME_PREFIX))
                .unwrap_or(false);
            if is_chessnut {
                out.push(ScanMatch {
                    address: p.address().to_string(),
                    name: props.local_name,
                    peripheral: p,
                });
            }
        }
        Ok(out)
    }

    /// Connect to the first matching Chessnut, or to a specific address
    /// if `address_filter` is set.
    pub async fn connect(&self, address_filter: Option<String>) -> Result<(String, Option<String>)> {
        // If already connected, return current state.
        {
            let st = self.state.lock().await;
            if let (Some(addr), name) = (&st.address, st.name.clone()) {
                return Ok((addr.clone(), name));
            }
        }

        let candidates = self.scan(Duration::from_secs(10)).await?;
        let chosen = match address_filter {
            Some(filter) => candidates
                .into_iter()
                .find(|m| m.address.eq_ignore_ascii_case(&filter)),
            None => candidates.into_iter().next(),
        }
        .ok_or_else(|| anyhow!("no Chessnut Move board found"))?;

        // Connect to the scanned handle directly — do NOT re-fetch and
        // match by address. On macOS every peripheral's address is
        // 00:00:00:00:00:00, so an address match would grab an arbitrary
        // device. The bleak reference keeps the scanned handle for the
        // same reason.
        let ScanMatch {
            peripheral,
            address: addr,
            name,
        } = chosen;

        peripheral.connect().await.context("BLE connect")?;
        peripheral
            .discover_services()
            .await
            .context("discover_services")?;

        let chars = peripheral.characteristics();
        let fen_notify = pick(&chars, chessnut::FEN_NOTIFY_UUID, CharPropFlags::NOTIFY)
            .ok_or_else(|| anyhow!("FEN notify characteristic not found"))?;
        let cmd_notify = pick(&chars, chessnut::COMMAND_NOTIFY_UUID, CharPropFlags::NOTIFY)
            .ok_or_else(|| anyhow!("command notify characteristic not found"))?;
        let cmd_write = pick(&chars, chessnut::COMMAND_WRITE_UUID, CharPropFlags::WRITE)
            .or_else(|| {
                pick(
                    &chars,
                    chessnut::COMMAND_WRITE_UUID,
                    CharPropFlags::WRITE_WITHOUT_RESPONSE,
                )
            })
            .ok_or_else(|| anyhow!("command write characteristic not found"))?;

        peripheral.subscribe(&fen_notify).await?;
        peripheral.subscribe(&cmd_notify).await?;

        // Spawn the notification listener.
        let notif_tx = self.notifications.clone();
        let state_arc = self.state.clone();
        let p_clone = peripheral.clone();
        tokio::spawn(async move {
            let mut stream = match p_clone.notifications().await {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error=?e, "could not get notification stream");
                    return;
                }
            };
            while let Some(n) = stream.next().await {
                let kind = if n.uuid == chessnut::FEN_NOTIFY_UUID {
                    let mut st = state_arc.lock().await;
                    st.last_fen_notification = Some(n.value.clone());
                    st.last_heard = Some(Instant::now());
                    BoardEvent::Fen(n.value)
                } else if n.uuid == chessnut::COMMAND_NOTIFY_UUID {
                    let mut st = state_arc.lock().await;
                    st.last_heard = Some(Instant::now());
                    BoardEvent::Cmd(n.value)
                } else {
                    tracing::debug!(uuid=%n.uuid, "notification on unknown characteristic, dropping");
                    continue;
                };
                // Receivers may all have disconnected; that's fine.
                let _ = notif_tx.send(kind);
            }
            // The stream ending is the earliest notice we get that the board
            // is gone. Tear the connection down here rather than waiting for
            // the health check, and tell the clients so they stop trusting the
            // position they are holding.
            tracing::warn!("BLE notification stream ended; dropping the connection");
            {
                let mut st = state_arc.lock().await;
                st.peripheral = None;
                st.address = None;
                st.name = None;
                st.command_write = None;
                st.last_fen_notification = None;
                st.last_heard = None;
            }
            let _ = notif_tx.send(BoardEvent::Disconnected);
        });

        // Send INIT and CONFIG so the board starts streaming.
        peripheral
            .write(&cmd_write, &chessnut::INIT_COMMAND, WriteType::WithResponse)
            .await
            .context("write INIT_COMMAND")?;
        peripheral
            .write(&cmd_write, &chessnut::CONFIG_COMMAND, WriteType::WithResponse)
            .await
            .context("write CONFIG_COMMAND")?;

        let mut st = self.state.lock().await;
        st.peripheral = Some(peripheral);
        st.address = Some(addr.to_string());
        st.name = name.clone();
        st.command_write = Some(cmd_write);
        st.last_heard = Some(Instant::now());

        Ok((addr.to_string(), name))
    }

    pub async fn disconnect(&self) -> Result<()> {
        let mut st = self.state.lock().await;
        let had_peripheral = st.peripheral.is_some();
        if let Some(p) = st.peripheral.take() {
            // The peripheral may be wedged; do not let its teardown hang the
            // caller, which on the auto-connect path is the recovery loop.
            let _ = tokio::time::timeout(Duration::from_secs(5), p.disconnect()).await;
        }
        st.address = None;
        st.name = None;
        st.command_write = None;
        st.last_fen_notification = None;
        st.last_heard = None;
        drop(st);
        if had_peripheral {
            let _ = self.notifications.send(BoardEvent::Disconnected);
        }
        Ok(())
    }

    pub async fn write_command(&self, data: &[u8]) -> Result<()> {
        let st = self.state.lock().await;
        let peripheral = st
            .peripheral
            .as_ref()
            .ok_or_else(|| anyhow!("not connected"))?;
        let cwrite = st
            .command_write
            .as_ref()
            .ok_or_else(|| anyhow!("command_write characteristic missing"))?;
        let wtype = if cwrite.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        // A wedged CoreBluetooth can leave this pending forever, and the
        // bridge is waiting on the other end of the socket.
        tokio::time::timeout(Duration::from_secs(10), peripheral.write(cwrite, data, wtype))
            .await
            .map_err(|_| anyhow!("timed out writing to the board"))??;
        Ok(())
    }

    pub async fn snapshot(&self) -> (bool, Option<String>) {
        let st = self.state.lock().await;
        (st.peripheral.is_some(), st.address.clone())
    }

    pub async fn last_fen(&self) -> Option<Vec<u8>> {
        let st = self.state.lock().await;
        st.last_fen_notification.clone()
    }

    /// Spawn the auto-connect / auto-reconnect loop. The daemon scans on its
    /// own forever and recovers when the board powers off, sleeps, or moves out
    /// of range.
    ///
    /// Every await in here is bounded. btleplug's CoreBluetooth backend can
    /// drop its event loop ("Event receiver died") and leave a peripheral that
    /// answers nothing and never errors, so an unbounded `is_connected` or
    /// `connect` parks this task forever and the daemon goes quiet while
    /// looking perfectly healthy to launchd. That is exactly the failure this
    /// loop exists to recover from, so it must not be able to suffer it.
    pub fn start_autoconnect(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            // When the stack (not merely the board) has been unwell since.
            let mut unwell_since: Option<Instant> = None;
            let mut note = |unwell: &mut Option<Instant>, bad: bool| {
                if bad {
                    unwell.get_or_insert_with(Instant::now);
                } else {
                    *unwell = None;
                }
            };

            loop {
                let (peripheral, last_heard) = {
                    let st = me.state.lock().await;
                    (st.peripheral.clone(), st.last_heard)
                };

                match peripheral {
                    Some(p) => {
                        // The board streams its state continuously, so silence
                        // is the most trustworthy evidence the link is gone.
                        // btleplug is asked too, but it is not believed on its
                        // own and it is not allowed to take its time.
                        let silent_for = last_heard.map(|t| t.elapsed());
                        let silent = silent_for.map(|d| d > SILENCE_LIMIT).unwrap_or(true);

                        let alive = match tokio::time::timeout(
                            Duration::from_secs(5),
                            p.is_connected(),
                        )
                        .await
                        {
                            Ok(Ok(v)) => v,
                            Ok(Err(e)) => {
                                tracing::warn!(error=?e, "auto-connect: is_connected failed");
                                false
                            }
                            Err(_) => {
                                tracing::warn!(
                                    "auto-connect: is_connected did not answer within 5s; \
                                     treating the link as dead"
                                );
                                note(&mut unwell_since, true);
                                false
                            }
                        };

                        if silent || !alive {
                            tracing::warn!(
                                silent_for = ?silent_for,
                                alive,
                                "auto-connect: board is gone; dropping the connection and rescanning"
                            );
                            let _ = me.disconnect().await;
                        } else {
                            note(&mut unwell_since, false);
                        }
                    }
                    None => {
                        match tokio::time::timeout(CONNECT_LIMIT, me.connect(None)).await {
                            Ok(Ok((addr, name))) => {
                                tracing::info!(addr=%addr, name=?name, "auto-connect: connected");
                                note(&mut unwell_since, false);
                            }
                            Ok(Err(e)) => {
                                // No board in range is the normal state of an
                                // idle desk, not a sick Bluetooth stack.
                                let benign = e.to_string().contains(NO_BOARD);
                                if benign {
                                    tracing::debug!("auto-connect: no board in range, retrying");
                                } else {
                                    tracing::warn!(error=?e, "auto-connect: connect failed");
                                }
                                note(&mut unwell_since, !benign);
                            }
                            Err(_) => {
                                tracing::warn!(
                                    "auto-connect: connect did not finish within {:?}",
                                    CONNECT_LIMIT
                                );
                                note(&mut unwell_since, true);
                            }
                        }
                    }
                }

                // Last resort. If the Bluetooth stack has been unusable for
                // this long, no amount of rescanning inside this process will
                // fix it — the adapter handle itself is spoiled. Exit and let
                // launchd (KeepAlive = true) hand us a fresh one. Staying up
                // and quiet is the worst option, because nothing upstream can
                // tell that apart from a working daemon with an idle board.
                if let Some(since) = unwell_since {
                    if since.elapsed() > STACK_GIVE_UP {
                        tracing::error!(
                            "Bluetooth stack has been unusable for {:?}; exiting so the \
                             service manager can restart us with a clean adapter",
                            since.elapsed()
                        );
                        std::process::exit(1);
                    }
                }

                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    }
}

fn pick(chars: &std::collections::BTreeSet<Characteristic>, uuid: Uuid, prop: CharPropFlags) -> Option<Characteristic> {
    chars
        .iter()
        .find(|c| c.uuid == uuid && c.properties.contains(prop))
        .cloned()
}
