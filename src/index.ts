import { createServer } from "http";
import { WebSocketServer } from "ws";
import { subscribeUpstream } from "./binance-upstream";

/* ════════════════════════════════════════════════════════════
   OXIER TOKYO RELAY

   Deployed in a Tokyo-region datacenter, close to Binance's WS gateway.
   The Amsterdam backend connects here (via RELAY_WS_URL) instead of
   dialing wss://stream.binance.com / wss://fstream.binance.com directly.
   This box does the actual Binance connection — a hop of a few ms, since
   it's local to Binance — then forwards the exact same raw frames on to
   Amsterdam over one persistent link.

   This process holds NO business logic, NO database connection, and NO
   say over trades. It only ever forwards bytes it received from Binance,
   unmodified. All trade validation still happens on the Amsterdam
   backend, exactly as before — see binance-relay.service.ts there for why
   that boundary matters.

   Expected connection path from Amsterdam: wss://<this-host>/<spot|futures>/<streamKey>
   e.g. wss://relay-tokyo.example.com/spot/btcusdt@kline_1m
   ════════════════════════════════════════════════════════════ */

const PORT = Number(process.env["PORT"] || 8080);
const AUTH_TOKEN = process.env["RELAY_AUTH_TOKEN"];

if (!AUTH_TOKEN || AUTH_TOKEN.length < 16) {
  throw new Error(
    "RELAY_AUTH_TOKEN environment variable is required and must be at least 16 characters " +
      "(this endpoint is reachable from the public internet). Generate one with: openssl rand -hex 32"
  );
}

const SPOT_WS_BASE = "wss://stream.binance.com:9443/ws";
const FUTURES_WS_BASE = "wss://fstream.binance.com/market/ws";

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  // Constant-time-ish check isn't critical here — this token only gates a
  // read-only public-market-data relay, not funds or user data — but a
  // simple equality check on a long random secret is already enough to
  // stop casual/opportunistic scraping of the endpoint.
  if (req.headers["x-relay-token"] !== AUTH_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Path convention: /<spot|futures>/<streamKey>
  const parts = (req.url || "").split("/").filter(Boolean);
  const market = parts[0];
  const streamKey = parts.slice(1).join("/");

  if ((market !== "spot" && market !== "futures") || !streamKey) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const base = market === "futures" ? FUTURES_WS_BASE : SPOT_WS_BASE;
    const upstreamUrl = `${base}/${streamKey}`;
    const upstreamKey = `${market}:${streamKey}`;

    const unsubscribe = subscribeUpstream(upstreamKey, upstreamUrl, (raw) => {
      if (client.readyState === client.OPEN) client.send(raw);
    });

    client.on("close", unsubscribe);
    client.on("error", unsubscribe);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[oxier-relay-tokyo] listening on :${PORT}`);
});
