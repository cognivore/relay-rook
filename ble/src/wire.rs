//! Wire protocol between this daemon and the Haskell bridge.
//!
//! Newline-delimited JSON. Each frame is exactly one JSON object on its
//! own line. Base64 is used to pack arbitrary byte payloads inside JSON.

use serde::{Deserialize, Serialize};

/// Commands the Haskell client sends to us.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Connect to a Chessnut Move. If `address` is omitted, pick the
    /// first board whose advertised name starts with "Chessnut".
    Connect { address: Option<String> },
    /// Drop the BLE connection (the next Connect will re-scan).
    Disconnect,
    /// Write a raw command frame to COMMAND_WRITE_UUID. The Haskell
    /// codec is responsible for the byte layout.
    Write {
        /// base64-encoded bytes
        data: String,
    },
    /// Return the most recent FEN notification frame we cached, or null
    /// if the device has not reported one this session.
    LatestFen,
    /// Connection state snapshot.
    Status,
    /// One-shot scan — useful for debugging from the CLI.
    Scan { timeout_ms: u64 },
}

/// Events we push (synchronously after Op or asynchronously from BLE).
#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Connected {
        address: String,
        name: Option<String>,
    },
    Disconnected,
    /// A notification was pushed by the device.
    Notification {
        /// "fen" or "cmd" — which characteristic the bytes came from.
        characteristic: &'static str,
        /// base64-encoded bytes.
        data: String,
    },
    LatestFen {
        data: Option<String>,
    },
    Status {
        connected: bool,
        address: Option<String>,
    },
    ScanResult {
        devices: Vec<DeviceInfo>,
    },
    /// Acknowledgement for fire-and-forget writes.
    Ack,
    /// Anything went wrong — connection failure, protocol error, etc.
    Error {
        message: String,
    },
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub address: String,
    pub name: Option<String>,
}
