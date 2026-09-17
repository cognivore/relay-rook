-- | scotty wiring: routes 1:1 with programs in "RelayRook.Program".
--
-- Request bodies are parsed into validated value types ('Fen',
-- 'Orientation') before reaching pure code; programs run inside 'AppM'
-- by way of 'liftIO . runAppM'. Scotty's 'ActionM' stays at the I/O
-- boundary; programs never see it.
--
-- Every state-changing request is logged with what came in and what
-- went out. The 2 Hz physical-board poll is deliberately not logged
-- here; changes on that path are logged once, at decode time, in
-- "RelayRook.Adapters".
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module RelayRook.Server
  ( server
  ) where

import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Value, object, (.=), (.:), (.:?))
import Data.Aeson.Types (Parser, parseEither, withObject)
import qualified Data.Text as T
import qualified Data.Text.Lazy as TL
import Network.HTTP.Types.Status (status400)
import Web.Scotty (ScottyM, get, json, jsonData, post, status, text)

import RelayRook.Adapters (AppM, Env, logLine, runAppM)
import RelayRook.Core
  ( Fen
  , Orientation
  , Snapshot (..)
  , fenValue
  , orientationText
  , parseFen
  , parseOrientation
  )
import RelayRook.Effects (MonadStore (..))
import RelayRook.Program
  ( SyncResult (..)
  , observePhysicalBoard
  , syncBoardFen
  , syncBoardOrientation
  )

server :: Env -> ScottyM ()
server env = do
  get "/health" $
    json (object ["status" .= ("ok" :: TL.Text)])

  get "/api/board/state" $ do
    snap <- liftIO $ runAppM env (getSnapshot :: AppM Snapshot)
    json
      ( object
          [ "fen" .= fenValue (snapshotFen snap)
          , "orientation" .= orientationText (snapshotOrientation snap)
          , "updated_at" .= snapshotUpdatedAt snap
          ]
      )

  post "/api/board/fen" $ do
    body :: Value <- jsonData
    case parseEither parseFenReq body of
      Left err -> do
        logLine ("[http] POST /api/board/fen rejected: " <> err <> " body=" <> show body)
        status status400 *> text (TL.pack err)
      Right (fen, force) -> do
        logLine
          ( "[http] POST /api/board/fen fen=" <> T.unpack (fenValue fen)
              <> " force=" <> show force
          )
        result <- liftIO $ runAppM env (syncBoardFen fen force)
        logLine
          ( "[http] POST /api/board/fen -> rollback=" <> show (syncRollback result)
              <> " orientation=" <> T.unpack (orientationText (snapshotOrientation (syncSnapshot result)))
          )
        json
          ( object
              [ "fen" .= fenValue (syncFen result)
              , "rollback" .= syncRollback result
              ]
          )

  get "/api/board/fen" $ do
    mfen <- liftIO $ runAppM env observePhysicalBoard
    json (object ["fen" .= fmap fenValue mfen])

  post "/api/board/orientation" $ do
    body :: Value <- jsonData
    case parseEither parseOrientationReq body of
      Left err -> do
        logLine ("[http] POST /api/board/orientation rejected: " <> err <> " body=" <> show body)
        status status400 *> text (TL.pack err)
      Right o -> do
        logLine ("[http] POST /api/board/orientation orientation=" <> T.unpack (orientationText o))
        snap <- liftIO $ runAppM env (syncBoardOrientation o)
        logLine
          ( "[http] POST /api/board/orientation -> orientation="
              <> T.unpack (orientationText (snapshotOrientation snap))
              <> " fen=" <> T.unpack (fenValue (snapshotFen snap))
          )
        json (object ["orientation" .= orientationText (snapshotOrientation snap)])

parseFenReq :: Value -> Parser (Fen, Bool)
parseFenReq = withObject "FenRequest" $ \o -> do
  fenText <- o .: "fen"
  force <- maybe True id <$> (o .:? "force")
  case parseFen fenText of
    Right f -> pure (f, force)
    Left err -> fail err

parseOrientationReq :: Value -> Parser Orientation
parseOrientationReq = withObject "OrientationRequest" $ \o -> do
  txt <- o .: "orientation"
  case parseOrientation txt of
    Right ori -> pure ori
    Left err -> fail err
