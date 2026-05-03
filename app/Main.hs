-- | Entry: read env, run migrations, verify schema, connect to the
-- BLE daemon, serve.
{-# LANGUAGE NumericUnderscores #-}
{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Concurrent (threadDelay)
import Control.Concurrent.MVar (newMVar)
import Control.Exception (SomeException, try)
import Data.IORef (newIORef)
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
import qualified Web.Scotty as Scotty

import RelayRook.Adapters
  ( Env (..)
  , mkEnv
  , spawnBleListener
  )
import RelayRook.Migrate (runMigrations)
import RelayRook.Schema (relayRookCheckedDb)
import RelayRook.Server (server)

main :: IO ()
main = do
  dbPath <- envOr "RELAY_ROOK_DB" "relay.db"
  bleSock <- envOr "RELAY_ROOK_BLE_SOCKET" "/tmp/relay-rook-ble.sock"
  port <- read <$> envOr "RELAY_ROOK_PORT" "8674"
  migrationsDir <- envOr "RELAY_ROOK_MIGRATIONS" "migrations/relay_rook"

  conn <- SQL.open dbPath
  SQL.execute_ conn "PRAGMA journal_mode=WAL"
  SQL.execute_ conn "PRAGMA foreign_keys=ON"

  runMigrations conn "relay_rook" migrationsDir
  verifyAdvisory conn

  sock <- connectWithRetry bleSock 10
  writeLock <- newMVar ()
  latestFen <- newIORef Nothing
  let env = mkEnv conn sock writeLock latestFen

  -- The daemon owns the auto-connect loop; we just listen for events.
  spawnBleListener env

  putStrLn ("[relay-rook] serving on :" <> show port)
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
      putStrLn ("[relay-rook] connected to BLE daemon at " <> path)
      pure s
    Left err
      | triesLeft <= 0 -> error ("BLE socket unreachable: " <> show err)
      | otherwise -> do
          putStrLn ("[relay-rook] BLE socket not ready, retrying… (" <> show triesLeft <> ")")
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
      putStrLn "[relay-rook] schema verification reports drift (advisory):"
      mapM_ (\p -> putStrLn ("  - " <> show p)) missing

