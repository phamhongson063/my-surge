import https from "https";
import { sendJSON } from "../lib/utils.mjs";
import { fetchFromCafeF } from "../lib/cafef.mjs";

// ─── SSE realtime: SignalR trước, fallback poll MSH nếu 10s không có data ─────
const sseClients = new Map(); // sym → Set<res>
const ssePriceCache = new Map(); // sym → { data, ts }
const symState = new Map(); // sym → { ws, pingTimer, fallbackTimer, pollTimer, mode:'signalr'|'poll' }

const SIGNALR_HUB = "wss://realtime.cafef.vn/hub/priceshub";
const SIGNALR_RS = "\x1e";
const FALLBACK_MS = 10_000; // chờ 10s, nếu SignalR không gửi data thì poll

function parseMshPrice(v) {
  if (!v) return null;
  const n = (x) => (x != null ? parseFloat(x) : null);
  const price = n(v.price ?? v.Price);
  const ref = n(v.refPrice ?? v.refprice ?? v.RefPrice);
  const change =
    price != null && ref != null ? parseFloat((price - ref).toFixed(2)) : null;
  const changePct =
    price != null && ref
      ? parseFloat((((price - ref) / ref) * 100).toFixed(2))
      : null;
  return {
    price,
    change,
    changePct,
    ref,
    open: n(v.openPrice),
    high: n(v.highPrice),
    low: n(v.lowPrice),
    volume: n(v.volume),
  };
}

function sseBroadcast(sym, data) {
  const clients = sseClients.get(sym);
  if (!clients?.size) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(msg);
    } catch {}
  });
  ssePriceCache.set(sym, { data, ts: Date.now() });
}

async function fetchMshPriceData(sym) {
  const mshUrl = `https://msh-appdata.cafef.vn/rest-api/api/v1/Watchlists/${sym}/price`;
  return new Promise((resolve, reject) => {
    https
      .get(
        mshUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "application/json",
            Origin: "https://cafef.vn",
            Referer: "https://cafef.vn/",
          },
        },
        (rsp) => {
          const chunks = [];
          rsp.on("data", (c) => chunks.push(c));
          rsp.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("Invalid JSON from MSH"));
            }
          });
          rsp.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

async function doPollOnce(sym) {
  try {
    const json = await fetchMshPriceData(sym);
    const v = json?.data?.value;
    if (!v) return;
    const data = parseMshPrice(v);
    if (data?.price) {
      sseBroadcast(sym, data);
      console.log(`[Poll] ✅ ${sym}: ${data.price}`);
    }
  } catch (err) {
    console.error(`[Poll] Error ${sym}:`, err.message);
  }
}

function startPollFallback(sym) {
  const st = symState.get(sym);
  if (!st || st.pollDone) return;
  st.pollDone = true;
  st.mode = "poll";
  console.log(`[Poll] ▶ Fallback ${sym} — poll 1 lần (SignalR không có data)`);
  doPollOnce(sym);
}

function startSignalRForSym(sym) {
  if (symState.has(sym)) return;
  console.log(`[SignalR] ▶ Connect ${sym}`);
  const st = {
    ws: null,
    pingTimer: null,
    fallbackTimer: null,
    pollDone: false,
    mode: "signalr",
  };
  symState.set(sym, st);

  // Nếu 10s không nhận được data từ SignalR → fallback sang poll
  st.fallbackTimer = setTimeout(() => {
    st.fallbackTimer = null;
    if (st.mode === "signalr") startPollFallback(sym);
  }, FALLBACK_MS);

  const ws = new WebSocket(SIGNALR_HUB);
  st.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + SIGNALR_RS);
  });

  ws.addEventListener("message", (event) => {
    const raw =
      typeof event.data === "string" ? event.data : event.data.toString();
    const parts = raw.split(SIGNALR_RS).filter((s) => s.trim());
    for (const part of parts) {
      try {
        const msg = JSON.parse(part);
        if (!st.pingTimer) {
          // Handshake xong → join channel
          ws.send(
            JSON.stringify({
              type: 1,
              target: "JoinChannel",
              arguments: [sym],
              invocationId: "0",
            }) + SIGNALR_RS
          );
          st.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 6 }) + SIGNALR_RS);
          }, 15_000);
          console.log(`[SignalR] ✅ Joined ${sym}`);
        }
        if (msg.type === 1 && msg.target === "RealtimePrice") {
          const data = parseMshPrice(msg.arguments?.[0]);
          if (data?.price) {
            if (st.fallbackTimer) {
              clearTimeout(st.fallbackTimer);
              st.fallbackTimer = null;
            }
            st.mode = "signalr";
            sseBroadcast(sym, data);
          }
        }
      } catch {}
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(st.pingTimer);
    st.pingTimer = null;
    clearTimeout(st.fallbackTimer);
    st.fallbackTimer = null;
    console.log(`[SignalR] ❌ Closed ${sym}`);
    if (sseClients.get(sym)?.size > 0) {
      setTimeout(() => {
        symState.delete(sym);
        startSignalRForSym(sym);
      }, 5_000);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error(`[SignalR] Error ${sym}:`, err.message ?? err);
  });
}

function stopSignalRForSym(sym) {
  const st = symState.get(sym);
  if (!st) return;
  clearInterval(st.pingTimer);
  clearTimeout(st.fallbackTimer);
  try {
    st.ws?.close();
  } catch {}
  symState.delete(sym);
  console.log(`[SignalR] ⏹ Stop ${sym}`);
}

export async function handle(req, res, { pathname, parsed }) {
  // ─── Proxy MSH realtime price (msh-appdata.cafef.vn) ───────────────────────
  if (pathname === "/msh-price" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) { sendJSON(res, 400, { error: "Thiếu symbol" }); return true; }
    try {
      const data = await fetchMshPriceData(sym);
      sendJSON(res, 200, data);
    } catch (err) {
      sendJSON(res, 502, { error: err.message });
    }
    return true;
  }

  // ─── SSE stream: browser giữ 1 kết nối, server poll MSH mỗi 10s ─────────────
  if (pathname === "/msh-stream" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) {
      res.writeHead(400);
      res.end();
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(":connected\n\n");

    // Gửi cache ngay nếu có
    const cached = ssePriceCache.get(sym);
    if (cached) res.write(`data: ${JSON.stringify(cached.data)}\n\n`);

    if (!sseClients.has(sym)) sseClients.set(sym, new Set());
    sseClients.get(sym).add(res);
    console.log(`[SSE] ➕ ${sym} (clients: ${sseClients.get(sym).size})`);
    startSignalRForSym(sym);

    req.on("close", () => {
      const clients = sseClients.get(sym);
      if (clients) {
        clients.delete(res);
        if (!clients.size) {
          sseClients.delete(sym);
          stopSignalRForSym(sym);
        }
      }
      console.log(
        `[SSE] ➖ ${sym} (clients: ${sseClients.get(sym)?.size ?? 0})`
      );
    });
    return true; // giữ kết nối mở
  }

  // ─── Proxy giá realtime từ CafeF (tránh CORS trên mobile) ──────────────────
  if (pathname === "/price" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) { sendJSON(res, 400, { error: "Thiếu symbol" }); return true; }
    const priceUrl = `https://cafef.vn/du-lieu/Ajax/PageNew/PriceRealTimeHeader.ashx?Symbol=${sym}`;
    try {
      const { buffer } = await fetchFromCafeF(priceUrl, sym);
      const json = JSON.parse(buffer.toString("utf8"));
      sendJSON(res, 200, json);
    } catch (err) {
      sendJSON(res, 502, { error: err.message });
    }
    return true;
  }

  return false;
}
