{
  description = "relay-rook — chessable <> chessnut bridge (Haskell tagless-final + Rust BLE daemon)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages = {
          relay-rook     = pkgs.callPackage ./nix/package.nix { };
          relay-rook-ble = pkgs.callPackage ./nix/ble.nix { };
          default        = self.packages.${system}.relay-rook;
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
