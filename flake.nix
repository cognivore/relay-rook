{
  description = "relay-rook — chessable <> chessnut bridge (Haskell tagless-final + Rust BLE daemon)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    archive-nixpkgs.url = "github:NixOS/nixpkgs/02f5696b0e6097e589076d886b317b83ff0437d7";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, archive-nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        archivePkgs = archive-nixpkgs.legacyPackages.${system};
        archivePython = archivePkgs.python3.withPackages (ps: [ ps.pywidevine ]);
        archiveTools = [
          archivePython
          archivePkgs.yt-dlp archivePkgs.ffmpeg archivePkgs.bento4
        ];
      in
      {
        packages = {
          relay-rook     = pkgs.callPackage ./nix/package.nix { };
          relay-rook-ble = pkgs.callPackage ./nix/ble.nix { };
          archive = pkgs.writeShellApplication {
            name = "relay-rook-archive";
            runtimeInputs = archiveTools;
            text = ''
              exec python3 ${./archive}/server.py --extension "$PWD/extension" "$@"
            '';
          };
          default        = self.packages.${system}.relay-rook;
        };

        devShells.archive = archivePkgs.mkShell { packages = archiveTools ++ [ pkgs.nodejs ]; };
        devShells.openwv = pkgs.mkShell {
          nativeBuildInputs = [
            archivePython pkgs.git pkgs.cargo pkgs.rustc pkgs.clang
            pkgs.rustPlatform.bindgenHook
          ];
        };
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.haskell.compiler.ghc984Binary
            pkgs.cabal-install
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.clippy
            pkgs.pkg-config
            pkgs.binutils
          ];
          # Darwin frameworks (CoreBluetooth, etc.) come from stdenv-darwin
          # automatically since the legacy apple_sdk.frameworks namespace
          # was retired in nixpkgs.
          buildInputs = [
            pkgs.zlib
            pkgs.sqlite
          ];
          shellHook = ''
            echo "relay-rook dev shell — Haskell + Rust"
            export RELAY_ROOK_MIGRATIONS="$PWD/migrations/relay_rook"
            export RELAY_ROOK_BLE_SOCKET="$PWD/.relay-rook-ble.sock"
          '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.relay-rook}/bin/relay-rook";
        };
        apps.archive = {
          type = "app";
          program = "${self.packages.${system}.archive}/bin/relay-rook-archive";
        };
        apps.relay-rook-ble = {
          type = "app";
          program = "${self.packages.${system}.relay-rook-ble}/bin/relay-rook-ble";
        };
      }
    ) // {
      homeManagerModules.default    = import ./nix/home-manager.nix self;
      homeManagerModules.relay-rook = import ./nix/home-manager.nix self;
    };
}
