//! BLE state — the singleton Chessnut Move connection lives here.
//!
//! `Connection` owns the btleplug peripheral, the characteristic
//! handles, and the cached "last notification" bytes. The socket task
//! consults / mutates this through an Arc<Mutex<…>>; the BLE
//! notification task pushes notifications into it and into a broadcast
//! channel that socket clients subscribe to.

use anyhow::{anyhow, Context, Result};
use btleplug::api::{
    Central, CentralEvent, CharPropFlags, Characteristic, Manager as _, Peripheral as _,
    ScanFilter, ValueNotification, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures::stream::{Stream, StreamExt};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::{chessnut, scan};

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
    session: Arc<()>,
    notification_tasks: tokio::task::JoinSet<()>,
}

impl State {
    fn clear(&mut self) {
        // Replacing the JoinSet aborts the old listener, including listeners
        // waiting on a notification stream that never closes by itself.
        *self = Self::default();
    }
}

pub struct Ble {
    pub adapter: Adapter,
    pub state: Arc<Mutex<State>>,
    pub notifications: broadcast::Sender<BoardEvent>,
    /// Serializes BLE scans. Concurrent `start_scan`/`stop_scan` calls
    /// (e.g. the auto-connect loop racing a client `Op::Scan`) corrupt
    /// btleplug's CoreBluetooth backend — it logs "Event receiver died"
    /// and the adapter goes dead until the process restarts.
    scan_lock: Arc<Mutex<()>>,
    connection_lock: Mutex<()>,
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
            scan_lock: Arc::new(Mutex::new(())),
            connection_lock: Mutex::new(()),
        })
    }

    /// Scan for Chessnut Move boards, returning live peripheral handles.
    ///
    /// Subscribe before starting the scan so the first advertisement cannot
    /// race the listener. Inspect only newly discovered/updated devices.
    pub async fn scan(&self, timeout: Duration) -> Result<Vec<ScanMatch>> {
        scan::scan(
            BoardDiscovery {
                adapter: self.adapter.clone(),
                address: None,
            },
            self.scan_lock.clone(),
            timeout,
        )
        .await
    }

    /// Connect to the first matching Chessnut, or to a specific address
    /// if `address_filter` is set.
    pub async fn connect(
        &self,
        address_filter: Option<String>,
    ) -> Result<(String, Option<String>)> {
        let deadline = tokio::time::Instant::now() + CONNECT_LIMIT;
        let _connection = tokio::time::timeout_at(deadline, self.connection_lock.lock())
            .await
            .context("timed out waiting for another board connection operation")?;
        // If already connected, return current state.
        {
            let st = self.state.lock().await;
            if let (Some(addr), name) = (&st.address, st.name.clone()) {
                return Ok((addr.clone(), name));
            }
        }

        let candidates = tokio::time::timeout_at(
            deadline,
            scan::scan(
                BoardDiscovery {
                    adapter: self.adapter.clone(),
                    address: address_filter,
                },
                self.scan_lock.clone(),
                Duration::from_secs(10),
            ),
        )
        .await
        .context("timed out scanning for the board")??;
        let chosen = candidates
            .into_iter()
            .next()
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

        let setup = tokio::time::timeout_at(deadline, async {
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
            // Subscribe before the handshake, but publish the task only after it
            // succeeds. Failed setup must not leave a detached notification task.
            let stream = peripheral
                .notifications()
                .await
                .context("opening board notification stream")?;

            // Send INIT and CONFIG so the board starts streaming.
            peripheral
                .write(&cmd_write, &chessnut::INIT_COMMAND, WriteType::WithResponse)
                .await
                .context("write INIT_COMMAND")?;
            peripheral
                .write(
                    &cmd_write,
                    &chessnut::CONFIG_COMMAND,
                    WriteType::WithResponse,
                )
                .await
                .context("write CONFIG_COMMAND")?;
            Ok::<_, anyhow::Error>((cmd_write, stream))
        })
        .await
        .context("timed out initialising the board")
        .and_then(|result| result);

        let (cmd_write, stream) = match setup {
            Ok(ready) => ready,
            Err(primary) => {
                let cleanup = tokio::time::timeout(Duration::from_secs(5), peripheral.disconnect())
                    .await
                    .context("timed out disconnecting after failed board setup")
                    .and_then(|result| result.context("disconnecting after failed board setup"));
                return match cleanup {
                    Ok(()) => Err(primary),
                    Err(cleanup) => Err(SetupFailure { primary, cleanup }.into()),
                };
            }
        };

        let mut st = self.state.lock().await;
        st.clear();
        st.peripheral = Some(peripheral);
        st.address = Some(addr.to_string());
        st.name = name.clone();
        st.command_write = Some(cmd_write);
        st.last_heard = Some(Instant::now());
        let session = st.session.clone();
        st.notification_tasks.spawn(forward_board_notifications(
            stream,
            self.state.clone(),
            self.notifications.clone(),
            session,
        ));

        Ok((addr.to_string(), name))
    }

    pub async fn disconnect(&self) -> Result<()> {
        let _connection = self.connection_lock.lock().await;
        let mut st = self.state.lock().await;
        let had_peripheral = st.peripheral.is_some();
        if let Some(p) = st.peripheral.take() {
            // The peripheral may be wedged; do not let its teardown hang the
            // caller, which on the auto-connect path is the recovery loop.
            let _ = tokio::time::timeout(Duration::from_secs(5), p.disconnect()).await;
        }
        st.clear();
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
        tokio::time::timeout(
            Duration::from_secs(10),
            peripheral.write(cwrite, data, wtype),
        )
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
            let note = |unwell: &mut Option<Instant>, bad: bool| {
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

                        let alive =
                            match tokio::time::timeout(Duration::from_secs(5), p.is_connected())
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
                        match me.connect(None).await {
                            Ok((addr, name)) => {
                                tracing::info!(addr=%addr, name=?name, "auto-connect: connected");
                                note(&mut unwell_since, false);
                            }
                            Err(e) => {
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

struct BoardDiscovery {
    adapter: Adapter,
    address: Option<String>,
}

impl scan::ScanBackend for BoardDiscovery {
    type Id = PeripheralId;
    type Match = ScanMatch;

    async fn events(&self) -> Result<scan::Events<PeripheralId>> {
        let events = Central::events(&self.adapter).await?;
        Ok(Box::pin(events.filter_map(|event| async move {
            match event {
                CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => Some(id),
                _ => None,
            }
        })))
    }

    async fn start(&self) -> Result<()> {
        self.adapter
            .start_scan(ScanFilter {
                local_name_contains: Some(chessnut::NAME_PREFIX.to_owned()),
                ..ScanFilter::default()
            })
            .await
            .context("starting Chessnut discovery")
    }

    async fn stop(&self) -> Result<()> {
        self.adapter
            .stop_scan()
            .await
            .context("stopping Chessnut discovery")
    }

    async fn matching(&self, id: PeripheralId) -> Result<Option<ScanMatch>> {
        let peripheral = match self.adapter.peripheral(&id).await {
            Ok(peripheral) => peripheral,
            Err(btleplug::Error::DeviceNotFound) => return Ok(None),
            Err(error) => return Err(error).context("reading discovered peripheral"),
        };
        let Some(properties) = peripheral.properties().await? else {
            return Ok(None);
        };
        if !properties
            .local_name
            .as_deref()
            .is_some_and(|name| name.contains(chessnut::NAME_PREFIX))
        {
            return Ok(None);
        }
        if self.address.as_deref().is_some_and(|address| {
            !peripheral
                .address()
                .to_string()
                .eq_ignore_ascii_case(address)
        }) {
            return Ok(None);
        }
        Ok(Some(ScanMatch {
            address: peripheral.address().to_string(),
            name: properties.local_name,
            peripheral,
        }))
    }
}

#[derive(Debug)]
struct SetupFailure {
    primary: anyhow::Error,
    cleanup: anyhow::Error,
}

impl std::fmt::Display for SetupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "board setup failed: {:#}; cleanup also failed: {:#}",
            self.primary, self.cleanup
        )
    }
}

impl std::error::Error for SetupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.primary.as_ref())
    }
}

async fn forward_board_notifications(
    mut stream: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
    state: Arc<Mutex<State>>,
    notifications: broadcast::Sender<BoardEvent>,
    session: Arc<()>,
) {
    while let Some(n) = stream.next().await {
        let mut st = state.lock().await;
        if !Arc::ptr_eq(&st.session, &session) {
            return;
        }
        let event = if n.uuid == chessnut::FEN_NOTIFY_UUID {
            st.last_fen_notification = Some(n.value.clone());
            BoardEvent::Fen(n.value)
        } else if n.uuid == chessnut::COMMAND_NOTIFY_UUID {
            BoardEvent::Cmd(n.value)
        } else {
            continue;
        };
        st.last_heard = Some(Instant::now());
        let _ = notifications.send(event);
    }
    let mut st = state.lock().await;
    if Arc::ptr_eq(&st.session, &session) {
        tracing::warn!("BLE notification stream ended; dropping the connection");
        st.clear();
        let _ = notifications.send(BoardEvent::Disconnected);
    }
}

fn pick(
    chars: &std::collections::BTreeSet<Characteristic>,
    uuid: Uuid,
    prop: CharPropFlags,
) -> Option<Characteristic> {
    chars
        .iter()
        .find(|c| c.uuid == uuid && c.properties.contains(prop))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn old_notification_stream_cannot_overwrite_or_clear_a_new_session() {
        let old = Arc::new(());
        let state = Arc::new(Mutex::new(State {
            address: Some("current board".into()),
            last_fen_notification: Some(vec![42]),
            ..State::default()
        }));
        let (notifications, mut events) = broadcast::channel(4);
        let stream = futures::stream::iter([ValueNotification {
            uuid: chessnut::FEN_NOTIFY_UUID,
            value: vec![0],
        }]);
        forward_board_notifications(
            Box::pin(stream),
            state.clone(),
            notifications.clone(),
            old.clone(),
        )
        .await;
        forward_board_notifications(
            Box::pin(futures::stream::empty()),
            state.clone(),
            notifications,
            old,
        )
        .await;
        let st = state.lock().await;
        assert_eq!(st.address.as_deref(), Some("current board"));
        assert_eq!(st.last_fen_notification, Some(vec![42]));
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn clearing_a_connection_releases_its_pending_notification_task() {
        let state = Arc::new(Mutex::new(State::default()));
        let held = Arc::new(());
        let weak = Arc::downgrade(&held);
        {
            let mut st = state.lock().await;
            st.notification_tasks.spawn(async move {
                let _held = held;
                futures::future::pending::<()>().await;
            });
            st.clear();
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("disconnect must release the old notification task");
    }
}
