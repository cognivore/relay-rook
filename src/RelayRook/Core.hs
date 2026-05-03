-- | Validated value types for the bridge. Smart constructors are the
-- only entry points; raw 'Text' never crosses into the domain.
--
-- This module performs zero IO. All effects are described in
-- "RelayRook.Effects" and run by interpreters in "RelayRook.Adapters".
{-# LANGUAGE DeriveAnyClass #-}
{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE DerivingStrategies #-}
{-# LANGUAGE GeneralizedNewtypeDeriving #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module RelayRook.Core
  ( Fen
  , fenValue
  , fenPlacement
  , parseFen
  , Orientation (..)
  , parseOrientation
  , orientationText
  , EventKind (..)
  , eventKindText
  , parseEventKind
  , Event (..)
  , Snapshot (..)
  ) where

import Control.Monad (unless)
import Data.Aeson (FromJSON (..), ToJSON (..), Value, withText)
import Data.Char (digitToInt, isDigit)
import Data.Text (Text)
import qualified Data.Text as T
import Data.Time (UTCTime)
import GHC.Generics (Generic)

-- | A normalized full FEN. Construct via 'parseFen'.
newtype Fen = Fen {fenValue :: Text}
  deriving newtype (Eq, Ord, Show, ToJSON)

instance FromJSON Fen where
  parseJSON = withText "Fen" $ \t -> either fail pure (parseFen t)

-- | Board placement only (the part before the first space).
fenPlacement :: Fen -> Text
fenPlacement = T.takeWhile (/= ' ') . fenValue

-- | Parse and normalize a FEN. Accepts placement-only and fills missing
-- fields with @"w KQkq - 0 1"@ defaults; rejects malformed input.
parseFen :: Text -> Either String Fen
parseFen raw = case T.words (T.strip raw) of
  [] -> Left "empty FEN"
  parts@(placement : _) -> do
    validatePlacement placement
    let defaults = ["w", "KQkq", "-", "0", "1"]
        filled = parts <> drop (length parts - 1) defaults
    pure (Fen (T.unwords (take 6 filled)))

validatePlacement :: Text -> Either String ()
validatePlacement p = do
  let ranks = T.splitOn "/" p
  unless (length ranks == 8) $
    Left ("expected 8 ranks separated by '/', got " <> show (length ranks))
  mapM_ checkRank ranks

checkRank :: Text -> Either String ()
checkRank rank = do
  unless (T.all validChar rank) $
    Left ("invalid character in rank: " <> T.unpack rank)
  let total = T.foldr step 0 rank
  unless (total == 8) $
    Left ("rank " <> T.unpack rank <> " does not sum to 8 files (got " <> show total <> ")")
  where
    validChar c = c `elem` ("rnbqkpRNBQKP12345678" :: String)
    step c acc
      | isDigit c = digitToInt c + acc
      | otherwise = 1 + acc

-- | Board view perspective.
data Orientation = White | Black
  deriving stock (Eq, Show, Generic)

orientationText :: Orientation -> Text
orientationText White = "white"
orientationText Black = "black"

parseOrientation :: Text -> Either String Orientation
parseOrientation t = case T.toLower (T.strip t) of
  "white" -> Right White
  "black" -> Right Black
  other -> Left ("orientation must be 'white' or 'black', got " <> T.unpack other)

instance ToJSON Orientation where
  toJSON = toJSON . orientationText

instance FromJSON Orientation where
  parseJSON = withText "Orientation" $ \t -> either fail pure (parseOrientation t)

-- | Tagged event types written to the append-only log.
data EventKind
  = FenRequested
  | FenApplied
  | RollbackDetected
  | OrientationSet
  | PhysicalObserved
  deriving stock (Eq, Show, Generic)

eventKindText :: EventKind -> Text
eventKindText FenRequested = "fen.requested"
eventKindText FenApplied = "fen.applied"
eventKindText RollbackDetected = "rollback.detected"
eventKindText OrientationSet = "orientation.set"
eventKindText PhysicalObserved = "physical.fen.observed"

parseEventKind :: Text -> Either String EventKind
parseEventKind "fen.requested" = Right FenRequested
parseEventKind "fen.applied" = Right FenApplied
parseEventKind "rollback.detected" = Right RollbackDetected
parseEventKind "orientation.set" = Right OrientationSet
parseEventKind "physical.fen.observed" = Right PhysicalObserved
parseEventKind other = Left ("unknown event kind: " <> T.unpack other)

-- | An append-only log entry. 'eventPayload' is opaque JSON.
data Event = Event
  { eventKind :: EventKind
  , eventPayload :: Value
  , eventTs :: UTCTime
  }
  deriving stock (Eq, Show, Generic)

-- | The latest known board state.
data Snapshot = Snapshot
  { snapshotFen :: Fen
  , snapshotOrientation :: Orientation
  , snapshotUpdatedAt :: UTCTime
  }
  deriving stock (Eq, Show, Generic)

instance ToJSON Snapshot where
  toJSON s =
    toJSON
      ( fenValue (snapshotFen s)
      , orientationText (snapshotOrientation s)
      , snapshotUpdatedAt s
      )

