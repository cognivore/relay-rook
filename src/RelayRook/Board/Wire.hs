-- | Newline-delimited JSON wire types for the Unix socket between
-- relay-rook (Haskell) and relay-rook-ble (Rust).
--
-- The Rust daemon defines these too in @ble/src/wire.rs@; the two
-- definitions must stay in sync (they are small enough that a typo will
-- show up immediately as a JSON decode error on either side).
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module RelayRook.Board.Wire
  ( Op (..)
  , Event (..)
  , DeviceInfo (..)
  ) where

import Data.Aeson
  ( FromJSON (..)
  , ToJSON (..)
  , object
  , withObject
  , (.:)
  , (.:?)
  , (.=)
  )
import Data.Text (Text)

-- | Commands we send to the daemon.
data Op
  = OpConnect (Maybe Text)
  | OpDisconnect
  | OpWrite Text -- ^ base64-encoded bytes
  | OpLatestFen
  | OpStatus
  | OpScan Int -- ^ timeout in milliseconds
  deriving (Show)

instance ToJSON Op where
  toJSON = \case
    OpConnect addr -> object ["op" .= ("connect" :: Text), "address" .= addr]
    OpDisconnect -> object ["op" .= ("disconnect" :: Text)]
    OpWrite b64 -> object ["op" .= ("write" :: Text), "data" .= b64]
    OpLatestFen -> object ["op" .= ("latest_fen" :: Text)]
    OpStatus -> object ["op" .= ("status" :: Text)]
    OpScan ms -> object ["op" .= ("scan" :: Text), "timeout_ms" .= ms]

-- | Events the daemon pushes — replies and async notifications mixed.
-- Positional payloads (rather than records) so partial-field-selector
-- warnings don't fire.
data Event
  = EvConnected Text (Maybe Text)
    -- ^ address, name
  | EvDisconnected
  | EvNotification Text Text
    -- ^ characteristic ("fen"|"cmd"), base64 data
  | EvLatestFen (Maybe Text)
  | EvStatus Bool (Maybe Text)
    -- ^ connected, address
  | EvScanResult [DeviceInfo]
  | EvAck
  | EvError Text
  deriving (Show)

instance FromJSON Event where
  parseJSON = withObject "Event" $ \o -> do
    tag :: Text <- o .: "event"
    case tag of
      "connected" -> EvConnected <$> o .: "address" <*> o .:? "name"
      "disconnected" -> pure EvDisconnected
      "notification" ->
        EvNotification
          <$> o .: "characteristic"
          <*> o .: "data"
      "latest_fen" -> EvLatestFen <$> o .:? "data"
      "status" -> EvStatus <$> o .: "connected" <*> o .:? "address"
      "scan_result" -> EvScanResult <$> o .: "devices"
      "ack" -> pure EvAck
      "error" -> EvError <$> o .: "message"
      other -> fail ("unknown event tag: " <> show other)

data DeviceInfo = DeviceInfo
  { deviceAddress :: Text
  , deviceName :: Maybe Text
  }
  deriving (Show)

instance FromJSON DeviceInfo where
  parseJSON = withObject "DeviceInfo" $ \o ->
    DeviceInfo <$> o .: "address" <*> o .:? "name"
