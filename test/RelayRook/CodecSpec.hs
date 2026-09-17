{-# LANGUAGE OverloadedStrings #-}

module RelayRook.CodecSpec (spec) where

import qualified Data.ByteString as BS
import Data.Text (Text)

import RelayRook.Board.Codec (decodeBoardFen, encodeSync, rotatePlacement)
import Test.Hspec

start, startRotated, midgame, midgameRotated :: Text
start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
-- Ranks reversed *and* each rank mirrored: the white king lands on
-- the d-file side once you look from black's chair.
startRotated = "RNBKQBNR/PPPPPPPP/8/8/8/8/pppppppp/rnbkqbnr"
midgame = "r3r1k1/1p3ppp/p3p3/q2n3Q/1B6/1P2PP2/P3N1PP/K1R4R"
midgameRotated = "R4R1K/PP1N3P/2PP2P1/6B1/Q3n2q/3p3p/ppp3p1/1k1r3r"

spec :: Spec
spec = do
  describe "rotatePlacement" $ do
    it "rotates the starting position 180°" $
      rotatePlacement start `shouldBe` startRotated

    it "rotates an asymmetric middlegame" $
      rotatePlacement midgame `shouldBe` midgameRotated

    it "is an involution" $ do
      rotatePlacement (rotatePlacement start) `shouldBe` start
      rotatePlacement (rotatePlacement midgame) `shouldBe` midgame

    it "leaves an empty board alone" $
      rotatePlacement "8/8/8/8/8/8/8/8" `shouldBe` "8/8/8/8/8/8/8/8"

  describe "encodeSync" $ do
    it "puts the rank-8 row first and a1 in the low nibble of the last byte of its row" $ do
      -- Only a white king on a1: row 7 (rank 1), col 0. byteIdx = 7*4 + (3-0) + 2 = 33, high nibble.
      let Right bytes = encodeSync "8/8/8/8/8/8/8/K7" True
      BS.length bytes `shouldBe` 35
      BS.index bytes 0 `shouldBe` 0x42
      BS.index bytes 33 `shouldBe` 0xC0
      BS.index bytes 34 `shouldBe` 0

    it "rotated input lands the same piece on the far corner" $ do
      -- Rotated: king on h8 → row 0 col 7. byteIdx = 0*4 + (3-3) + 2 = 2, low nibble.
      let Right bytes = encodeSync (rotatePlacement "8/8/8/8/8/8/8/K7") True
      BS.index bytes 2 `shouldBe` 0x0C
      BS.index bytes 33 `shouldBe` 0

  describe "decodeBoardFen" $ do
    it "rejects a short or mistagged frame" $ do
      decodeBoardFen (BS.replicate 10 0) `shouldBe` Nothing
      decodeBoardFen (BS.pack (0x02 : 0x24 : replicate 36 0)) `shouldBe` Nothing

    it "decodes an empty board" $
      decodeBoardFen (BS.pack (0x01 : 0x24 : replicate 36 0))
        `shouldBe` Just "8/8/8/8/8/8/8/8"
