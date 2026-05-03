-- v1: events log + snapshot table. The `_schema_versions` ledger is
-- created by the migration runner before this migration is applied.

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS events_kind_id_desc ON events (kind, id DESC);

CREATE TABLE IF NOT EXISTS snapshot (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
