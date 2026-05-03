{ haskell, haskellPackages, lib, makeWrapper, sqlite }:

let
  hpkgs = haskellPackages.override {
    overrides = self: super: {
      # beam-sqlite occasionally lands as broken in nixpkgs; force it on.
      beam-sqlite =
        haskell.lib.compose.markUnbroken
          (haskell.lib.compose.dontCheck super.beam-sqlite);
      beam-core =
        haskell.lib.compose.markUnbroken
          (haskell.lib.compose.dontCheck super.beam-core);
      beam-migrate =
        haskell.lib.compose.markUnbroken
          (haskell.lib.compose.dontCheck super.beam-migrate);
    };
  };

  drv = hpkgs.callCabal2nix "relay-rook" (lib.cleanSource ./..) { };
in
  haskell.lib.compose.overrideCabal
    (old: {
      buildTools = (old.buildTools or [ ]) ++ [ makeWrapper ];
      postInstall = (old.postInstall or "") + ''
        mkdir -p $out/share/relay-rook
        cp -r ${./../migrations} $out/share/relay-rook/migrations
        cp ${./../schema.sql} $out/share/relay-rook/schema.sql

        wrapProgram $out/bin/relay-rook \
          --set RELAY_ROOK_MIGRATIONS "$out/share/relay-rook/migrations/relay_rook" \
          --prefix PATH : ${lib.makeBinPath [ sqlite ]}
      '';
    })
    drv
