//! BLE state — the singleton Chessnut Move connection lives here.
//!
//! `Connection` owns the btleplug peripheral, the characteristic
//! handles, and the cached "last notification" bytes. The socket task
//! consults / mutates this through an Arc<Mutex<…>>; the BLE
//! notification task pushes notifications into it and into a broadcast
//! channel that socket clients subscribe to.

use anyhow::{anyhow, Context, Result};
use btleplug::api::{
    BDAddr, Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _,
    ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::chessnut;

#[derive(Clone)]
pub enum Notification {
    Fen(Vec<u8>),
    Cmd(Vec<u8>),
}

#[derive(Default)]
pub struct State {
    pub peripheral: Option<Peripheral>,
    pub address: Option<String>,
    pub name: Option<String>,
    pub command_write: Option<Characteristic>,
    pub last_fen_notification: Option<Vec<u8>>,
}

pub struct Ble {
    pub adapter: Adapter,
    pub state: Arc<Mutex<State>>,
    pub notifications: broadcast::Sender<Notification>,
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
        })
    }

    /// Scan briefly and return everything that looks like a Chessnut
    /// Move board.
    pub async fn scan(&self, timeout: Duration) -> Result<Vec<(BDAddr, Option<String>)>> {
        self.adapter.start_scan(ScanFilter::default()).await?;
        tokio::time::sleep(timeout).await;
        let peripherals = self.adapter.peripherals().await?;
        let _ = self.adapter.stop_scan().await;
        let mut out = Vec::new();
        for p in peripherals {
            let props = match p.properties().await? {
                Some(p) => p,
                None => continue,
            };
            if props
                .local_name
                .as_deref()
                .map(|n| n.contains(chessnut::NAME_PREFIX))
                .unwrap_or(false)
            {
                out.push((p.address(), props.local_name));
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

        let candidates = self.scan(Duration::from_secs(5)).await?;
        let chosen = match address_filter {
            Some(filter) => candidates
                .into_iter()
                .find(|(addr, _)| addr.to_string().eq_ignore_ascii_case(&filter)),
            None => candidates.into_iter().next(),
        }
        .ok_or_else(|| anyhow!("no Chessnut Move board found"))?;

        let (addr, name) = chosen;
        let peripherals = self.adapter.peripherals().await?;
        let peripheral = peripherals
            .into_iter()
            .find(|p| p.address() == addr)
            .ok_or_else(|| anyhow!("peripheral {addr} disappeared between scan and connect"))?;

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
                    Notification::Fen(n.value)
                } else if n.uuid == chessnut::COMMAND_NOTIFY_UUID {
                    Notification::Cmd(n.value)
                } else {
                    tracing::debug!(uuid=%n.uuid, "notification on unknown characteristic, dropping");
                    continue;
                };
                // Receivers may all have disconnected; that's fine.
                let _ = notif_tx.send(kind);
            }
            tracing::warn!("BLE notification stream ended");
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

        Ok((addr.to_string(), name))
    }

    pub async fn disconnect(&self) -> Result<()> {
        let mut st = self.state.lock().await;
        if let Some(p) = st.peripheral.take() {
            let _ = p.disconnect().await;
        }
        st.address = None;
        st.name = None;
        st.command_write = None;
        st.last_fen_notification = None;
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
        peripheral.write(cwrite, data, wtype).await?;
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

    /// Spawn the auto-connect / auto-reconnect loop. Replaces the
    /// "client must explicitly send Op::Connect" model — the daemon
    /// now scans on its own forever, and recovers transparently when
    /// the board powers off, sleeps, or moves out of range.
    ///
    /// Mirrors openchessnutmove's `DriverManager._auto_connect_loop`.
    pub fn start_autoconnect(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let (connected, peripheral) = {
                    let st = me.state.lock().await;
                    (st.peripheral.is_some(), st.peripheral.clone())
                };
                if connected {
                    // Confirm the peripheral is still alive; clear and
                    // rescan if it died.
                    if let Some(p) = peripheral {
                        let alive = p.is_connected().await.unwrap_or(false);
                        if !alive {
                            tracing::warn!("auto-connect: peripheral disconnected; will rescan");
                            let _ = me.disconnect().await;
                        }
                    }
                } else {
                    match me.connect(None).await {
                        Ok((addr, name)) => {
                            tracing::info!(addr=%addr, name=?name, "auto-connect: connected");
                        }
                        Err(e) => {
                            tracing::debug!(error=?e, "auto-connect: not yet, retrying in 3s");
                        }
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
