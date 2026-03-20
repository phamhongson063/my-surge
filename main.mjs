/**
 * server.mjs — Express proxy server cho CafeF Stock Downloader
 *
 * Khởi động: node server.mjs
 * Mặc định chạy tại: http://localhost:3000
 *
 * API:
 *   GET /download?symbol=DPM&start=2025-01-01&end=2026-03-13
 *     → tải file từ CafeF, lưu vào export/<SYMBOL>/, trả blob về browser
 *
 *   GET /health  → { status: "ok" }
 */

import http from "http";
import os from "os";
import https from "https";
import fs from "fs";
import path from "path";
import url from "url";
import crypto from "crypto";
import {
  analyzeAll,
  analyzeDetail,
  scanWatchlist,
  parseBody,
  loadWatchlist,
  saveWatchlist,
  loadPortfolio,
  savePortfolio,
  loadHistory,
  saveHistory,
} from "./analyze.mjs";

const PORT = process.env.PORT || 3000;
const TMP_DIR = "tmp";

// ─── SSI Token store ──────────────────────────────────────────────────────────
const BASE_DIR_ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const SSI_TOKEN_FILE = path.join(BASE_DIR_ROOT, "database", "ssi_token.json");
let ssiToken = null; // Bearer token, loaded from file on start

function loadSsiToken() {
  try {
    if (fs.existsSync(SSI_TOKEN_FILE)) {
      const { token } = JSON.parse(fs.readFileSync(SSI_TOKEN_FILE, "utf8"));
      ssiToken = token || null;
      if (ssiToken) console.log("[SSI] Token loaded from file");
    }
  } catch {}
}
function saveSsiToken(token) {
  ssiToken = token;
  fs.mkdirSync(path.dirname(SSI_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    SSI_TOKEN_FILE,
    JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)
  );
  console.log("[SSI] Token saved");
}
loadSsiToken();

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

// ─── Market snapshot: fetch toàn thị trường từ SSI iboard-query (3 request) ──
let _snapshotCache = null;
let _snapshotCacheTime = 0;
const SNAPSHOT_TTL_MS = 60_000; // cache 1 phút để tránh gọi lại khi 2 endpoint chạy song song

async function fetchMarketSnapshot() {
  if (_snapshotCache && Date.now() - _snapshotCacheTime < SNAPSHOT_TTL_MS) {
    return _snapshotCache;
  }
  const snapshot = {}; // { SYM: { changePct, volume, price, refPrice } }
  const exchanges = ["hose", "hnx", "upcom"];

  await Promise.all(
    exchanges.map(
      (ex) =>
        new Promise((resolve) => {
          const targetUrl = `https://iboard-query.ssi.com.vn/stock/exchange/${encodeURIComponent(ex)}`;
          https
            .get(
              targetUrl,
              {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                  Origin: "https://iboard.ssi.com.vn",
                  Referer: "https://iboard.ssi.com.vn/",
                  Accept: "application/json",
                },
              },
              (rsp) => {
                const chunks = [];
                rsp.on("data", (c) => chunks.push(c));
                rsp.on("end", () => {
                  try {
                    const json = JSON.parse(
                      Buffer.concat(chunks).toString("utf8")
                    );
                    const list = Array.isArray(json)
                      ? json
                      : Array.isArray(json.data)
                      ? json.data
                      : [];
                    list.forEach((s) => {
                      const sym = (
                        s.stockSymbol ||
                        s.code ||
                        ""
                      )
                        .trim()
                        .toUpperCase();
                      if (!sym) return;
                      snapshot[sym] = {
                        price: s.matchedPrice,
                        refPrice: s.refPrice,
                        // priceChangePercent từ SSI là số thực (vd: 1.85 = +1.85%)
                        changePct: parseFloat(
                          (s.priceChangePercent ?? 0).toFixed(2)
                        ),
                        // nmTotalTradedQty / 100 = khối lượng (cổ phiếu, đơn vị nghìn)
                        volume: Math.round((s.nmTotalTradedQty ?? 0) / 100),
                      };
                    });
                  } catch { /* ignore */ }
                  resolve();
                });
                rsp.on("error", resolve);
              }
            )
            .on("error", resolve);
        })
    )
  );

  _snapshotCache = snapshot;
  _snapshotCacheTime = Date.now();
  console.log(
    `[Snapshot] ✅ ${Object.keys(snapshot).length} mã từ 3 sàn`
  );
  return snapshot;
}

// ─── Helpers (giống download_stock.mjs) ─────────────────────────────────────

// yyyy-mm-dd  →  mm/dd/yyyy  (API CafeF)
function isoToApi(iso) {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// mm/dd/yyyy  →  mmddyyyy  (filename tag)
function apiToTag(apiDate) {
  return apiDate.replace(/\//g, "");
}

// dd/mm/yyyy  (hiển thị)  ←  yyyy-mm-dd
function isoToDisplay(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Core download (tái sử dụng logic từ download_stock.mjs) ────────────────

function fetchFromCafeF(targetUrl, symbol, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Quá nhiều lần redirect"));

    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: `https://cafef.vn/du-lieu/lich-su-giao-dich-${symbol.toLowerCase()}-1.chn`,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*",
        "Accept-Language": "vi-VN,vi;q=0.9",
      },
    };

    https
      .get(targetUrl, options, (res) => {
        // Redirect
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : `https://cafef.vn${res.headers.location}`;
          res.resume();
          return fetchFromCafeF(next, symbol, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`CafeF trả HTTP ${res.statusCode}`));
        }

        // Gom buffer
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            buffer: Buffer.concat(chunks),
            contentType:
              res.headers["content-type"] ?? "application/octet-stream",
          })
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// ─── CafeF history fetch (fallback) ──────────────────────────────────────────
function fetchHistoryCafeF(sym, days, res) {
  return new Promise((resolve) => {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 86400_000);
    const fmt = (d) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
        d.getDate()
      ).padStart(2, "0")}/${d.getFullYear()}`;
    const pageSize = Math.min(days + 50, 500);
    const histUrl = `https://cafef.vn/du-lieu/Ajax/PageNew/DataHistory/PriceHistory.ashx?Symbol=${sym}&StartDate=${fmt(
      startDate
    )}&EndDate=${fmt(endDate)}&PageIndex=1&PageSize=${pageSize}`;

    https
      .get(
        histUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Referer: `https://cafef.vn/du-lieu/lich-su-giao-dich-${sym.toLowerCase()}-1.chn`,
            Accept: "application/json",
          },
        },
        (rsp) => {
          const chunks = [];
          rsp.on("data", (c) => chunks.push(c));
          rsp.on("end", () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const rows = json?.Data?.Data;
              if (!Array.isArray(rows) || rows.length === 0) {
                sendJSON(res, 200, {
                  ok: false,
                  symbol: sym,
                  message: "Không có dữ liệu",
                });
                return resolve();
              }
              const records = rows
                .map((r) => {
                  const [d, m, y] = (r.Ngay || "").split("/");
                  return {
                    date: `${y}-${m}-${d}`,
                    open: r.GiaMoCua,
                    high: r.GiaCaoNhat,
                    low: r.GiaThapNhat,
                    close: r.GiaDongCua,
                    volume: r.KhoiLuongKhopLenh,
                  };
                })
                .filter(
                  (r) => r.date && r.date !== "undefined-undefined-undefined"
                )
                .sort((a, b) => a.date.localeCompare(b.date));

              const histDir = path.join(BASE_DIR_ROOT, "database", "history");
              fs.mkdirSync(histDir, { recursive: true });
              fs.writeFileSync(
                path.join(histDir, `${sym}.json`),
                JSON.stringify(
                  {
                    symbol: sym,
                    source: "cafef",
                    updated: new Date().toISOString(),
                    records,
                  },
                  null,
                  2
                )
              );
              console.log(`[History/CafeF] ✅ ${sym}: ${records.length} phiên`);
              sendJSON(res, 200, {
                ok: true,
                symbol: sym,
                count: records.length,
                source: "cafef",
              });
            } catch (e) {
              sendJSON(res, 502, { error: e.message });
            }
            resolve();
          });
          rsp.on("error", (e) => {
            sendJSON(res, 502, { error: e.message });
            resolve();
          });
        }
      )
      .on("error", (e) => {
        sendJSON(res, 502, { error: e.message });
        resolve();
      });
  });
}

// ─── Request handler ─────────────────────────────────────────────────────────

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handleDownload(req, res, query) {
  const symbol = (query.symbol ?? "").toUpperCase().trim();
  const start = query.start ?? "2025-01-01";
  const end = query.end ?? todayISO();

  if (!symbol) return sendJSON(res, 400, { error: "Thiếu tham số symbol" });
  if (!/^[A-Z0-9]{1,10}$/.test(symbol))
    return sendJSON(res, 400, { error: "Mã chứng khoán không hợp lệ" });

  const startApi = isoToApi(start);
  const endApi = isoToApi(end);
  const fileName = `${symbol}.xlsx`;
  const savePath = path.join(TMP_DIR, fileName);
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const params = new URLSearchParams({
    Type: "EXPORT",
    Symbol: symbol,
    StartDate: startApi,
    EndDate: endApi,
    PageIndex: "1",
    PageSize: "20",
  });
  const cafefUrl = `https://cafef.vn/du-lieu/Ajax/PageNew/DataHistory/PriceHistory.ashx?${params}`;

  console.log(
    `\n[${new Date().toLocaleTimeString("vi-VN")}] ▶ ${symbol} | ${isoToDisplay(
      start
    )} → ${isoToDisplay(end)}`
  );
  console.log(`   URL: ${cafefUrl}`);

  try {
    const { buffer, contentType } = await fetchFromCafeF(cafefUrl, symbol);

    // Kiểm tra buffer có phải Excel thật không
    // Excel (xlsx) bắt đầu bằng magic bytes: PK (50 4B)
    const isPKzip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (!isPKzip) {
      const preview = buffer.slice(0, 200).toString("utf8").replace(/\n/g, " ");
      console.warn(`   ⚠️  Không phải Excel! Content-Type: ${contentType}`);
      console.warn(`   Preview: ${preview}`);
      return sendJSON(res, 502, {
        error:
          "CafeF không trả về file Excel. Có thể cần đăng nhập hoặc mã không tồn tại.",
        preview: preview.slice(0, 100),
      });
    }

    fs.writeFileSync(savePath, buffer);
    const kb = (buffer.length / 1024).toFixed(1);
    console.log(`   ✅ Lưu: ${path.resolve(savePath)} (${kb} KB)`);

    // Chỉ trả JSON — file đã lưu ngầm trên server, không gửi blob về browser
    sendJSON(res, 200, {
      ok: true,
      symbol,
      fileName,
      filePath: path.resolve(savePath),
      sizeKb: kb,
      start: startApi,
      end: endApi,
    });
  } catch (err) {
    console.error(`   ❌ Lỗi: ${err.message}`);
    sendJSON(res, 502, { error: err.message });
  }
}

// ─── WebSocket Board Server ───────────────────────────────────────────────────

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BOARD_INDEX_IDS = ["VNINDEX", "VN30", "HNXIndex", "HNX30", "UpcomIndex"];
const BOARD_TAB_URLS = {
  VN30:  "https://iboard-query.ssi.com.vn/stock/group/VN30",
  hose:  "https://iboard-query.ssi.com.vn/stock/exchange/hose",
  hnx:   "https://iboard-query.ssi.com.vn/stock/exchange/hnx",
  upcom: "https://iboard-query.ssi.com.vn/stock/exchange/upcom",
};
const SSI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Origin: "https://iboard.ssi.com.vn",
  Referer: "https://iboard.ssi.com.vn/",
  Accept: "application/json",
};

const boardWsClients = new Set(); // Set<{socket, subs: Set<string>}>
const boardTabCache   = new Map(); // tab → data[]
const boardTabPrevMap = new Map(); // tab → Map<sym, stock>  — for diff
let boardPoller = null;
const BOARD_POLL_MS = 1000;

// Các field cần theo dõi để phát hiện thay đổi
const BOARD_DIFF_FIELDS = [
  "matchedPrice", "matchedVolume", "priceChange", "priceChangePercent",
  "best1Bid", "best1BidVol", "best2Bid", "best2BidVol", "best3Bid", "best3BidVol",
  "best1Offer", "best1OfferVol", "best2Offer", "best2OfferVol", "best3Offer", "best3OfferVol",
  "nmTotalTradedQty", "buyForeignQtty", "sellForeignQtty",
];

function computeDiff(tab, newData) {
  const key = s => s.stockSymbol ?? s.code ?? "";
  const newMap = new Map(newData.map(s => [key(s), s]));
  const prev = boardTabPrevMap.get(tab);
  boardTabPrevMap.set(tab, newMap);
  if (!prev) return null; // first time — no diff yet

  const updates = [];
  for (const [k, s] of newMap) {
    const old = prev.get(k);
    if (!old) { updates.push(s); continue; }
    for (const f of BOARD_DIFF_FIELDS) {
      if (old[f] !== s[f]) { updates.push(s); break; }
    }
  }
  return updates; // [] = nothing changed
}

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsSend(socket, obj) {
  if (socket.destroyed) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const len = buf.length;
    let frame;
    if (len < 126) {
      frame = Buffer.allocUnsafe(2 + len);
      frame[0] = 0x81; frame[1] = len;
      buf.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.allocUnsafe(4 + len);
      frame[0] = 0x81; frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      buf.copy(frame, 4);
    } else {
      frame = Buffer.allocUnsafe(10 + len);
      frame[0] = 0x81; frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      buf.copy(frame, 10);
    }
    socket.write(frame);
  } catch {}
}

function wsParseFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let hdrLen = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2); hdrLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2)); hdrLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const totalLen = hdrLen + maskLen + payloadLen;
    if (offset + totalLen > buf.length) break;
    if (opcode === 0x8) { messages.push({ type: "close" }); break; }
    if (opcode === 0x1 || opcode === 0x2) {
      const maskOffset = offset + hdrLen;
      const dataOffset = maskOffset + maskLen;
      const payload = Buffer.allocUnsafe(payloadLen);
      if (masked) {
        for (let i = 0; i < payloadLen; i++)
          payload[i] = buf[dataOffset + i] ^ buf[maskOffset + (i % 4)];
      } else {
        buf.copy(payload, 0, dataOffset, dataOffset + payloadLen);
      }
      try { messages.push({ type: "message", data: JSON.parse(payload.toString("utf8")) }); } catch {}
    }
    offset += totalLen;
  }
  return { messages, remaining: buf.slice(offset) };
}

function fetchSsiBoardTab(tabKey) {
  const targetUrl = BOARD_TAB_URLS[tabKey];
  if (!targetUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    https.get(targetUrl, { headers: SSI_HEADERS }, (rsp) => {
      const chunks = [];
      rsp.on("data", c => chunks.push(c));
      rsp.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : null);
        } catch { resolve(null); }
      });
      rsp.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

function fetchSsiBoardIndex(indexId) {
  const targetUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(indexId)}?hasHistory=false`;
  return new Promise((resolve) => {
    https.get(targetUrl, { headers: SSI_HEADERS }, (rsp) => {
      const chunks = [];
      rsp.on("data", c => chunks.push(c));
      rsp.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data ?? null); }
        catch { resolve(null); }
      });
      rsp.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

function getActiveTabsAndSubs() {
  const tabs = new Set();
  let wantIndexes = false;
  for (const client of boardWsClients) {
    for (const s of client.subs) {
      if (s === "indexes") wantIndexes = true;
      else tabs.add(s);
    }
  }
  return { tabs, wantIndexes };
}

function broadcastToSubs(tab, msg) {
  for (const client of boardWsClients) {
    if (client.subs.has(tab)) wsSend(client.socket, msg);
  }
}

function startBoardPoller() {
  if (boardPoller) return;
  boardPoller = setInterval(async () => {
    if (boardWsClients.size === 0) return;
    const { tabs, wantIndexes } = getActiveTabsAndSubs();
    const promises = [];

    for (const tab of tabs) {
      promises.push(fetchSsiBoardTab(tab).then(data => {
        if (!data) return;
        boardTabCache.set(tab, data);
        const diff = computeDiff(tab, data);
        if (diff === null) {
          // First fetch for this tab — broadcast full board
          broadcastToSubs(tab, { type: "board", tab, data });
        } else if (diff.length > 0) {
          // Only push changed stocks
          broadcastToSubs(tab, { type: "update", tab, updates: diff });
        }
        // diff.length === 0 → nothing changed, send nothing
      }));
    }

    if (wantIndexes) {
      promises.push(
        Promise.all(BOARD_INDEX_IDS.map(id => fetchSsiBoardIndex(id).then(d => [id, d])))
          .then(results => {
            const indexData = {};
            for (const [id, d] of results) if (d) indexData[id] = d;
            if (Object.keys(indexData).length) {
              for (const client of boardWsClients) {
                if (client.subs.has("indexes")) wsSend(client.socket, { type: "indexes", data: indexData });
              }
            }
          })
      );
    }

    await Promise.allSettled(promises);
  }, BOARD_POLL_MS);
}

function stopBoardPoller() {
  if (boardPoller) { clearInterval(boardPoller); boardPoller = null; }
}

function handleBoardWsUpgrade(req, socket) {
  if (!wsHandshake(req, socket)) return;
  const client = { socket, subs: new Set() };
  boardWsClients.add(client);
  console.log(`[WS Board] ➕ connected (total: ${boardWsClients.size})`);
  if (boardWsClients.size === 1) startBoardPoller();

  let recvBuf = Buffer.alloc(0);

  async function handleSubscribe(sub) {
    client.subs.add(sub);
    if (sub === "indexes") {
      const results = await Promise.all(BOARD_INDEX_IDS.map(id => fetchSsiBoardIndex(id).then(d => [id, d])));
      const indexData = {};
      for (const [id, d] of results) if (d) indexData[id] = d;
      if (Object.keys(indexData).length) wsSend(socket, { type: "indexes", data: indexData });
    } else {
      // Gửi cache ngay nếu có
      if (boardTabCache.has(sub)) {
        wsSend(socket, { type: "board", tab: sub, data: boardTabCache.get(sub) });
      }
      // Fetch fresh và seed prevMap để poller tiếp theo có baseline diff
      fetchSsiBoardTab(sub).then(data => {
        if (!data) return;
        boardTabCache.set(sub, data);
        if (!boardTabPrevMap.has(sub)) {
          // Seed prevMap — poller tiếp theo sẽ diff từ đây
          const key = s => s.stockSymbol ?? s.code ?? "";
          boardTabPrevMap.set(sub, new Map(data.map(s => [key(s), s])));
        }
        wsSend(socket, { type: "board", tab: sub, data });
      });
    }
  }

  socket.on("data", (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    const { messages, remaining } = wsParseFrames(recvBuf);
    recvBuf = remaining;
    for (const msg of messages) {
      if (msg.type === "close") { socket.destroy(); return; }
      if (msg.type === "message" && msg.data) {
        const { sub, unsub } = msg.data;
        if (sub) handleSubscribe(sub);
        if (unsub) client.subs.delete(unsub);
      }
    }
  });

  function cleanup() {
    boardWsClients.delete(client);
    console.log(`[WS Board] ➖ disconnected (total: ${boardWsClients.size})`);
    if (boardWsClients.size === 0) stopBoardPoller();
  }
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === "/health") {
    return sendJSON(res, 200, { status: "ok", time: new Date().toISOString() });
  }

  if (pathname === "/analyze" && req.method === "GET") {
    const maPeriod = parseInt(parsed.query.ma) || 20;
    const result = await analyzeAll(TMP_DIR, { maPeriod });
    return sendJSON(res, result.error ? 400 : 200, result);
  }

  // ─── Detail analysis ───────────────────────────────────────────────────────
  if (pathname === "/analyze-detail" && req.method === "GET") {
    const symbol = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!symbol) return sendJSON(res, 400, { error: "Thiếu tham số symbol" });

    console.log(
      `\n[${new Date().toLocaleTimeString(
        "vi-VN"
      )}] 🔍 Phân tích chi tiết: ${symbol}`
    );
    try {
      const result = await analyzeDetail(TMP_DIR, symbol);
      return sendJSON(res, result.error ? 400 : 200, result);
    } catch (err) {
      console.error(`   ❌ Lỗi: ${err.message}`);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  if (pathname === "/download" && req.method === "GET") {
    return handleDownload(req, res, parsed.query);
  }

  // ─── Proxy MSH realtime price (msh-appdata.cafef.vn) ───────────────────────
  if (pathname === "/msh-price" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) return sendJSON(res, 400, { error: "Thiếu symbol" });
    try {
      const data = await fetchMshPriceData(sym);
      return sendJSON(res, 200, data);
    } catch (err) {
      return sendJSON(res, 502, { error: err.message });
    }
  }

  // ─── SSE stream: browser giữ 1 kết nối, server poll MSH mỗi 10s ─────────────
  if (pathname === "/msh-stream" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) {
      res.writeHead(400);
      res.end();
      return;
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
    return; // giữ kết nối mở
  }

  // ─── Proxy giá realtime từ CafeF (tránh CORS trên mobile) ──────────────────
  if (pathname === "/price" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym) return sendJSON(res, 400, { error: "Thiếu symbol" });
    const priceUrl = `https://cafef.vn/du-lieu/Ajax/PageNew/PriceRealTimeHeader.ashx?Symbol=${sym}`;
    try {
      const { buffer } = await fetchFromCafeF(priceUrl, sym);
      const json = JSON.parse(buffer.toString("utf8"));
      return sendJSON(res, 200, json);
    } catch (err) {
      return sendJSON(res, 502, { error: err.message });
    }
  }

  // Serve front.html tại /front.html, index.html tại /
  if (pathname === "/" || pathname === "/index.html") {
    const htmlPath = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      "public",
      "index.html"
    );
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end("index.html not found");
    }
    return;
  }
  if (pathname === "/front.html") {
    const htmlPath = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      "public",
      "front.html"
    );
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end("front.html not found");
    }
    return;
  }

  // ─── Watchlist — dùng chung watchlist.json ──────────────────────────────────
  if (pathname.startsWith("/watchlist")) {
    let body = {};
    if (req.method === "POST") body = await parseBody(req);

    if (pathname === "/watchlist" && req.method === "GET") {
      return sendJSON(res, 200, loadWatchlist());
    }
    if (pathname === "/watchlist/add" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym))
        return sendJSON(res, 400, { error: "Mã không hợp lệ" });
      const wl = loadWatchlist();
      if (!wl.symbols.includes(sym)) wl.symbols.push(sym);
      saveWatchlist(wl);
      console.log(`[Watchlist] ➕ ${sym} | tổng: ${wl.symbols.length} mã`);
      return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    }
    if (pathname === "/watchlist/remove" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      const wl = loadWatchlist();
      wl.symbols = wl.symbols.filter((s) => s !== sym);
      saveWatchlist(wl);
      console.log(`[Watchlist] ➖ ${sym} | còn: ${wl.symbols.length} mã`);
      return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    }
    if (pathname === "/watchlist/scan" && req.method === "GET") {
      const forceRefresh = parsed.query.refresh === "1";
      console.log(
        `\n[${new Date().toLocaleTimeString("vi-VN")}] 📡 Scan watchlist${
          forceRefresh ? " (force)" : ""
        }...`
      );
      try {
        const result = await scanWatchlist(forceRefresh);
        console.log(
          `   ✅ ${result.scanned} mã | ${result.alerts.length} alerts`
        );
        return sendJSON(res, 200, result);
      } catch (err) {
        console.error(`   ❌ ${err.message}`);
        return sendJSON(res, 500, { error: err.message });
      }
    }
  }

  // ─── Portfolio — quản lý vị thế đã mua ──────────────────────────────────────
  if (pathname.startsWith("/portfolio")) {
    let body = {};
    if (req.method === "POST") body = await parseBody(req);

    if (pathname === "/portfolio" && req.method === "GET") {
      return sendJSON(res, 200, loadPortfolio());
    }
    if (pathname === "/portfolio/add" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym))
        return sendJSON(res, 400, { error: "Mã không hợp lệ" });
      const qty = parseInt(body?.qty);
      const price = parseFloat(body?.price);
      const date = body?.date || new Date().toISOString().slice(0, 10);
      if (!qty || qty <= 0 || !price || price <= 0)
        return sendJSON(res, 400, {
          error: "Khối lượng hoặc giá không hợp lệ",
        });
      const pf = loadPortfolio();
      if (!pf[sym]) pf[sym] = [];
      pf[sym].push({ qty, price, date, id: Date.now() });
      savePortfolio(pf);
      console.log(
        `[Portfolio] ➕ ${sym} ${qty}@${price} | tổng lệnh: ${pf[sym].length}`
      );
      return sendJSON(res, 200, { ok: true, positions: pf[sym] });
    }
    if (pathname === "/portfolio/edit" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      const id = body?.id;
      const qty = parseInt(body?.qty);
      const price = parseFloat(body?.price);
      const date = body?.date;
      if (!sym || !id) return sendJSON(res, 400, { error: "Thiếu mã hoặc id" });
      if (!qty || qty <= 0 || !price || price <= 0)
        return sendJSON(res, 400, {
          error: "Khối lượng hoặc giá không hợp lệ",
        });
      const pf = loadPortfolio();
      if (pf[sym]) {
        const pos = pf[sym].find((p) => p.id === id);
        if (pos) {
          pos.qty = qty;
          pos.price = price;
          if (date) pos.date = date;
          savePortfolio(pf);
          console.log(`[Portfolio] ✏️ ${sym} id:${id} → ${qty}@${price}`);
          return sendJSON(res, 200, { ok: true, positions: pf[sym] });
        }
      }
      return sendJSON(res, 404, { error: "Không tìm thấy lệnh" });
    }
    if (pathname === "/portfolio/remove" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      const id = body?.id;
      const pf = loadPortfolio();
      if (pf[sym]) pf[sym] = pf[sym].filter((p) => p.id !== id);
      if (pf[sym] && !pf[sym].length) delete pf[sym];
      savePortfolio(pf);
      console.log(`[Portfolio] ➖ ${sym} id:${id}`);
      return sendJSON(res, 200, { ok: true, positions: pf[sym] || [] });
    }

    // ── Bán cổ phiếu (FIFO) ──────────────────────────────────────────────────
    if (pathname === "/portfolio/sell" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      if (!sym) return sendJSON(res, 400, { error: "Thiếu mã" });
      const sellQty = parseInt(body?.qty);
      const sellPrice = parseFloat(body?.price);
      const sellDate = body?.date || new Date().toISOString().slice(0, 10);
      if (!sellQty || sellQty <= 0 || !sellPrice || sellPrice <= 0)
        return sendJSON(res, 400, {
          error: "Khối lượng hoặc giá bán không hợp lệ",
        });

      const pf = loadPortfolio();
      if (!pf[sym] || !pf[sym].length)
        return sendJSON(res, 400, { error: `Không có vị thế ${sym}` });

      const totalQty = pf[sym].reduce((s, p) => s + p.qty, 0);
      if (sellQty > totalQty)
        return sendJSON(res, 400, { error: `Chỉ có ${totalQty} CP ${sym}` });

      // FIFO: consume from oldest positions first
      let remaining = sellQty;
      let totalBuyCost = 0;
      const hist = loadHistory();

      pf[sym] = pf[sym].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id - b.id
      );
      for (let i = 0; i < pf[sym].length && remaining > 0; i++) {
        const pos = pf[sym][i];
        const consumed = Math.min(pos.qty, remaining);
        totalBuyCost += consumed * pos.price;
        remaining -= consumed;
        pos.qty -= consumed;
      }
      // Remove exhausted positions
      pf[sym] = pf[sym].filter((p) => p.qty > 0);
      if (!pf[sym].length) delete pf[sym];
      savePortfolio(pf);

      // Record history entry
      const avgBuyPrice = totalBuyCost / sellQty;
      const pnl = (sellPrice - avgBuyPrice) * sellQty;
      const pnlPct =
        avgBuyPrice > 0 ? ((sellPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
      const entry = {
        id: Date.now(),
        symbol: sym,
        qty: sellQty,
        buyPrice: parseFloat(avgBuyPrice.toFixed(4)),
        sellPrice,
        sellDate,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
      };
      hist.unshift(entry);
      saveHistory(hist);
      console.log(
        `[Portfolio] 💰 SELL ${sym} ${sellQty}@${sellPrice} PnL:${pnl.toFixed(
          0
        )}`
      );
      return sendJSON(res, 200, { ok: true, entry, positions: pf[sym] || [] });
    }

    // ── Lịch sử giao dịch ────────────────────────────────────────────────────
    if (pathname === "/portfolio/history" && req.method === "GET") {
      const sym = (parsed.query?.symbol ?? "").toUpperCase().trim();
      let hist = loadHistory();
      if (sym) hist = hist.filter((h) => h.symbol === sym);
      return sendJSON(res, 200, hist);
    }
  }

  // ─── Symbols — list mã đã có data trong tmp/ ────────────────────────────────
  if (pathname === "/symbols" && req.method === "GET") {
    try {
      const histDir = path.join(BASE_DIR_ROOT, "database", "history");
      const files = fs.existsSync(histDir)
        ? fs
            .readdirSync(histDir)
            .filter((f) => /\.json$/i.test(f))
            .map((f) => f.replace(/\.json$/i, "").toUpperCase())
            .sort()
        : [];
      return sendJSON(res, 200, { symbols: files });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ─── API: Proxy iboard-query.ssi.com.vn ─────────────────────────────────────
  if (pathname === "/api/board") {
    const group = parsed.query.group; // VN30, HNX30, ...
    const exchange = parsed.query.exchange; // hose, hnx, upcom
    const indexId = parsed.query.index; // VNINDEX, VN30, HNXIndex, HNX30

    let targetUrl;
    if (indexId) {
      targetUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(
        indexId
      )}?hasHistory=false`;
    } else if (group) {
      targetUrl = `https://iboard-query.ssi.com.vn/stock/group/${encodeURIComponent(
        group
      )}`;
    } else if (exchange) {
      targetUrl = `https://iboard-query.ssi.com.vn/stock/exchange/${encodeURIComponent(
        exchange
      )}`;
    } else {
      return sendJSON(res, 400, { error: "Cần group, exchange hoặc index" });
    }

    return new Promise((resolve) => {
      https
        .get(
          targetUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              Origin: "https://iboard.ssi.com.vn",
              Referer: "https://iboard.ssi.com.vn/",
              Accept: "application/json",
            },
          },
          (rsp) => {
            const chunks = [];
            rsp.on("data", (c) => chunks.push(c));
            rsp.on("end", () => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(Buffer.concat(chunks));
              resolve();
            });
            rsp.on("error", (e) => {
              sendJSON(res, 502, { error: e.message });
              resolve();
            });
          }
        )
        .on("error", (e) => {
          sendJSON(res, 502, { error: e.message });
          resolve();
        });
    });
  }

  // ─── API: SSI Token management ───────────────────────────────────────────────
  if (pathname === "/api/ssi-token" && req.method === "GET") {
    return sendJSON(res, 200, {
      hasToken: !!ssiToken,
      savedAt: ssiToken
        ? (() => {
            try {
              return JSON.parse(fs.readFileSync(SSI_TOKEN_FILE, "utf8"))
                .savedAt;
            } catch {
              return null;
            }
          })()
        : null,
    });
  }
  if (pathname === "/api/ssi-token" && req.method === "POST") {
    const body = await parseBody(req);
    const token = (body?.token ?? "").trim();
    if (!token) return sendJSON(res, 400, { error: "Thiếu token" });
    saveSsiToken(token);
    return sendJSON(res, 200, { ok: true });
  }

  // ─── API: Fetch & save historical price (SSI nếu có token, fallback CafeF) ──
  if (pathname === "/api/history-fetch" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    const days = parseInt(parsed.query.days) || 420;
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym))
      return sendJSON(res, 400, { error: "Mã không hợp lệ" });

    // ── Kiểm tra cache còn mới không (stale_hours=24 → bỏ qua fetch nếu < 24h) ─
    const staleHours = parseFloat(parsed.query.stale_hours) || 0;
    if (staleHours > 0) {
      const fPath = path.join(BASE_DIR_ROOT, "database", "history", `${sym}.json`);
      if (fs.existsSync(fPath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(fPath, "utf8"));
          const ageHours = (Date.now() - new Date(cached.updated).getTime()) / 3_600_000;
          if (ageHours < staleHours) {
            return sendJSON(res, 200, {
              ok: true, symbol: sym,
              count: cached.records?.length || 0,
              source: "cache", cached: true, ageHours: parseFloat(ageHours.toFixed(1)),
            });
          }
        } catch { /* cache corrupt, refetch */ }
      }
    }

    // ── SSI statistics API (không cần token) ─────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86400;
    const ssiUrl = `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=1D&symbol=${sym}&from=${from}&to=${now}`;

    return new Promise((resolve) => {
      https
        .get(
          ssiUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              Origin: "https://iboard.ssi.com.vn",
              Referer: "https://iboard.ssi.com.vn/",
              Accept: "application/json",
            },
          },
          (rsp) => {
            const chunks = [];
            rsp.on("data", (c) => chunks.push(c));
            rsp.on("end", async () => {
              try {
                const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const d = json?.data;
                if (
                  json.code === "SUCCESS" &&
                  Array.isArray(d?.t) &&
                  d.t.length > 0
                ) {
                  const records = d.t
                    .map((ts, i) => ({
                      date: new Date(ts * 1000).toISOString().slice(0, 10),
                      open: d.o[i],
                      high: d.h[i],
                      low: d.l[i],
                      close: d.c[i],
                      volume: d.v[i],
                    }))
                    .sort((a, b) => a.date.localeCompare(b.date));

                  const histDir = path.join(
                    BASE_DIR_ROOT,
                    "database",
                    "history"
                  );
                  fs.mkdirSync(histDir, { recursive: true });
                  fs.writeFileSync(
                    path.join(histDir, `${sym}.json`),
                    JSON.stringify(
                      {
                        symbol: sym,
                        source: "ssi",
                        updated: new Date().toISOString(),
                        records,
                      },
                      null,
                      2
                    )
                  );
                  console.log(
                    `[History/SSI] ✅ ${sym}: ${records.length} phiên`
                  );
                  sendJSON(res, 200, {
                    ok: true,
                    symbol: sym,
                    count: records.length,
                    source: "ssi",
                  });
                  return resolve();
                }
                console.warn(
                  `[History/SSI] ⚠️ ${sym}: no data → fallback CafeF`
                );
              } catch (e) {
                console.warn(
                  `[History/SSI] Parse error ${sym}: ${e.message} → fallback CafeF`
                );
              }
              await fetchHistoryCafeF(sym, days, res);
              resolve();
            });
            rsp.on("error", async () => {
              await fetchHistoryCafeF(sym, days, res);
              resolve();
            });
          }
        )
        .on("error", async () => {
          await fetchHistoryCafeF(sym, days, res);
          resolve();
        });
    });
  }

  // ─── API: Sectors — đọc database/ssi_sectors.csv (ICB SSI) ─────────────────
  if (pathname === "/api/sectors") {
    const BASE_DIR = path.dirname(url.fileURLToPath(import.meta.url));
    const ssiPath = path.join(BASE_DIR, "database", "ssi_sectors.csv");
    const stocksPath = path.join(BASE_DIR, "database", "stocks.csv");

    if (!fs.existsSync(ssiPath))
      return sendJSON(res, 404, {
        error:
          "ssi_sectors.csv not found. Chạy: node batch/fetch_ssi_sectors.mjs",
      });

    // Helper: parse một dòng CSV đơn giản (hỗ trợ field có dấu ngoặc kép)
    function parseCSVLine(line) {
      const cols = [];
      let cur = "",
        inQ = false;
      for (const ch of line) {
        if (ch === '"') {
          inQ = !inQ;
          continue;
        }
        if (ch === "," && !inQ) {
          cols.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      cols.push(cur);
      return cols;
    }

    // Bước 1: Đọc stocks.csv → symbol → san (chỉ cần sàn giao dịch, title đã có trong ssi_sectors.csv)
    const sanInfo = {}; // sym → san
    if (fs.existsSync(stocksPath)) {
      const sLines = fs
        .readFileSync(stocksPath, "utf8")
        .replace(/^\uFEFF/, "")
        .split("\n");
      const sHdr = sLines[0].split(",");
      const iSym = sHdr.indexOf("Symbol");
      const iSan = sHdr.indexOf("Sàn giao dịch");
      for (const line of sLines.slice(1)) {
        if (!line.trim()) continue;
        const c = parseCSVLine(line);
        const sym = c[iSym]?.trim() ?? "";
        if (!sym) continue;
        sanInfo[sym] = c[iSan]?.trim() ?? "";
      }
    }

    // Bước 2: Đọc ssi_sectors.csv → nhóm theo ICB code
    // Columns: STT, Symbol, ICB Code, Ngành (VI), Ngành (EN), Tên công ty, Sàn, Hủy niêm yết
    const ssiLines = fs.readFileSync(ssiPath, "utf8").split("\n");
    const sectors = new Map(); // icbCode → { name, nameEn, icbCode, stocks[] }

    for (const line of ssiLines.slice(1)) {
      if (!line.trim()) continue;
      const c = parseCSVLine(line);
      const symbol = c[1]?.trim() ?? "";
      const icbCode = c[2]?.trim() ?? "";
      const nameVi = c[3]?.trim() ?? "";
      const nameEn = c[4]?.trim() ?? "";
      const title = c[5]?.trim() ?? "";
      const san = c[6]?.trim() ?? "";
      const delisted = c[7]?.trim() ?? "";
      if (!symbol || !icbCode) continue;
      if (delisted === "Y") continue; // bỏ qua mã đã hủy niêm yết

      if (!sectors.has(icbCode)) {
        sectors.set(icbCode, { name: nameVi, nameEn, icbCode, stocks: [] });
      }
      sectors.get(icbCode).stocks.push({
        symbol,
        title,
        san: san || (sanInfo[symbol] ?? ""),
        nganh: nameVi,
      });
    }

    const result = [...sectors.values()].map((sec) => ({
      name: sec.name,
      nameEn: sec.nameEn,
      icbCode: sec.icbCode,
      count: sec.stocks.length,
      stocks: sec.stocks,
    }));

    return sendJSON(res, 200, result);
  }

  // ─── API: All-sectors comparison ─────────────────────────────────────────────
  if (pathname === "/api/all-sectors-analysis" && req.method === "GET") {
    const BASE_DIR = path.dirname(url.fileURLToPath(import.meta.url));
    const ssiPath = path.join(BASE_DIR, "database", "ssi_sectors.csv");
    if (!fs.existsSync(ssiPath))
      return sendJSON(res, 404, { error: "ssi_sectors.csv not found" });

    function parseCSVLine2(line) {
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
        cur += ch;
      }
      cols.push(cur);
      return cols;
    }

    const ssiLines = fs.readFileSync(ssiPath, "utf8").split("\n");
    const sectorsMap = new Map();
    for (const line of ssiLines.slice(1)) {
      if (!line.trim()) continue;
      const c = parseCSVLine2(line);
      const symbol = c[1]?.trim() ?? "";
      const icbCode = c[2]?.trim() ?? "";
      const nameVi = c[3]?.trim() ?? "";
      const delisted = c[7]?.trim() ?? "";
      if (!symbol || !icbCode || delisted === "Y") continue;
      if (!sectorsMap.has(icbCode))
        sectorsMap.set(icbCode, { name: nameVi, icbCode, symbols: [] });
      sectorsMap.get(icbCode).symbols.push(symbol);
    }

    const histDir = path.join(BASE_DIR, "database", "history");
    // 3 request cho toàn thị trường thay vì N request riêng lẻ
    const snapshot = await fetchMarketSnapshot();
    const results = [];

    for (const [icbCode, sector] of sectorsMap) {
      let up = 0, down = 0, flat = 0;
      let totalChange = 0, counted = 0;
      let aboveMA50 = 0, withMA50 = 0;
      let aboveMA200 = 0, withMA200 = 0;

      for (const sym of sector.symbols) {
        const snap = snapshot[sym] ?? null;
        const fPath = path.join(histDir, `${sym}.json`);
        const hasHistory = fs.existsSync(fPath);
        if (!snap && !hasHistory) continue;

        try {
          let ch = null;
          if (snap) {
            ch = snap.changePct;
          } else if (hasHistory) {
            const data = JSON.parse(fs.readFileSync(fPath, "utf8"));
            const recs = (data.records || []).filter((r) => r.close > 0);
            if (recs.length >= 2) {
              const last = recs[recs.length - 1];
              const prev = recs[recs.length - 2];
              ch = prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
            }
          }
          if (ch === null) continue;
          if (ch > 0) up++; else if (ch < 0) down++; else flat++;
          totalChange += ch;
          counted++;

          // MA chỉ tính từ history
          if (hasHistory) {
            const data = JSON.parse(fs.readFileSync(fPath, "utf8"));
            const recs = (data.records || []).filter((r) => r.close > 0);
            const closes = recs.map((r) => r.close);
            const last = closes[closes.length - 1];
            if (closes.length >= 50) {
              const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
              withMA50++; if (last > ma50) aboveMA50++;
            }
            if (closes.length >= 200) {
              const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
              withMA200++; if (last > ma200) aboveMA200++;
            }
          }
        } catch { /* skip */ }
      }

      if (counted === 0) continue;
      const avgChange1D = parseFloat((totalChange / counted).toFixed(2));
      const score = Math.round(
        (up / counted) * 40 +
        (withMA50 > 0 ? (aboveMA50 / withMA50) * 30 : 0) +
        (withMA200 > 0 ? (aboveMA200 / withMA200) * 30 : 0)
      );
      results.push({
        name: sector.name,
        icbCode,
        total: sector.symbols.length,
        withHistory: counted,
        score,
        avgChange1D,
        breadth: { up, down, flat },
      });
    }

    results.sort((a, b) => b.score - a.score);
    return sendJSON(res, 200, results);
  }

  // ─── API: Sector analysis — compute metrics from cached history ──────────────
  if (pathname === "/api/sector-analysis" && req.method === "GET") {
    const symsParam = parsed.query.symbols || "";
    const symbols = symsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{1,10}$/.test(s));
    if (!symbols.length)
      return sendJSON(res, 400, { error: "Thiếu symbols" });

    const histDir = path.join(BASE_DIR_ROOT, "database", "history");
    // Fetch snapshot & scan history đồng thời
    const snapshot = await fetchMarketSnapshot();
    const stocks = [];

    for (const sym of symbols) {
      const snap = snapshot[sym] ?? null;
      const fPath = path.join(histDir, `${sym}.json`);
      const hasHistory = fs.existsSync(fPath);

      // Cần ít nhất snapshot hoặc history
      if (!snap && !hasHistory) continue;

      try {
        let change1D = snap ? snap.changePct : null;
        let todayVolume = snap ? snap.volume : null;
        let change1W = null, change1M = null, change3M = null;
        let volRatio = null, aboveMA50 = null, aboveMA200 = null;
        let close = snap ? snap.price : null;
        let lastDate = null;

        if (hasHistory) {
          const data = JSON.parse(fs.readFileSync(fPath, "utf8"));
          const recs = (data.records || []).filter((r) => r.close > 0);
          if (recs.length >= 2) {
            const n = recs.length;
            const last = recs[n - 1];
            lastDate = last.date;
            // Ưu tiên snapshot cho change1D (data mới nhất)
            if (change1D === null) {
              const prev = recs[n - 2];
              change1D = prev.close > 0
                ? parseFloat((((last.close - prev.close) / prev.close) * 100).toFixed(2))
                : null;
            }
            if (close === null) close = last.close;

            const pct = (base, cur) =>
              base > 0 ? parseFloat((((cur - base) / base) * 100).toFixed(2)) : null;
            change1W = pct(recs[Math.max(0, n - 6)].close, last.close);
            change1M = pct(recs[Math.max(0, n - 22)].close, last.close);
            change3M = pct(recs[Math.max(0, n - 66)].close, last.close);

            const histVols = recs.slice(-21, -1).map((r) => r.volume || 0);
            const volMA20 = histVols.length
              ? histVols.reduce((s, v) => s + v, 0) / histVols.length
              : 0;
            // Dùng volume hôm nay từ snapshot nếu có (mới hơn), fallback về history
            const vol = todayVolume ?? last.volume;
            volRatio = volMA20 > 0 ? parseFloat((vol / volMA20).toFixed(2)) : null;

            const closes = recs.map((r) => r.close);
            const sma = (period) =>
              closes.length >= period
                ? closes.slice(-period).reduce((a, b) => a + b, 0) / period
                : null;
            const ma50 = sma(50);
            const ma200 = sma(200);
            aboveMA50 = ma50 !== null ? last.close > ma50 : null;
            aboveMA200 = ma200 !== null ? last.close > ma200 : null;
          }
        }

        if (change1D === null) continue; // không có data gì hết
        stocks.push({
          symbol: sym,
          close,
          volume: todayVolume,
          lastDate,
          fromSnapshot: !!snap,
          change1D,
          change1W,
          change1M,
          change3M,
          volRatio,
          aboveMA50,
          aboveMA200,
        });
      } catch { /* skip */ }
    }

    const n = stocks.length;
    if (n === 0) {
      return sendJSON(res, 200, {
        total: symbols.length,
        withHistory: 0,
        noData: symbols.length,
        score: 0,
        breadth: { up: 0, down: 0, flat: 0 },
        avgChange1D: 0,
        technical: { aboveMA50: 0, totalMA50: 0, aboveMA200: 0, totalMA200: 0 },
        topUp: [], topDown: [], topVolume: [],
        momentum: { top1W: [], top1M: [], top3M: [] },
      });
    }

    const up = stocks.filter((s) => s.change1D > 0).length;
    const down = stocks.filter((s) => s.change1D < 0).length;
    const flat = stocks.filter((s) => s.change1D === 0).length;
    const avgChange1D = parseFloat(
      (stocks.reduce((s, r) => s + (r.change1D || 0), 0) / n).toFixed(2)
    );
    const withMA50 = stocks.filter((s) => s.aboveMA50 !== null);
    const withMA200 = stocks.filter((s) => s.aboveMA200 !== null);
    const aboveMA50 = withMA50.filter((s) => s.aboveMA50).length;
    const aboveMA200 = withMA200.filter((s) => s.aboveMA200).length;

    const top5 = (arr, key, asc = false) =>
      [...arr]
        .filter((s) => s[key] !== null)
        .sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]))
        .slice(0, 5)
        .map((s) => ({ symbol: s.symbol, value: s[key], close: s.close }));

    const score = Math.round(
      (up / n) * 40 +
      (withMA50.length ? (aboveMA50 / withMA50.length) * 30 : 0) +
      (withMA200.length ? (aboveMA200 / withMA200.length) * 30 : 0)
    );

    return sendJSON(res, 200, {
      total: symbols.length,
      withHistory: n,
      noData: symbols.length - n,
      score,
      breadth: { up, down, flat },
      avgChange1D,
      technical: {
        aboveMA50,
        totalMA50: withMA50.length,
        aboveMA200,
        totalMA200: withMA200.length,
      },
      topUp: top5(stocks, "change1D"),
      topDown: top5(stocks, "change1D", true),
      topVolume: top5(stocks.filter((s) => s.volRatio !== null), "volRatio"),
      momentum: {
        top1W: top5(stocks, "change1W"),
        top1M: top5(stocks, "change1M"),
        top3M: top5(stocks, "change3M"),
      },
    });
  }

  // ─── API: Index intraday chart (SSI hasHistory=true) ─────────────────────────
  if (pathname === "/api/index-intraday") {
    const symbol = (parsed.query.symbol ?? "").trim();
    if (!symbol) return sendJSON(res, 400, { error: "Thiếu symbol" });
    const ssiUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(symbol)}?hasHistory=true`;
    return new Promise((resolve) => {
      https.get(ssiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Origin: "https://iboard.ssi.com.vn",
          Referer: "https://iboard.ssi.com.vn/",
          Accept: "application/json",
        },
      }, (rsp) => {
        const chunks = [];
        rsp.on("data", c => chunks.push(c));
        rsp.on("end", () => {
          try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(Buffer.concat(chunks));
          } catch { sendJSON(res, 502, { error: "error" }); }
          resolve();
        });
        rsp.on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(); });
      }).on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(); });
    });
  }

  const staticFiles = {
    "/css/style.css": {
      file: "public/css/style.css",
      mime: "text/css; charset=utf-8",
    },
    "/js/app.js": {
      file: "public/js/app.js",
      mime: "application/javascript; charset=utf-8",
    },
    "/surge.html": {
      file: "public/surge.html",
      mime: "text/html; charset=utf-8",
    },
    "/detail.html": {
      file: "public/detail.html",
      mime: "text/html; charset=utf-8",
    },
    "/watchlist.html": {
      file: "public/watchlist.html",
      mime: "text/html; charset=utf-8",
    },
    "/watcher.html": {
      file: "public/watcher.html",
      mime: "text/html; charset=utf-8",
    },
    "/portfolio.html": {
      file: "public/portfolio.html",
      mime: "text/html; charset=utf-8",
    },
    "/css/portfolio.css": {
      file: "public/css/portfolio.css",
      mime: "text/css; charset=utf-8",
    },
    "/js/portfolio.js": {
      file: "public/js/portfolio.js",
      mime: "application/javascript; charset=utf-8",
    },
    "/stocks.csv": {
      file: "public/stocks.csv",
      mime: "text/csv; charset=utf-8",
    },
    "/sector.html": {
      file: "public/sector.html",
      mime: "text/html; charset=utf-8",
    },
    "/sector-detail.html": {
      file: "public/sector-detail.html",
      mime: "text/html; charset=utf-8",
    },
    "/price-board.html": {
      file: "public/price-board.html",
      mime: "text/html; charset=utf-8",
    },
  };
  if (staticFiles[pathname]) {
    const { file, mime } = staticFiles[pathname];
    const filePath = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      file
    );
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end(`${file} not found`);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── WebSocket upgrade handler ────────────────────────────────────────────────
server.on("upgrade", (req, socket) => {
  const { pathname } = url.parse(req.url);
  if (pathname === "/ws/board") {
    handleBoardWsUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIp =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i.family === "IPv4" && !i.internal)?.address ?? "?";
  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  CafeF Stock Downloader Server               ║`);
  console.log(`║  Local:   http://localhost:${PORT}               ║`);
  console.log(`║  Network: http://${lanIp}:${PORT}          ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log("\nEndpoints:");
  console.log(`  GET /              → Giao diện HTML (front.html)`);
  console.log(`  GET /surge.html    → Quét khối lượng đột biến`);
  console.log(`  GET /detail.html?s=DGC → Phân tích chi tiết 1 mã`);
  console.log(`  GET /download?symbol=DPM&start=2025-01-01&end=2026-03-13`);
  console.log(`  GET /health        → Health check`);
  console.log(`  GET /watchlist     → Lấy watchlist + alerts`);
  console.log(`  POST /watchlist/add    { symbol }  → Thêm mã`);
  console.log(`  POST /watchlist/remove { symbol }  → Xóa mã`);
  console.log(`  GET /watchlist/scan    → Quét tín hiệu toàn bộ watchlist`);
  console.log(`  GET /watchlist/scan?refresh=1 → Force scan (bỏ qua cache)`);
  console.log(`  GET /symbols                  → List mã đã có data\n`);
});
