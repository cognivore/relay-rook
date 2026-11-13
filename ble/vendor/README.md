# btleplug 0.11.8

Vendored from the dependency already used in the deployed Nix closure:
`c9a11621cb2c8c024e444734292482b1ad86fb50ded066cf46252e46643c8748`
(crates.io package checksum). Upstream licences remain in `btleplug/LICENSE.md`.

Local CoreBluetooth changes:

- Drain an Objective-C autorelease pool after every worker-future poll,
  including `Pending`, rather than retaining temporaries until thread exit.
- Support `ScanFilter.local_name_contains` before creating retained device
  state. Other backends may ignore the optional name filter; the application
  still checks names. This preserves discovery of boards that do not
  advertise their service UUIDs.
- Retain at most 64 peripherals. Each new scan expires idle discoveries from
  both maps and closes their forwarding channels. Connected devices and
  devices with connection/disconnection requests in flight remain pinned.
- Return an error when a connection request references an expired discovery.

The daemon and Nix package use this same path dependency. Regression tests
under `ble/tests/` execute the production retention policy and native pool
wrapper, without needing a Bluetooth board. An upstream update must preserve
these behaviours or replace them with equivalent tested upstream fixes.
