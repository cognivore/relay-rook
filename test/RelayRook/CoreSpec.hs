{-# LANGUAGE OverloadedStrings #-}

module RelayRook.CoreSpec (spec) where

import RelayRook.Core
  ( Orientation (..)
  , fenValue
  , parseFen
  , parseOrientation
  )
import Test.Hspec

spec :: Spec
spec = do
  describe "parseFen" $ do
    it "fills missing fields from placement-only" $
      fmap fenValue (parseFen "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")
        `shouldBe` Right "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    it "preserves a full FEN as-is" $ do
      let full = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"
      fmap fenValue (parseFen full) `shouldBe` Right full

    it "rejects ranks that do not sum to 8" $
      parseFen "rnbqkbnr/9/8/8/8/8/PPPPPPPP/RNBQKBNR" `shouldSatisfy` isLeft

    it "rejects empty input" $
      parseFen "" `shouldSatisfy` isLeft

    it "rejects fewer than 8 ranks" $
      parseFen "rnbqkbnr/8/8/8/8/8/8" `shouldSatisfy` isLeft

  describe "parseOrientation" $ do
    it "parses lowercase white/black" $ do
      parseOrientation "white" `shouldBe` Right White
      parseOrientation "black" `shouldBe` Right Black

    it "is case-insensitive" $
      parseOrientation "BLACK" `shouldBe` Right Black

    it "rejects junk" $
      parseOrientation "sideways" `shouldSatisfy` isLeft

isLeft :: Either a b -> Bool
isLeft (Left _) = True
isLeft _ = False
