# Self-hosting Lunel on a local network or tailnet

This fork adds support for running Lunel over plain `http://`/`ws://` URLs, so you
can self-host the manager, proxy, and CLI entirely inside a private network (e.g.
Tailscale) without needing TLS or a public tunnel.

## Why

Upstream Lunel requires every gateway URL to be `https://`/`wss://`. That is a
reasonable default for a public service, but it makes self-hosting on a private
network awkward: you either need to terminate TLS in front of each service or
expose them publicly. This fork relaxes that requirement so both schemes work.

## What changed

All three components previously rejected non-TLS URLs:

| Component | File | Change |
|-----------|------|--------|
| CLI | `cli/src/index.ts` | `normalizeGatewayUrl()` now accepts `http://` and `https://`; the WebSocket derived from a gateway URL now maps `http:// -> ws://` and `https:// -> wss://` |
| Manager | `manager/src/index.ts` | `normalizeGatewayUrl()` now accepts `http://` and `https://` |
| Proxy | `proxy/src/index.ts` | `normalizeGatewayUrl()` now accepts `http://` and `https://`; the manager-control WebSocket maps `http:// -> ws://` and `https:// -> wss://` |

Bare hostnames (no scheme) still default to `https://`, so existing TLS
deployments keep working unchanged.

## Example: tailnet deployment

Given a machine reachable in the tailnet as `lumen.tailnet-name.ts.net`:

```bash
# manager listens on 3001, proxy on 3002 (host network is fine)
MANAGER_PUBLIC_URL=http://lumen.tailnet-name.ts.net:3001
PROXY_PUBLIC_URL=http://lumen.tailnet-name.ts.net:3002
```

The CLI uses the same URLs:

```bash
LUNEL_PROXY_URL=http://lumen.tailnet-name.ts.net:3002 \
LUNEL_MANAGER_URL=http://lumen.tailnet-name.ts.net:3001 \
npx lunel-cli
```

## Notes

- Use `http://` only inside a network you trust. For anything public, keep the
  `https://` URLs (unchanged behavior).
- If you run manager and proxy on the same host, `http://localhost:3001` and
  `http://localhost:3002` also work.
