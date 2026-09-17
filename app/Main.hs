-- | Entry: read env, run migrations, verify schema, connect to the
-- BLE daemon, serve.
{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Concurrent (threadDelay)
import Control.Concurrent.MVar (newMVar)
import Control.Exception (SomeException, try)
import Data.IORef (newIORef, writeIORef)
import qualified Data.Text as T
import Database.Beam.Migrate.Simple (VerificationResult (..), verifySchema)
import Database.Beam.Sqlite (runBeamSqlite)
import Database.Beam.Sqlite.Migrate (migrationBackend)
import qualified Database.SQLite.Simple as SQL
import Network.Socket
  ( Family (AF_UNIX)
  , SockAddr (SockAddrUnix)
  , Socket
  , SocketType (Stream)
  , connect
  , socket
  )
import qualified System.Environment as Env
import System.IO (BufferMode (LineBuffering), hSetBuffering, stderr, stdout)
import qualified Web.Scotty as Scotty

import RelayRook.Adapters
  ( AppM
  , Env (..)
  , logLine
  , mkEnv
  , runAppM
  , spawnBleListener
  )
import RelayRook.Core (Orientation (..), Snapshot (..), fenValue, orientationText)
import RelayRook.Effects (MonadStore (..))
import RelayRook.Migrate (runMigrations)
import RelayRook.Schema (relayRookCheckedDb)
import RelayRook.Server (server)

main :: IO ()
main = do
  -- launchd points stdout at a file; GHC would block-buffer it and the
  -- log would lag reality by kilobytes. Line-buffer both streams.
  hSetBuffering stdout LineBuffering
  hSetBuffering stderr LineBuffering

  dbPath <- envOr "RELAY_ROOK_DB" "relay.db"
  bleSock <- envOr "RELAY_ROOK_BLE_SOCKET" "/tmp/relay-rook-ble.sock"
  port <- read <$> envOr "RELAY_ROOK_PORT" "8674"
  migrationsDir <- envOr "RELAY_ROOK_MIGRATIONS" "migrations/relay_rook"

  logLine ("[relay-rook] starting: db=" <> dbPath <> " ble=" <> bleSock <> " port=" <> show port)

  conn <- SQL.open dbPath
  SQL.execute_ conn "PRAGMA journal_mode=WAL"
  SQL.execute_ conn "PRAGMA foreign_keys=ON"

  runMigrations conn "relay_rook" migrationsDir
  verifyAdvisory conn

  sock <- connectWithRetry bleSock 10
  writeLock <- newMVar ()
  latestFen <- newIORef Nothing
  orientationRef <- newIORef White
  let env = mkEnv conn sock writeLock latestFen orientationRef

  -- The board-facing orientation survives restarts through the
  -- snapshot; without this a restart would silently flip a black-side
  -- player back to white until Chessable next re-sent it.
  snap <- runAppM env (getSnapshot :: AppM Snapshot)
  writeIORef orientationRef (snapshotOrientation snap)
  logLine
    ( "[relay-rook] restored snapshot: orientation="
        <> T.unpack (orientationText (snapshotOrientation snap))
        <> " fen=" <> T.unpack (fenValue (snapshotFen snap))
    )

  -- The daemon owns the auto-connect loop; we just listen for events.
  spawnBleListener env

  logLine ("[relay-rook] serving on :" <> show port)
  Scotty.scotty port (server env)

envOr :: String -> String -> IO String
envOr k d = maybe d id <$> Env.lookupEnv k

-- | The relay-rook-ble daemon may not be up yet on first boot. Retry
-- the Unix-socket connect a few times before giving up.
connectWithRetry :: String -> Int -> IO Socket
connectWithRetry path triesLeft = do
  s <- socket AF_UNIX Stream 0
  e <- try (connect s (SockAddrUnix path)) :: IO (Either SomeException ())
  case e of
    Right () -> do
      logLine ("[relay-rook] connected to BLE daemon at " <> path)
      pure s
    Left err
      | triesLeft <= 0 -> error ("BLE socket unreachable: " <> show err)
      | otherwise -> do
          logLine ("[relay-rook] BLE socket not ready, retrying… (" <> show triesLeft <> ")")
          threadDelay 500_000
          connectWithRetry path (triesLeft - 1)

-- | Boot-time advisory check. Drift between the typed schema and the
-- live SQLite is logged but does not abort.
verifyAdvisory :: SQL.Connection -> IO ()
verifyAdvisory conn = do
  result <- runBeamSqlite conn (verifySchema migrationBackend relayRookCheckedDb)
  case result of
    VerificationSucceeded -> pure ()
    VerificationFailed missing -> do
      logLine "[relay-rook] schema verification reports drift (advisory):"
      mapM_ (\p -> logLine ("  - " <> show p)) missing
