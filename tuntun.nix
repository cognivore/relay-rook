# Expose the relay-rook bridge through tuntun.
#
# Run `tuntun .` from this directory. tuntun registers the subdomain,
# provisions DNS + Caddy + ACME on your tuntun-server, and tunnels the
# bridge's HTTP port to the public URL below.
#
# Public URL : https://rook.<tenant>.<domain>
# Auth gate  : tenant password (the standard tuntun login wall)
#
# `localPort` must match `services.relay-rook.port`.

{ tuntun, ... }:

tuntun.mkProject {
  tenant = "sweater";
  domain = "fere.me";

  services = {
    rook = {
      subdomain = "rook";
      localPort = 8674;
      auth      = "tenant";
      healthCheck = {
        path           = "/health";
        timeoutSeconds = 3;
      };
    };
  };
}
