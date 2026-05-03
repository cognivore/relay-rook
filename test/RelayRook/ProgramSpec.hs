-- | Pure-program tests using a 'StateT'-based mock that implements the
-- ports without any IO. This file deliberately does not import
-- "RelayRook.Adapters" — and therefore drags in no @sqlite-simple@,
-- @http-client@, or 'IO' beyond hspec's own. If a constraint in
-- "RelayRook.Program" leaked an 'IO'-bearing class, this would fail to
-- compile.
{-# LANGUAGE DerivingStrategies #-}
{-# LANGUAGE FlexibleInstances #-}
{-# LANGUAGE GeneralizedNewtypeDeriving #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module RelayRook.ProgramSpec (spec) where

import Control.Monad.State.Strict (State, execState, gets, modify')
import Data.Aeson (Value)
import Data.Aeson.Types (Parser, parseEither, withObject, (.:))
import qualified Data.Text as T
import Data.Time (UTCTime (..), fromGregorian, secondsToDiffTime)

import RelayRook.Core
  ( Event (..)
  , EventKind (..)
  , Fen
  , Orientation (..)
  , Snapshot (..)
  , parseFen
  )
import RelayRook.Effects (MonadBoard (..), MonadClock (..), MonadStore (..))
import RelayRook.Program
  ( observePhysicalBoard
  , syncBoardFen
  , syncBoardOrientation
  )
import Test.Hspec

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------

unsafeFen :: T.Text -> Fen
unsafeFen t = case parseFen t of
  Right f -> f
  Left e -> error ("test fixture FEN failed: " <> e)

start, afterE4, afterE5 :: Fen
start = unsafeFen "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
afterE4 = unsafeFen "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
afterE5 = unsafeFen "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"

t0 :: UTCTime
t0 = UTCTime (fromGregorian 2026 1 1) (secondsToDiffTime 0)

-- ---------------------------------------------------------------------
-- Mock state and monad (no IO!)
-- ---------------------------------------------------------------------

data MockState = MockState
  { mockSetFens :: [(Fen, Bool)]
  , mockSetOrientations :: [Orientation]
  , mockPhysical :: Maybe Fen
  , mockEvents :: [Event]
  , mockApplied :: [Fen]
  , mockSnapshot :: Snapshot
  , mockNow :: UTCTime
  }

initialMock :: MockState
initialMock =
  MockState
    { mockSetFens = []
    , mockSetOrientations = []
    , mockPhysical = Nothing
    , mockEvents = []
    , mockApplied = []
    , mockSnapshot = Snapshot start White t0
    , mockNow = t0
    }

newtype Mock a = Mock {unMock :: State MockState a}
  deriving newtype (Functor, Applicative, Monad)

runMock :: Mock a -> MockState -> MockState
runMock m = execState (unMock m)

instance MonadClock Mock where
  getNow = Mock (gets mockNow)

instance MonadBoard Mock where
  setBoardFen fen force = Mock $ modify' $ \s ->
    s {mockSetFens = mockSetFens s <> [(fen, force)]}
  getBoardFen = Mock (gets mockPhysical)
  setBoardOrientation o = Mock $ modify' $ \s ->
    s {mockSetOrientations = mockSetOrientations s <> [o]}

instance MonadStore Mock where
  appendEvent ev = Mock $ modify' $ \s ->
    let applied' = case eventKind ev of
          FenApplied ->
            mockApplied s <> case extractFen (eventPayload ev) of
              Just f -> [f]
              Nothing -> []
          _ -> mockApplied s
     in s {mockEvents = mockEvents s <> [ev], mockApplied = applied'}
  recentAppliedFens limit = Mock $ do
    applied <- gets mockApplied
    pure (take limit (reverse applied))
  getSnapshot = Mock (gets mockSnapshot)
  putSnapshot snap = Mock (modify' (\s -> s {mockSnapshot = snap}))

extractFen :: Value -> Maybe Fen
extractFen v = case parseEither parser v of
  Right t -> case parseFen t of
    Right f -> Just f
    Left _ -> Nothing
  Left _ -> Nothing
  where
    parser :: Value -> Parser T.Text
    parser = withObject "p" (.: "fen")

-- ---------------------------------------------------------------------
-- Specs
-- ---------------------------------------------------------------------

spec :: Spec
spec = do
  describe "syncBoardFen" $ do
    it "pushes the FEN to the board and records two events" $ do
      let s = runMock (syncBoardFen afterE4 True >> pure ()) initialMock
      mockSetFens s `shouldBe` [(afterE4, True)]
      map eventKind (mockEvents s) `shouldBe` [FenRequested, FenApplied]
      snapshotFen (mockSnapshot s) `shouldBe` afterE4

    it "does not flag a rollback when the same FEN is repeated" $ do
      let s =
            runMock
              ( do
                  _ <- syncBoardFen afterE4 True
                  _ <- syncBoardFen afterE4 True
                  pure ()
              )
              initialMock
          rollbacks = filter ((== RollbackDetected) . eventKind) (mockEvents s)
      rollbacks `shouldBe` []

    it "detects rollback on navigate-back" $ do
      let prog = do
            _ <- syncBoardFen start True
            _ <- syncBoardFen afterE4 True
            _ <- syncBoardFen afterE5 True
            _ <- syncBoardFen start True
            pure ()
          s = runMock prog initialMock
          rollbacks = filter ((== RollbackDetected) . eventKind) (mockEvents s)
      length rollbacks `shouldBe` 1

    it "forwards the force flag to the board" $ do
      let s = runMock (syncBoardFen afterE4 False >> pure ()) initialMock
      mockSetFens s `shouldBe` [(afterE4, False)]

  describe "syncBoardOrientation" $ do
    it "updates snapshot and forwards to the board" $ do
      let s = runMock (syncBoardOrientation Black >> pure ()) initialMock
      mockSetOrientations s `shouldBe` [Black]
      snapshotOrientation (mockSnapshot s) `shouldBe` Black
      map eventKind (mockEvents s) `shouldBe` [OrientationSet]

  describe "observePhysicalBoard" $ do
    it "returns Nothing and emits no event when the board is silent" $ do
      let s = runMock (observePhysicalBoard >> pure ()) initialMock
      mockEvents s `shouldBe` []

    it "records an event when the board reports a FEN" $ do
      let s =
            runMock
              (observePhysicalBoard >> pure ())
              (initialMock {mockPhysical = Just afterE4})
      map eventKind (mockEvents s) `shouldBe` [PhysicalObserved]
