-- | Pure encoders / decoders for the Chessnut Move binary protocol.
--
-- Faithful port of @codec.py@ from openchessnutmove. The host-to-device
-- SYNC command and the device-to-host board-state notification use
-- /different/ nibble layouts within the same 32-byte payload — that is
-- intentional, not a port mistake. The asymmetry was reverse-engineered
-- from a real device.
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module RelayRook.Board.Codec
  ( -- * Encoders
    encodeSync
  , encodeBuzzerEnable
  , encodeBuzzerBeep
  , encodeGetPowerLevel
  , encodeGetFirmwareVersion
  , encodeGetMovePieceState
  , encodeClearLeds
    -- * Decoders
  , decodeBoardFen
    -- * Internals (exposed for tests)
  , fenPlacementToBoard
  ) where

import Data.Bits (shiftL, shiftR, (.&.), (.|.))
import Data.ByteString (ByteString)
import qualified Data.ByteString as BS
import Data.Char (isDigit)
import qualified Data.Text as T
import Data.Text (Text)
import Data.Word (Word8)

import RelayRook.Board.Protocol
  ( boardStateLength
  , commandBuzzerEnable
  , commandControl
  , commandLed
  , commandSync
  , configCommand
  , messageBoardState
  , pieceCharToValue
  , setMoveBoardLength
  , subFirmwareVersion
  , subMovePieceState
  , subPowerLevel
  , valueToPieceChar
  )

-- ---------------------------------------------------------------------
-- FEN placement -> 8x8 board (row 0 = rank 8, col 0 = a-file)
-- ---------------------------------------------------------------------

-- | Decode a FEN /placement/ (board-only, no side-to-move etc.) into
-- the row-major 8×8 grid the codec expects.
fenPlacementToBoard :: Text -> Either String [[Char]]
fenPlacementToBoard placement =
  let ranks = T.splitOn "/" placement
   in if length ranks /= 8
        then Left ("FEN placement must have 8 ranks; got " <> show (length ranks))
        else mapM rankToRow ranks
  where
    rankToRow :: Text -> Either String [Char]
    rankToRow rank =
      let go acc [] = Right (reverse acc)
          go acc (c : cs)
            | isDigit c =
                let n = fromEnum c - fromEnum '0'
                 in go (replicate n ' ' <> acc) cs
            | c `elem` ("rnbqkpRNBQKP" :: String) = go (c : acc) cs
            | otherwise = Left ("invalid character in rank: " <> [c])
          row = go [] (T.unpack rank)
       in case row of
            Left e -> Left e
            Right cs ->
              if length cs /= 8
                then Left ("rank " <> T.unpack rank <> " does not sum to 8")
                else Right cs

-- ---------------------------------------------------------------------
-- Encoders
-- ---------------------------------------------------------------------

-- | SYNC (0x42) — push a target position to the board.
--
-- @force = True@ tells the device to /demand/ pieces move there
-- regardless of current physical state; @False@ defers to user actions.
-- (The wire flag is inverted: 0 = force, 1 = soft, ported as-is.)
encodeSync :: Text -> Bool -> Either String ByteString
encodeSync placement force = do
  board <- fenPlacementToBoard placement
  let initial = BS.replicate setMoveBoardLength 0
      header  = updateAt 0 commandSync initial
      withLen = updateAt 1 0x21 header
      filled  = foldl encodeRow withLen [0 .. 7 :: Int]
      encodeRow buf row =
        foldl
          ( \b colPair ->
              let col       = colPair * 2
                  left      = pieceNibble (board !! row !! col)
                  right     = pieceNibble (board !! row !! (col + 1))
                  byteIdx   = row * 4 + (3 - colPair) + 2
                  byteValue = (left `shiftL` 4) .|. right
               in updateAt byteIdx byteValue b
          )
          buf
          [0 .. 3 :: Int]
      forceFlag = if force then 0 else 1
      finished  = updateAt 34 forceFlag filled
  pure finished

-- | Enable / disable the buzzer.
encodeBuzzerEnable :: Bool -> ByteString
encodeBuzzerEnable enable =
  BS.pack [commandBuzzerEnable, 0x01, if enable then 0x01 else 0x00]

-- | Trigger a one-shot buzzer beep — same payload the official app
-- sends as part of CONFIG.
encodeBuzzerBeep :: ByteString
encodeBuzzerBeep = configCommand

encodeGetPowerLevel, encodeGetFirmwareVersion, encodeGetMovePieceState :: ByteString
encodeGetPowerLevel       = BS.pack [commandControl, 0x01, subPowerLevel]
encodeGetFirmwareVersion  = BS.pack [commandControl, 0x01, subFirmwareVersion]
encodeGetMovePieceState   = BS.pack [commandControl, 0x01, subMovePieceState]

-- | Clear all LEDs.
encodeClearLeds :: ByteString
encodeClearLeds = BS.pack ([commandLed, 0x20] <> replicate 32 0)

-- ---------------------------------------------------------------------
-- Decoders
-- ---------------------------------------------------------------------

-- | Decode a board-state notification (0x01 message, 38 bytes) into
-- a FEN /placement/ string ("rnbqkbnr/...") — full FEN is reconstructed
-- by callers because side-to-move etc. are not on the wire.
decodeBoardFen :: ByteString -> Maybe Text
decodeBoardFen bytes
  | BS.length bytes < boardStateLength = Nothing
  | BS.index bytes 0 /= messageBoardState = Nothing
  | BS.index bytes 1 /= 0x24 = Nothing
  | otherwise = Just (T.intercalate "/" (map decodeRank [0 .. 7 :: Int]))
  where
    decodeRank :: Int -> Text
    decodeRank row =
      let cells = map (cellChar row) [7, 6 .. 0 :: Int]
       in compress cells

    cellChar :: Int -> Int -> Char
    cellChar row col =
      let nibbleOff = row * 8 + col
          byteIdx   = nibbleOff `div` 2 + 2
          byteVal   = BS.index bytes byteIdx
          nib =
            if even col
              then byteVal .&. 0x0F
              else (byteVal `shiftR` 4) .&. 0x0F
       in valueToPieceChar nib

    compress :: [Char] -> Text
    compress = T.pack . go (0 :: Int)
      where
        go n [] = if n > 0 then show n else ""
        go n (c : cs)
          | c == ' ' = go (n + 1) cs
          | n > 0 = show n <> (c : go 0 cs)
          | otherwise = c : go 0 cs

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

pieceNibble :: Char -> Word8
pieceNibble c = fromIntegral (fromEnum (pieceCharToValue c))

-- | Update one byte in a ByteString at a given index. O(n) — fine for
-- our 35-byte buffers.
updateAt :: Int -> Word8 -> ByteString -> ByteString
updateAt i v bs =
  let (front, back) = BS.splitAt i bs
   in front <> BS.singleton v <> BS.drop 1 back

