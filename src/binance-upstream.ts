import WebSocket from "ws";

/* ════════════════════════════════════════════════════════════
   BINANCE UPSTREAM (Tokyo side)

   Same pattern as the main backend's binance-relay.service.ts: one real
   Binance connection per distinct stream key, shared across every local
   subscriber (in practice there's normally exactly one — the Amsterdam
   backend's own relay client — but the fan-out costs nothing and protects
   us if that ever changes, e.g. a second downstream consumer later).

   Deliberately dumb: this box only forwards raw Binance frames untouched.
   It doesn't parse them, doesn't know about markets/challenges/users, and
   has no DB connection — if it's ever compromised, there's no business
   data on it to take.
   ════════════════════════════════════════════════════════════ */

type RawListener = (raw: WebSocket.RawData) => void;

interface UpstreamStream {
  ws: WebSocket | null;
  listeners: Set<RawListener>;
  reconnectTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const streams = new Map<string, UpstreamStream>();

function openUpstream(key: string, url: string): void {
  const stream = streams.get(key);
  if (!stream || stream.closed) return;

  const ws = new WebSocket(url);
  stream.ws = ws;

  ws.on("message", (raw) => {
    const current = streams.get(key);
    if (!current) return;
    for (const listener of current.listeners) {
      try {
        listener(raw);
      } catch {
        // One bad downstream socket shouldn't take the others down with it.
      }
    }
  });

  ws.on("close", () => {
    const current = streams.get(key);
    if (!current || current.closed) return;
    if (current.listeners.size === 0) return;
    current.reconnectTimer = setTimeout(() => openUpstream(key, url), 1500);
  });

  ws.on("error", (err) => {
    console.warn(`[binance-upstream] ${key} error:`, err instanceof Error ? err.message : err);
    try {
      ws.close();
    } catch {
      /* noop */
    }
  });
}

/**
 * key must uniquely identify the upstream, e.g. "spot:btcusdt@kline_1m" or
 * "futures:solusdt@aggTrade" — include the market in the key, since spot
 * and futures streams for the same symbol are different Binance sockets.
 */
export function subscribeUpstream(key: string, url: string, listener: RawListener): () => void {
  let stream = streams.get(key);
  if (!stream) {
    stream = { ws: null, listeners: new Set(), reconnectTimer: null, closed: false };
    streams.set(key, stream);
    openUpstream(key, url);
  }
  stream.listeners.add(listener);

  return () => {
    const current = streams.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.closed = true;
      if (current.reconnectTimer) clearTimeout(current.reconnectTimer);
      try {
        current.ws?.close();
      } catch {
        /* noop */
      }
      streams.delete(key);
    }
  };
}
