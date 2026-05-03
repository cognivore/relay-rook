flake: { config, lib, pkgs, ... }:

let
  cfg = config.services.relay-rook;
  bridgePkg = flake.packages.${pkgs.stdenv.hostPlatform.system}.relay-rook;
  blePkg    = flake.packages.${pkgs.stdenv.hostPlatform.system}.relay-rook-ble;
  homeDir   = config.home.homeDirectory;

  defaultSocket = "${homeDir}/.local/state/relay-rook/ble.sock";

  bridgeEnv = {
    RELAY_ROOK_DB         = cfg.dbPath;
    RELAY_ROOK_BLE_SOCKET = cfg.bleSocket;
    RELAY_ROOK_HOST       = cfg.host;
    RELAY_ROOK_PORT       = toString cfg.port;
  };
  bleEnv = {
    RELAY_ROOK_BLE_SOCKET = cfg.bleSocket;
    RUST_LOG              = cfg.bleLogLevel;
  };

  envPairs = e: lib.mapAttrsToList (k: v: "${k}=${v}") e;
in
{
  options.services.relay-rook = {
    enable = lib.mkEnableOption "relay-rook chessable<>board bridge";

    bridgePackage = lib.mkOption {
      type = lib.types.package;
      default = bridgePkg;
      description = "Haskell relay-rook package.";
    };

    blePackage = lib.mkOption {
      type = lib.types.package;
      default = blePkg;
      description = "Rust relay-rook-ble package (BLE daemon).";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Bind address for the bridge HTTP server.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8674;
      description = "Bind port for the bridge HTTP server.";
    };

    dbPath = lib.mkOption {
      type = lib.types.str;
      default = "${homeDir}/.local/state/relay-rook/relay.db";
      description = ''
        SQLite database path. Designed to be shared with sibling
        microservices; the migration runner keys versions per-service in
        `_schema_versions`.
      '';
    };

    bleSocket = lib.mkOption {
      type = lib.types.str;
      default = defaultSocket;
      description = "Unix socket path that relay-rook-ble listens on.";
    };

    bleLogLevel = lib.mkOption {
      type = lib.types.str;
      default = "info";
      description = "RUST_LOG value for the BLE daemon (info, debug, ...).";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { RELAY_ROOK_LOG_LEVEL = "debug"; };
      description = "Extra environment variables to set on the bridge service.";
    };
  };

  config = lib.mkIf cfg.enable {
    # ---------- macOS launchd ----------
    launchd.agents.relay-rook-ble = {
      enable = true;
      config = {
        ProgramArguments = [ "${cfg.blePackage}/bin/relay-rook-ble" ];
        EnvironmentVariables = bleEnv // { HOME = homeDir; };
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = "${homeDir}/Library/Logs/relay-rook-ble.log";
        StandardErrorPath = "${homeDir}/Library/Logs/relay-rook-ble.log";
      };
    };

    launchd.agents.relay-rook = {
      enable = true;
      config = {
        ProgramArguments = [ "${cfg.bridgePackage}/bin/relay-rook" ];
        EnvironmentVariables = bridgeEnv // cfg.extraEnvironment // { HOME = homeDir; };
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = "${homeDir}/Library/Logs/relay-rook.log";
        StandardErrorPath = "${homeDir}/Library/Logs/relay-rook.log";
      };
    };

    # ---------- Linux systemd (user units) ----------
    systemd.user.services.relay-rook-ble = {
      Unit = {
        Description = "relay-rook BLE daemon (Chessnut Move)";
        After = [ "default.target" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.blePackage}/bin/relay-rook-ble";
        Environment = envPairs bleEnv;
        Restart = "on-failure";
        RestartSec = "3s";
      };
      Install.WantedBy = [ "default.target" ];
    };

    systemd.user.services.relay-rook = {
      Unit = {
        Description = "relay-rook chessable<>board bridge";
        After = [ "relay-rook-ble.service" ];
        Requires = [ "relay-rook-ble.service" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.bridgePackage}/bin/relay-rook";
        Environment = envPairs (bridgeEnv // cfg.extraEnvironment);
        Restart = "on-failure";
        RestartSec = "5s";
      };
      Install.WantedBy = [ "default.target" ];
    };

    home.activation.relay-rook-state-dir =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.dbPath)}
        run mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.bleSocket)}
      '';
  };
}
