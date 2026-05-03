-- | Pure programs. Constrained polymorphic over the ports defined in
-- "RelayRook.Effects". No @MonadIO@. No transitive @IO@ exposure.
--
-- These functions describe /what/ should happen; interpreters in
-- "RelayRook.Adapters" decide /how/.
{-# LANGUAGE FlexibleContexts #-}
{-# LANGUAGE OverloadedStrings #-}

module RelayRook.Program
  ( SyncResult (..)
  , rollbackWindow
  , syncBoardFen
  , syncBoardOrientation
  , observePhysicalBoard
  ) where

import Control.Monad (when)
import Data.Aeson (object, (.=))
import RelayRook.Core
  ( Event (..)
  , EventKind (..)
  , Fen
  , Orientation
  , Snapshot (..)
  , fenValue
  , orientationText
  )
import RelayRook.Effects (MonadBoard (..), MonadClock (..), MonadStore (..))

-- | How far back we look in the event log when classifying a new
-- request as a rollback.
rollbackWindow :: Int
rollbackWindow = 32

data SyncResult = SyncResult
  { syncFen :: Fen
  , syncRollback :: Bool
  , syncSnapshot :: Snapshot
  }

-- | Apply a desired FEN: detect rollback, push to the board, record
-- events, update the snapshot. Returns whether this request was a
-- rollback (a re-occurrence of an earlier applied FEN that is not the
-- most recent one).
syncBoardFen
  :: (MonadBoard m, MonadStore m, MonadClock m)
  => Fen
  -> Bool
  -> m SyncResult
syncBoardFen fen force = do
  now <- getNow
  recent <- recentAppliedFens rollbackWindow
  let rollback = case recent of
        [] -> False
        (mostRecent : _) -> fen /= mostRecent && fen `elem` recent
  appendEvent
    (Event FenRequested (object ["fen" .= fenValue fen, "force" .= force]) now)
  setBoardFen fen force
  prev <- getSnapshot
  let snap =
        Snapshot
          { snapshotFen = fen
          , snapshotOrientation = snapshotOrientation prev
          , snapshotUpdatedAt = now
          }
  putSnapshot snap
  appendEvent (Event FenApplied (object ["fen" .= fenValue fen]) now)
  when rollback $
    appendEvent (Event RollbackDetected (object ["fen" .= fenValue fen]) now)
  pure SyncResult {syncFen = fen, syncRollback = rollback, syncSnapshot = snap}

-- | Forward an orientation change to the board and record it.
syncBoardOrientation
  :: (MonadBoard m, MonadStore m, MonadClock m)
  => Orientation
  -> m Snapshot
syncBoardOrientation orientation = do
  now <- getNow
  setBoardOrientation orientation
  prev <- getSnapshot
  let snap =
        Snapshot
          { snapshotFen = snapshotFen prev
          , snapshotOrientation = orientation
          , snapshotUpdatedAt = now
          }
  putSnapshot snap
  appendEvent
    ( Event
        OrientationSet
        (object ["orientation" .= orientationText orientation])
        now
    )
  pure snap

-- | Read the physical board, append an event if a FEN is available.
observePhysicalBoard
  :: (MonadBoard m, MonadStore m, MonadClock m)
  => m (Maybe Fen)
observePhysicalBoard = do
  mfen <- getBoardFen
  case mfen of
    Nothing -> pure Nothing
    Just fen -> do
      now <- getNow
      appendEvent (Event PhysicalObserved (object ["fen" .= fenValue fen]) now)
      pure (Just fen)
