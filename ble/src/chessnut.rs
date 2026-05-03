//! Chessnut Move BLE constants — UUIDs, init/config payloads.
//!
//! Reverse-engineered values, ported verbatim from the openchessnutmove
//! Python codebase (`chessnut_move_stack/driver/protocol.py`). Do not
//! "improve" without coordinating: the magic bytes are the contract.

use uuid::{uuid, Uuid};

/// Service exposing FEN board-state notifications.
pub const FEN_SERVICE_UUID: Uuid = uuid!("1b7e8261-2877-41c3-b46e-cf057c562023");
/// Notify characteristic — board state pushed by the device.
pub const FEN_NOTIFY_UUID: Uuid = uuid!("1b7e8262-2877-41c3-b46e-cf057c562023");

/// Service for command write/responses.
pub const COMMAND_SERVICE_UUID: Uuid = uuid!("1b7e8271-2877-41c3-b46e-cf057c562023");
/// Write characteristic — host → device commands.
pub const COMMAND_WRITE_UUID: Uuid = uuid!("1b7e8272-2877-41c3-b46e-cf057c562023");
/// Notify characteristic — device → host command responses.
pub const COMMAND_NOTIFY_UUID: Uuid = uuid!("1b7e8273-2877-41c3-b46e-cf057c562023");

/// Init handshake the official app sends after connect.
pub const INIT_COMMAND: [u8; 3] = [0x21, 0x01, 0x00];
/// Config payload (rate / buzzer / debounce — not fully documented).
pub const CONFIG_COMMAND: [u8; 6] = [0x0B, 0x04, 0x03, 0xE8, 0x00, 0xC8];

/// Substring used to identify Chessnut Move boards during scan.
pub const NAME_PREFIX: &str = "Chessnut";
