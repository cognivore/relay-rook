PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Append-only event log shared across services.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_kind_id_desc ON events (kind, id DESC);

-- Latest known state, keyed by domain (`board` is ours; future services pick
-- their own keys or add their own tables).
CREATE TABLE IF NOT EXISTS snapshot (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
