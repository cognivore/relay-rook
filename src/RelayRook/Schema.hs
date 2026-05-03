-- | Beam table types mirroring 'schema.sql'. Hand-written to start;
-- regeneratable from a live SQLite DB via @beam-migrate-cli@.
--
-- Beam queries built against this module are checked at compile time;
-- 'Database.Beam.Sqlite.Migrate.verifySchema' (called from 'Main') confirms
-- the running database matches these declarations at boot. Drift between
-- 'schema.sql' and these types is a startup error, not a runtime surprise.
{-# LANGUAGE DeriveAnyClass #-}
{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE DerivingStrategies #-}
{-# LANGUAGE FlexibleInstances #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StandaloneDeriving #-}
{-# LANGUAGE TypeFamilies #-}
{-# LANGUAGE UndecidableInstances #-}

module RelayRook.Schema
  ( EventT (..)
  , EventRow
  , SnapshotT (..)
  , SnapshotRow
  , RelayRookDb (..)
  , relayRookDb
  , relayRookCheckedDb
  ) where

import Data.Int (Int64)
import Data.Text (Text)
import Database.Beam
import Database.Beam.Migrate
  ( CheckedDatabaseSettings
  , defaultMigratableDbSettings
  )
import Database.Beam.Sqlite (Sqlite)

-- | events(id, ts, kind, payload)
data EventT f = EventRow
  { _eventId :: Columnar f Int64
  , _eventTs :: Columnar f Text
  , _eventKind :: Columnar f Text
  , _eventPayload :: Columnar f Text
  }
  deriving stock (Generic)
  deriving anyclass (Beamable)

instance Table EventT where
  data PrimaryKey EventT f = EventId (Columnar f Int64)
    deriving stock (Generic)
    deriving anyclass (Beamable)
  primaryKey = EventId . _eventId

type EventRow = EventT Identity

deriving stock instance Show EventRow

-- | snapshot(key, value, updated_at)
data SnapshotT f = SnapshotRow
  { _snapKey :: Columnar f Text
  , _snapValue :: Columnar f Text
  , _snapUpdatedAt :: Columnar f Text
  }
  deriving stock (Generic)
  deriving anyclass (Beamable)

instance Table SnapshotT where
  data PrimaryKey SnapshotT f = SnapKey (Columnar f Text)
    deriving stock (Generic)
    deriving anyclass (Beamable)
  primaryKey = SnapKey . _snapKey

type SnapshotRow = SnapshotT Identity

deriving stock instance Show SnapshotRow

-- | The bridge's portion of the shared SQLite database. Sibling
-- services declare their own DBs over the same file; SQLite is fine
-- with multiple table sets in one file.
data RelayRookDb f = RelayRookDb
  { _events :: f (TableEntity EventT)
  , _snapshot :: f (TableEntity SnapshotT)
  }
  deriving stock (Generic)
  deriving anyclass (Database be)

-- | Default settings — field names match SQL table names, so no
-- overrides needed.
relayRookDb :: DatabaseSettings be RelayRookDb
relayRookDb = defaultDbSettings

-- | The same database, decorated with the predicates that
-- 'Database.Beam.Sqlite.Migrate.verifySchema' uses to compare against the
-- live SQLite schema.
relayRookCheckedDb :: CheckedDatabaseSettings Sqlite RelayRookDb
relayRookCheckedDb = defaultMigratableDbSettings
