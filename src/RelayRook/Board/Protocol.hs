-- | Chessnut Move BLE protocol — UUIDs, magic bytes, type tags.
--
-- Reverse-engineered values, ported verbatim from
-- @openchessnutmove/chessnut_move_stack/driver/protocol.py@. The Rust
-- daemon hard-codes the UUIDs too; if these drift, both crates need
-- updating.
{-# LANGUAGE OverloadedStrings #-}

module RelayRook.Board.Protocol
  ( -- * Lengths
    boardStateLength
  , setMoveBoardLength
  , ledCommandLength
    -- * Init / config payloads
  , initCommand
  , configCommand
    -- * Type tags
  , messageBoardState
  , messageBatteryLevel
  , messageCommandResponse
  , commandConfig
  , commandBuzzerEnable
  , commandKeepalive
  , commandControl
  , commandSync
  , commandLed
  , subFirmwareVersion
  , subPowerLevel
  , subMovePieceState
    -- * Pieces
  , PieceValue (..)
  , pieceCharToValue
  , valueToPieceChar
  ) where

import Data.ByteString (ByteString)
import qualified Data.ByteString as BS
import Data.Word (Word8)

-- ---------------------------------------------------------------------
-- Lengths (matching protocol.py)
-- ---------------------------------------------------------------------

boardStateLength, setMoveBoardLength, ledCommandLength :: Int
boardStateLength   = 38
setMoveBoardLength = 35
ledCommandLength   = 34

-- ---------------------------------------------------------------------
-- Init / config payloads sent on connect
-- ---------------------------------------------------------------------

initCommand, configCommand :: ByteString
initCommand   = BS.pack [0x21, 0x01, 0x00]
configCommand = BS.pack [0x0B, 0x04, 0x03, 0xE8, 0x00, 0xC8]

-- ---------------------------------------------------------------------
-- Message / command tags
-- ---------------------------------------------------------------------

messageBoardState, messageBatteryLevel, messageCommandResponse :: Word8
messageBoardState      = 0x01
messageBatteryLevel    = 0x2A
messageCommandResponse = 0x41

commandConfig, commandBuzzerEnable, commandKeepalive,
  commandControl, commandSync, commandLed :: Word8
commandConfig       = 0x0B
commandBuzzerEnable = 0x1B
commandKeepalive    = 0x21
commandControl      = 0x41
commandSync         = 0x42
commandLed          = 0x43

subFirmwareVersion, subPowerLevel, subMovePieceState :: Word8
subFirmwareVersion = 0x09
subPowerLevel      = 0x0C
subMovePieceState  = 0x0B

-- ---------------------------------------------------------------------
-- Piece nibble values
-- ---------------------------------------------------------------------

-- | Wire nibble values for each piece. Empty squares are 0.
data PieceValue
  = Empty
  | BlackQueen
  | BlackKing
  | BlackBishop
  | BlackPawn
  | BlackKnight
  | WhiteRook
  | WhitePawn
  | BlackRook
  | WhiteBishop
  | WhiteKnight
  | WhiteQueen
  | WhiteKing
  deriving (Eq, Show, Bounded, Enum)

-- | Pieces use the standard FEN letters; lowercase = black, uppercase
-- = white. Empty squares come in as ' '.
pieceCharToValue :: Char -> PieceValue
pieceCharToValue c = case c of
  ' ' -> Empty
  'q' -> BlackQueen
  'k' -> BlackKing
  'b' -> BlackBishop
  'p' -> BlackPawn
  'n' -> BlackKnight
  'R' -> WhiteRook
  'P' -> WhitePawn
  'r' -> BlackRook
  'B' -> WhiteBishop
  'N' -> WhiteKnight
  'Q' -> WhiteQueen
  'K' -> WhiteKing
  _   -> Empty

valueToPieceChar :: Word8 -> Char
valueToPieceChar v = case v of
  0  -> ' '
  1  -> 'q'
  2  -> 'k'
  3  -> 'b'
  4  -> 'p'
  5  -> 'n'
  6  -> 'R'
  7  -> 'P'
  8  -> 'r'
  9  -> 'B'
  10 -> 'N'
  11 -> 'Q'
  12 -> 'K'
  _  -> ' '
