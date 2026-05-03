{ lib, rustPlatform, pkg-config }:

# btleplug links against CoreBluetooth on macOS; nixpkgs's stdenv-darwin
# now exposes the system SDK frameworks transparently, so no explicit
# framework buildInputs are needed (the legacy darwin.apple_sdk.frameworks
# namespace has been retired).
rustPlatform.buildRustPackage {
  pname = "relay-rook-ble";
  version = "0.1.0";
  src = lib.cleanSource ./../ble;

  cargoLock.lockFile = ./../ble/Cargo.lock;

  nativeBuildInputs = [ pkg-config ];

  meta = {
    description = "BLE daemon for Chessnut Move boards (relay-rook companion)";
    license = lib.licenses.mit;
    mainProgram = "relay-rook-ble";
  };
}
