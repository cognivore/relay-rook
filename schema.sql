-- Canonical, hand-edited schema. Re-applied idempotently. The migration
-- runner in 'RelayRook.Migrate' replays NNN_*.sql files under
-- migrations/relay_rook/ and records each in `_schema_versions`.
--
-- Future microservices (e.g. an LLM book importer) add their own
-- versioned migration files under migrations/<their-namespace>/, and
-- their own tables next to ours. The events table is the cross-service
-- bus; adding a column requires a new migration in this namespace.

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

-- Latest known state, keyed by domain (`board` is ours).
CREATE TABLE IF NOT EXISTS snapshot (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-service migration ledger. Owned by no single service; created on
-- first boot by whichever service runs migrations first.
CREATE TABLE IF NOT EXISTS _schema_versions (
  service    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (service, version)
);
