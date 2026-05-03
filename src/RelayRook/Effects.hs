-- | The ports. Programs in "RelayRook.Program" are constrained over
-- these classes — never over @MonadIO@ — so a developer literally cannot
-- inline a 'System.Process.callCommand' or 'Network.HTTP.Client.httpLbs'
-- in pure code: those calls require @MonadIO@, which is not granted here.
--
-- That is the bulletproofness that compelled the Haskell choice over
-- Rust: orim-style GAT traits stop most mistakes; mtl constraints stop
-- all of them at typecheck.
{-# LANGUAGE FlexibleContexts #-}

module RelayRook.Effects
  ( MonadBoard (..)
  , MonadStore (..)
  , MonadClock (..)
  ) where

import Data.Time (UTCTime)
import RelayRook.Core (Event, Fen, Orientation, Snapshot)

-- | Talks to the robotic chess board (in production, via HTTP to
-- openchessnutmove; in tests, via a fake).
class Monad m => MonadBoard m where
  setBoardFen :: Fen -> Bool -> m ()
  getBoardFen :: m (Maybe Fen)
  setBoardOrientation :: Orientation -> m ()

-- | Append-only event log + per-key snapshot persistence.
class Monad m => MonadStore m where
  appendEvent :: Event -> m ()
  recentAppliedFens :: Int -> m [Fen]
  getSnapshot :: m Snapshot
  putSnapshot :: Snapshot -> m ()

-- | Wall clock.
class Monad m => MonadClock m where
  getNow :: m UTCTime
