-- | Tiny content-hashed migration runner.
--
-- - Scans @migrations\/\<service\>\/NNN_*.sql@.
-- - Tracks applied migrations in @_schema_versions(service, version, hash, applied_at)@.
-- - Refuses to run if a recorded hash drifted from the file on disk —
--   that is the signal that someone hand-edited a shipped migration.
-- - Applies in transaction order; idempotent.
--
-- Sibling services drop files into their own @migrations\/\<their-namespace\>\/@
-- and call this runner with their service name.
{-# LANGUAGE OverloadedStrings #-}

module RelayRook.Migrate
  ( runMigrations
  , MigrationError (..)
  ) where

import Control.Exception (Exception, throwIO)
import Control.Monad (forM_, unless)
import Crypto.Hash.SHA256 (hash)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Base16 as B16
import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Text.Encoding as TE
import Data.Time (getCurrentTime)
import Data.Time.Format.ISO8601 (iso8601Show)
import qualified Database.SQLite.Simple as SQL
import Database.SQLite.Simple (Connection, Only (..))
import qualified Database.SQLite3 as SQLite3
import System.Directory (doesDirectoryExist, listDirectory)
import System.FilePath ((</>), takeBaseName, takeExtension)

data MigrationError
  = MigrationDirMissing FilePath
  | MigrationHashDrift Text Int Text Text
  | MigrationFileMalformed FilePath
  deriving (Show)

instance Exception MigrationError

-- | Run all pending migrations under @migrations\/\<service\>\/@.
runMigrations :: Connection -> Text -> FilePath -> IO ()
runMigrations conn service dir = do
  exists <- doesDirectoryExist dir
  unless exists $ throwIO (MigrationDirMissing dir)
  ensureLedger conn
  files <- pendingFiles dir
  forM_ files $ \(version, path) -> applyOne conn service version path

ensureLedger :: Connection -> IO ()
ensureLedger conn =
  SQL.execute_
    conn
    "CREATE TABLE IF NOT EXISTS _schema_versions (\
    \  service TEXT NOT NULL,\
    \  version INTEGER NOT NULL,\
    \  hash TEXT NOT NULL,\
    \  applied_at TEXT NOT NULL,\
    \  PRIMARY KEY (service, version))"

-- | Sorted (version, fullPath) for every NNN_*.sql under dir.
pendingFiles :: FilePath -> IO [(Int, FilePath)]
pendingFiles dir = do
  names <- listDirectory dir
  let sql = filter ((== ".sql") . takeExtension) names
  parsed <- mapM (parseName dir) sql
  pure (sortByVersion parsed)
  where
    sortByVersion = foldr insertSorted []
    insertSorted x [] = [x]
    insertSorted x (y : ys)
      | fst x <= fst y = x : y : ys
      | otherwise = y : insertSorted x ys

parseName :: FilePath -> FilePath -> IO (Int, FilePath)
parseName dir name = case break (== '_') name of
  (numText, _ : _) -> case reads numText of
    [(n, "")] -> pure (n, dir </> name)
    _ -> throwIO (MigrationFileMalformed (dir </> name))
  _ -> throwIO (MigrationFileMalformed (dir </> name))

applyOne :: Connection -> Text -> Int -> FilePath -> IO ()
applyOne conn service version path = do
  bytes <- BS.readFile path
  let h = TE.decodeUtf8 (B16.encode (hash bytes))
  rows <-
    SQL.query
      conn
      "SELECT hash FROM _schema_versions WHERE service = ? AND version = ?"
      (service, version) ::
      IO [Only Text]
  case rows of
    [Only existing] ->
      unless (existing == h) $
        throwIO (MigrationHashDrift service version existing h)
    _ -> do
      -- direct-sqlite's `exec` runs the entire script (multiple
      -- statements separated by `;`), unlike sqlite-simple's `execute_`
      -- which only handles one prepared statement at a time.
      SQL.withTransaction conn $ do
        SQLite3.exec (SQL.connectionHandle conn) (TE.decodeUtf8 bytes)
        now <- T.pack . iso8601Show <$> getCurrentTime
        SQL.execute
          conn
          "INSERT INTO _schema_versions (service, version, hash, applied_at) VALUES (?, ?, ?, ?)"
          (service, version, h, now)
      putStrLn ("[migrate] " <> T.unpack service <> " v" <> show version <> " applied (" <> takeBaseName path <> ")")
