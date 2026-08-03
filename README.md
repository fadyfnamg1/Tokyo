# oxier-relay-tokyo

A tiny, stateless WebSocket proxy meant to run on a server in (or near)
Tokyo. It holds the real connection to Binance's public market-data
streams and forwards the raw frames to the Amsterdam backend over one
persistent link.

**What this does and doesn't do**
- Does: sit physically close to Binance so the Binance→relay hop is a few
  ms instead of ~150-200ms, and centralize Binance-side reconnects.
- Doesn't: authorize, validate, or see any trade. It has no database, no
  user data, and no opinion about prices — it only relays bytes. All trade
  logic stays on the Amsterdam backend, unchanged.

## 1. Get a Tokyo-region box

Any small VPS in or near Tokyo works (e.g. AWS `ap-northeast-1`, or any
provider with a Tokyo/Osaka location). This process is lightweight — a
$5-6/mo instance is plenty to start.

## 2. Configure

```bash
cp .env.example .env
# then edit .env:
#   RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
```

## 3. Run it

**With Docker (recommended):**
```bash
docker build -t oxier-relay-tokyo .
docker run -d --restart unless-stopped \
  --env-file .env \
  -p 8080:8080 \
  --name oxier-relay-tokyo \
  oxier-relay-tokyo
```

**Without Docker:**
```bash
npm install
npm run build
npm start   # or use pm2/systemd to keep it alive
```

Check it's up: `curl http://localhost:8080/health` → `ok`

## 4. Put TLS in front of it

The app itself speaks plain `ws://` on port 8080. Amsterdam should connect
over `wss://`, so put a reverse proxy in front that terminates TLS —
[Caddy](https://caddyserver.com/) is the easiest option (automatic
Let's Encrypt certs, ~5 lines of config):

```
relay-tokyo.yourdomain.com {
  reverse_proxy localhost:8080
}
```

Point a DNS A record for `relay-tokyo.yourdomain.com` at the box's IP
first, then start Caddy.

## 5. Wire it into the Amsterdam backend

In the main backend's environment, set:

```
RELAY_WS_URL=wss://relay-tokyo.yourdomain.com
RELAY_AUTH_TOKEN=<the same value you generated in step 2>
```

Redeploy the backend. It will start routing Binance price streams through
this relay automatically, and fall back to connecting to Binance directly
if the relay ever becomes unreachable (see the comment block at the top of
`binance-relay.service.ts`).

Leaving `RELAY_WS_URL` unset keeps the backend's current behavior exactly
as it is today — this is fully optional and safe to deploy at any pace.

## 6. Confirm it's actually helping

Binance's kline/trade payloads carry an event-timestamp field. Before and
after pointing `RELAY_WS_URL` at this box, log `Date.now() - payload.E` (or
`.T` depending on stream type) on the Amsterdam side and compare. If the
gap hasn't meaningfully improved, check that the Tokyo box and Binance are
actually close on the network (not just on a map) before assuming the
approach doesn't work.
