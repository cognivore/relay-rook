-- | Concrete interpreters — the only place in the package that does I/O.
--
-- - 'BleBoard': talks newline-JSON to the @relay-rook-ble@ Rust daemon
--   over a Unix socket. Encoding/decoding of Chessnut bytes lives in
--   "RelayRook.Board.Codec" so we keep one type-checked codec instead
--   of two.
-- - 'SqliteStore': beam-sqlite + a few raw upserts.
-- - 'SystemClock': wall-clock UTC.
--
-- Orientation is applied here, at the BLE boundary, and nowhere else:
-- the rest of the system (HTTP, event log, snapshot, rollback
-- detection) reasons in logical FENs exactly as Chessable shows them.
-- When the player sits on the black side the position is rotated 180°
-- on the way out and rotated back on the way in, so a physical board
-- with a fixed a1 corner presents black at the near edge.
{-# LANGUAGE DerivingStrategies #-}
{-# LANGUAGE FlexibleInstances #-}
{-# LANGUAGE GeneralizedNewtypeDeriving #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

module RelayRook.Adapters
  ( Env (..)
  , AppM
  , runAppM
  , mkEnv
  , spawnBleListener
  , logLine
  ) where

import Control.Concurrent (forkIO)
import Control.Concurrent.MVar (MVar, withMVar)
import Control.Exception (SomeException, try)
import Control.Monad (void)
import Control.Monad.IO.Class (MonadIO, liftIO)
import System.Exit (ExitCode (ExitFailure))
import System.IO (hFlush, stdout)
import System.Posix.Process (exitImmediately)
import Control.Monad.Reader (MonadReader, ReaderT, asks, runReaderT)
import Data.Aeson (decodeStrict, encode)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Base16 as B16
import qualified Data.ByteString.Base64 as B64
import qualified Data.ByteString.Char8 as BC
import qualified Data.ByteString.Lazy as LBS
import Data.IORef (IORef, readIORef, writeIORef)
import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Text.Encoding as TE
import Data.Time (NominalDiffTime, UTCTime, diffUTCTime, getCurrentTime)
import Data.Time.Format.ISO8601 (iso8601ParseM, iso8601Show)
import Database.Beam
  ( Identity
  , all_
  , default_
  , desc_
  , filter_
  , insert
  , insertExpressions
  , limit_
  , orderBy_
  , runInsert
  , runSelectReturningList
  , select
  , val_
  , (==.)
  )
import Database.Beam.Sqlite (runBeamSqlite)
import qualified Database.SQLite.Simple as SQL
import Database.SQLite.Simple (Connection)
import Network.Socket (Socket, close)
import qualified Network.Socket.ByteString as SBS

import qualified Data.Aeson as Aeson
import Data.Aeson.Types (parseEither, withObject, (.:))
import RelayRook.Board.Codec (decodeBoardFen, encodeSync, rotatePlacement)
import qualified RelayRook.Board.Wire as Wire
import RelayRook.Board.Wire (Op (..))
import RelayRook.Core
  ( Event (..)
  , Fen
  , Orientation (..)
  , Snapshot (..)
  , eventKindText
  , fenPlacement
  , fenValue
  , orientationText
  , parseFen
  , parseOrientation
  )
import RelayRook.Effects (MonadBoard (..), MonadClock (..), MonadStore (..))
import RelayRook.Schema
  ( EventT (..)
  , RelayRookDb (..)
  , SnapshotT (..)
  , relayRookDb
  )

-- ---------------------------------------------------------------------
-- Logging
-- ---------------------------------------------------------------------

-- | One timestamped line on stdout, flushed immediately. Under launchd
-- stdout is a file, which GHC block-buffers by default — without the
-- flush the log would only advance every few KiB (or at exit), which
-- is exactly the "log stopped weeks ago while the service is running"
-- symptom we had.
logLine :: MonadIO m => String -> m ()
logLine msg = liftIO $ do
  now <- getCurrentTime
  putStrLn (iso8601Show now <> " " <> msg)
  hFlush stdout

-- ---------------------------------------------------------------------
-- Env / AppM
-- ---------------------------------------------------------------------

data Env = Env
  { envDbConn :: Connection
  , envBleSocket :: Socket
  , envBleWriteLock :: MVar ()
  , envLatestFen :: IORef (Maybe (Fen, UTCTime))
    -- ^ Logical FEN (already rotated back if the board faces black), with
    -- the moment it arrived. The timestamp is what stops us handing out a
    -- position from a board that is no longer there.
  , envOrientation :: IORef Orientation
    -- ^ Which side of the physical board the player sits on. Owned by
    -- 'setBoardOrientation'; consulted by every encode and decode.
  }

newtype AppM a = AppM {unAppM :: ReaderT Env IO a}
  deriving newtype
    ( Functor
    , Applicative
    , Monad
    , MonadIO
    , MonadReader Env
    )

runAppM :: Env -> AppM a -> IO a
runAppM env (AppM m) = runReaderT m env

mkEnv :: Connection -> Socket -> MVar () -> IORef (Maybe (Fen, UTCTime)) -> IORef Orientation -> Env
mkEnv = Env

-- | How long the board may say nothing before we stop believing the last
-- position it gave us. It streams its state about twice a second, so this is
-- a very long silence. Going quiet is not hypothetical: btleplug can lose its
-- CoreBluetooth event loop and leave the daemon holding a peripheral that
-- answers nothing, and without this the bridge serves that stale position to
-- the extension forever, which then plays moves against a board that is not
-- in front of anyone.
boardSilenceLimit :: NominalDiffTime
boardSilenceLimit = 15

-- | Logical placement -> what the device must physically show.
toPhysical :: Orientation -> Text -> Text
toPhysical White = id
toPhysical Black = rotatePlacement

-- | What the device physically shows -> logical placement. Rotation is
-- an involution, so this is the same function; named separately so
-- call sites read correctly.
toLogical :: Orientation -> Text -> Text
toLogical = toPhysical

-- ---------------------------------------------------------------------
-- BLE setup helpers (called from Main, not from MonadBoard)
-- ---------------------------------------------------------------------

-- | Spawn the background reader: line-buffered JSON from the Rust
-- daemon. FEN notifications populate 'envLatestFen'; everything else is
-- traced to stdout. The daemon runs its own auto-connect loop, so we
-- don't need to send 'OpConnect' from here.
--
-- If the daemon socket dies, we exit the whole process: the
-- home-manager unit has @KeepAlive = true@ and the bridge's startup
-- already retries the socket connect, so launchd will bring us back
-- up once the daemon is healthy again.
spawnBleListener :: Env -> IO ()
spawnBleListener env = void . forkIO $ go
  where
    go = do
      e <- try @SomeException (recvLine (envBleSocket env))
      case e of
        Left err -> die ("socket read failed: " <> show err)
        Right Nothing -> die "daemon closed the socket"
        Right (Just line) -> handleLine env line >> go

    die reason = do
      logLine ("[ble] " <> reason <> "; exiting (launchd will restart)")
      _ <- try @SomeException (close (envBleSocket env))
      exitImmediately (ExitFailure 1)

handleLine :: Env -> BS.ByteString -> IO ()
handleLine env line = case decodeStrict line :: Maybe Wire.Event of
  Nothing -> logLine ("[ble] could not decode: " <> show line)
  Just (Wire.EvNotification "fen" b64) ->
    case B64.decode (TE.encodeUtf8 b64) of
      Right bytes -> case decodeBoardFen bytes of
        Just physical -> do
          orientation <- readIORef (envOrientation env)
          let logical = toLogical orientation physical
          case parseFen logical of
            Right fen -> do
              previous <- readIORef (envLatestFen env)
              now <- getCurrentTime
              writeIORef (envLatestFen env) (Just (fen, now))
              -- The device streams its state twice a second; only a
              -- change is worth a line.
              if fmap fst previous /= Just fen
                then
                  logLine
                    ( "[board] physical position changed:"
                        <> " orientation=" <> T.unpack (orientationText orientation)
                        <> " device=" <> T.unpack physical
                        <> " logical=" <> T.unpack logical
                    )
                else pure ()
            Left e ->
              logLine
                ( "[ble] bad placement after decode: " <> e
                    <> " (device=" <> T.unpack physical <> ")"
                )
        Nothing ->
          logLine ("[ble] FEN notification did not decode: " <> hex bytes)
      Left e -> logLine ("[ble] bad base64 on FEN: " <> show e)
  Just (Wire.EvNotification other b64) ->
    logLine ("[ble] notification " <> T.unpack other <> ": " <> hexB64 b64)
  Just (Wire.EvConnected addr name) ->
    logLine ("[ble] connected: " <> T.unpack addr <> maybe "" ((" — " <>) . T.unpack) name)
  Just Wire.EvDisconnected -> do
    writeIORef (envLatestFen env) Nothing
    logLine "[ble] disconnected"
  Just (Wire.EvError msg) -> logLine ("[ble] error: " <> T.unpack msg)
  Just Wire.EvAck -> pure ()
  Just ev -> logLine ("[ble] event: " <> show ev)

hex :: BS.ByteString -> String
hex = BC.unpack . B16.encode

hexB64 :: Text -> String
hexB64 b64 = either (const ("<bad base64: " <> T.unpack b64 <> ">")) hex (B64.decode (TE.encodeUtf8 b64))

sendOp :: Env -> Op -> IO ()
sendOp env op = withMVar (envBleWriteLock env) $ \_ -> do
  let line = encode op <> "\n"
  result <- try @SomeException (SBS.sendAll (envBleSocket env) (LBS.toStrict line))
  case result of
    Right () -> pure ()
    Left e -> logLine ("[ble] send failed: " <> show e)

-- | Read one line (terminated by '\n') from the socket. Returns
-- 'Nothing' on EOF.
recvLine :: Socket -> IO (Maybe BS.ByteString)
recvLine sock = go []
  where
    go acc = do
      chunk <- SBS.recv sock 4096
      if BS.null chunk
        then case acc of
          [] -> pure Nothing
          xs -> pure (Just (BS.concat (reverse xs)))
        else
          let combined = BS.concat (reverse (chunk : acc))
              (before, rest) = BS.break (== 0x0A) combined
           in if BS.null rest
                then go (chunk : acc)
                else
                  -- We may have read past a newline; anything after
                  -- belongs to the next message — but for v1 we accept
                  -- losing those bytes since the daemon writes one line
                  -- per send and the kernel buffer aligns with that.
                  pure (Just before)

-- ---------------------------------------------------------------------
-- MonadClock
-- ---------------------------------------------------------------------

instance MonadClock AppM where
  getNow = liftIO getCurrentTime

-- ---------------------------------------------------------------------
-- MonadStore (beam-sqlite + raw upsert)
-- ---------------------------------------------------------------------

instance MonadStore AppM where
  appendEvent ev = do
    conn <- asks envDbConn
    let kindText = eventKindText (eventKind ev)
        payloadText = TE.decodeUtf8 (LBS.toStrict (encode (eventPayload ev)))
        tsText = T.pack (iso8601Show (eventTs ev))
    liftIO . runBeamSqlite conn $
      runInsert $
        insert (_events relayRookDb) $
          insertExpressions
            [ EventRow
                { _eventId = default_
                , _eventTs = val_ tsText
                , _eventKind = val_ kindText
                , _eventPayload = val_ payloadText
                }
            ]

  recentAppliedFens limit = do
    conn <- asks envDbConn
    rows <- liftIO . runBeamSqlite conn $
      runSelectReturningList $
        select $
          limit_ (fromIntegral limit) $
            orderBy_ (desc_ . _eventId) $
              filter_ (\e -> _eventKind e ==. val_ "fen.applied") $
                all_ (_events relayRookDb)
    pure (concatMap rowToFen rows)
    where
      rowToFen :: EventT Identity -> [Fen]
      rowToFen r = case Aeson.decode (LBS.fromStrict (TE.encodeUtf8 (_eventPayload r))) of
        Just v -> case parseEither (withObject "p" (.: "fen")) v of
          Right (txt :: Text) -> case parseFen txt of
            Right fen -> [fen]
            Left _ -> []
          Left _ -> []
        Nothing -> []

  getSnapshot = do
    conn <- asks envDbConn
    row <- liftIO . runBeamSqlite conn $
      runSelectReturningList $
        select $
          filter_ (\s -> _snapKey s ==. val_ snapshotKey) $
            all_ (_snapshot relayRookDb)
    case row of
      [r] -> case decodeSnapshot r of
        Right snap -> pure snap
        Left err -> liftIO (fail ("snapshot decode: " <> err))
      _ -> liftIO initialSnapshot

  putSnapshot snap = do
    conn <- asks envDbConn
    let body =
          Aeson.object
            [ "fen" Aeson..= fenValue (snapshotFen snap)
            , "orientation" Aeson..= orientationText (snapshotOrientation snap)
            ]
        bodyText = TE.decodeUtf8 (LBS.toStrict (encode body))
        tsText = T.pack (iso8601Show (snapshotUpdatedAt snap))
    liftIO $
      SQL.execute
        conn
        "INSERT INTO snapshot (key, value, updated_at) VALUES (?, ?, ?) \
        \ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        (snapshotKey, bodyText, tsText)

snapshotKey :: Text
snapshotKey = "board"

initialSnapshot :: IO Snapshot
initialSnapshot = do
  now <- getCurrentTime
  case parseFen "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR" of
    Right fen -> pure (Snapshot fen White now)
    Left e -> error ("impossible: starting position FEN failed: " <> e)

decodeSnapshot :: SnapshotT Identity -> Either String Snapshot
decodeSnapshot row = do
  v <-
    maybe (Left "invalid JSON in snapshot") Right $
      Aeson.decode (LBS.fromStrict (TE.encodeUtf8 (_snapValue row)))
  (fenText :: Text, orientText :: Text) <-
    parseEither
      ( withObject "snapshot" $ \o -> do
          fenText <- o .: "fen"
          orientText <- o .: "orientation"
          pure (fenText, orientText)
      )
      v
  fen <- parseFen fenText
  orient <- parseOrientation orientText
  ts <- parseUtc (_snapUpdatedAt row)
  pure
    Snapshot
      { snapshotFen = fen
      , snapshotOrientation = orient
      , snapshotUpdatedAt = ts
      }

parseUtc :: Text -> Either String UTCTime
parseUtc t = case iso8601ParseM (T.unpack t) of
  Just u -> Right u
  Nothing -> Left ("bad ISO8601: " <> T.unpack t)

-- ---------------------------------------------------------------------
-- MonadBoard (BLE via Unix socket → Rust daemon)
-- ---------------------------------------------------------------------

instance MonadBoard AppM where
  setBoardFen fen force = do
    env <- asks id
    orientation <- liftIO (readIORef (envOrientation env))
    let logical = fenPlacement fen
        physical = toPhysical orientation logical
    case encodeSync physical force of
      Left err -> logLine ("[board] encodeSync failed: " <> err <> " (physical=" <> T.unpack physical <> ")")
      Right bytes -> do
        logLine
          ( "[board] sync:"
              <> " orientation=" <> T.unpack (orientationText orientation)
              <> " force=" <> show force
              <> " logical=" <> T.unpack logical
              <> " device=" <> T.unpack physical
              <> " bytes=" <> hex bytes
          )
        let b64 = TE.decodeUtf8 (B64.encode bytes)
        liftIO (sendOp env (OpWrite b64))

  getBoardFen = do
    ref <- asks envLatestFen
    current <- liftIO (readIORef ref)
    case current of
      Nothing -> pure Nothing
      Just (fen, seenAt) -> do
        now <- liftIO getCurrentTime
        if diffUTCTime now seenAt > boardSilenceLimit
          then do
            -- Clearing the ref also makes this log line fire once rather
            -- than on every poll.
            liftIO (writeIORef ref Nothing)
            logLine
              ( "[board] silent for over "
                  <> show boardSilenceLimit
                  <> "; the position is no longer trustworthy and will be reported as unknown"
              )
            pure Nothing
          else pure (Just fen)

  -- The device has no notion of perspective; we remember which way
  -- the player faces and rotate every position through that. The
  -- program re-pushes the current FEN right after this, so the board
  -- physically rearranges itself.
  setBoardOrientation orientation = do
    ref <- asks envOrientation
    previous <- liftIO (readIORef ref)
    liftIO (writeIORef ref orientation)
    logLine
      ( "[board] orientation "
          <> T.unpack (orientationText previous)
          <> " -> "
          <> T.unpack (orientationText orientation)
          <> (if previous == orientation then " (unchanged)" else " (board will be rearranged)")
      )
