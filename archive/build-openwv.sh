#!/usr/bin/env bash
# Run inside `nix develop .#openwv`. Private output never enters the Nix store.
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  echo 'Usage: build-openwv.sh /private/device.wvd /private/new-build-directory' >&2
  exit 2
fi
openwv_device=$1
openwv_build=$2
openwv_revision=f21f7906c80e691c8e112d49370dc29b8d763440

# Check the actual prerequisite before downloading source or compiling anything.
python3 - "$openwv_device" "$openwv_build" <<'PY'
from pathlib import Path
import sys
from pywidevine.device import Device
source, destination = (Path(p).expanduser().resolve() for p in sys.argv[1:])
if sys.platform != 'darwin':
    sys.exit('This build entry point targets macOS.')
if not source.is_file():
    sys.exit('OpenWV requires your own .wvd device provision. The supplied file does not exist; nothing was built or installed.')
if source.is_relative_to('/nix/store') or source.stat().st_mode & 0o077:
    sys.exit('The device provision must be outside the Nix store with permissions 600.')
if destination.exists():
    sys.exit('Choose a new build directory; existing files will not be overwritten.')
if destination.is_relative_to('/nix/store'):
    sys.exit('OpenWV embeds the private device identity. Build output must stay outside the Nix store.')
if any((parent / '.git').exists() for parent in [destination, *destination.parents]):
    sys.exit('Choose a private build directory outside Git repositories; build artifacts contain the device identity.')
try:
    Device.load(source)
except Exception as error:
    sys.exit(f'The device provision cannot be parsed ({type(error).__name__}).')
destination.mkdir(parents=True, mode=0o700)
destination.chmod(0o700)
PY
openwv_device=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).expanduser().resolve())' "$openwv_device")
openwv_build=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).expanduser().resolve())' "$openwv_build")

git clone --no-checkout https://github.com/tchebb/openwv.git "$openwv_build/source"
git -C "$openwv_build/source" checkout --detach "$openwv_revision"
git -C "$openwv_build/source" submodule update --init --recursive
install -m 600 "$openwv_device" "$openwv_build/source/embedded.wvd"
trap 'rm -f "$openwv_build/source/embedded.wvd"' EXIT
# Keep the embedded identity out of shared compiler caches as well.
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
export CARGO_HOME="$openwv_build/cargo-home"
export CARGO_TARGET_DIR="$openwv_build/target"
export CARGO_INCREMENTAL=0
cargo build --release --locked --manifest-path "$openwv_build/source/Cargo.toml"
if [[ ! -s "$openwv_build/target/release/libwidevinecdm.dylib" ]]; then
  echo 'Build did not produce the macOS CDM library. Chrome was not changed.' >&2
  exit 1
fi
openwv_package="$openwv_build/chrome/9999"
case $(uname -m) in
  arm64) openwv_platform=mac_arm64 ;;
  x86_64) openwv_platform=mac_x64 ;;
  *) echo 'This build entry point supports native macOS architectures only.' >&2; exit 1 ;;
esac
mkdir -p "$openwv_package/_platform_specific/$openwv_platform"
install -m 600 "$openwv_build/target/release/libwidevinecdm.dylib" "$openwv_package/_platform_specific/$openwv_platform/"
install -m 600 "$openwv_build/source/manifest-chromium.json" "$openwv_package/manifest.json"
echo "Prepared private Chrome CDM package: $openwv_package"
echo 'Chrome has not been modified. Follow Relay Rook → OpenWV setup to review installation and rollback.'
