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
import { analyzeAll, analyzeDetail, scanWatchlist, parseBody, loadWatchlist, saveWatchlist, loadPortfolio, savePortfolio, loadHistory, saveHistory } from "./analyze.mjs";

const PORT = process.env.PORT || 3000;
const TMP_DIR = "tmp";

// ─── SSE realtime: SignalR trước, fallback poll MSH nếu 10s không có data ─────
const sseClients    = new Map(); // sym → Set<res>
const ssePriceCache = new Map(); // sym → { data, ts }
const symState      = new Map(); // sym → { ws, pingTimer, fallbackTimer, pollTimer, mode:'signalr'|'poll' }

const SIGNALR_HUB = "wss://realtime.cafef.vn/hub/priceshub";
const SIGNALR_RS  = "\x1e";
const FALLBACK_MS = 10_000; // chờ 10s, nếu SignalR không gửi data thì poll

function parseMshPrice(v) {
  if (!v) return null;
  const n = x => x != null ? parseFloat(x) : null;
  const price = n(v.price ?? v.Price);
  const ref   = n(v.refPrice ?? v.refprice ?? v.RefPrice);
  const change    = price != null && ref != null ? parseFloat((price - ref).toFixed(2)) : null;
  const changePct = price != null && ref ? parseFloat(((price - ref) / ref * 100).toFixed(2)) : null;
  return { price, change, changePct, ref,
    open: n(v.openPrice), high: n(v.highPrice), low: n(v.lowPrice), volume: n(v.volume) };
}

function sseBroadcast(sym, data) {
  const clients = sseClients.get(sym);
  if (!clients?.size) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
  ssePriceCache.set(sym, { data, ts: Date.now() });
}

async function fetchMshPriceData(sym) {
  const mshUrl = `https://msh-appdata.cafef.vn/rest-api/api/v1/Watchlists/${sym}/price`;
  return new Promise((resolve, reject) => {
    https.get(mshUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://cafef.vn",
        "Referer": "https://cafef.vn/",
      }
    }, (rsp) => {
      const chunks = [];
      rsp.on("data", c => chunks.push(c));
      rsp.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Invalid JSON from MSH")); }
      });
      rsp.on("error", reject);
    }).on("error", reject);
  });
}

async function doPollOnce(sym) {
  try {
    const json = await fetchMshPriceData(sym);
    const v = json?.data?.value;
    if (!v) return;
    const data = parseMshPrice(v);
    if (data?.price) { sseBroadcast(sym, data); console.log(`[Poll] ✅ ${sym}: ${data.price}`); }
  } catch (err) {
    console.error(`[Poll] Error ${sym}:`, err.message);
  }
}

function startPollFallback(sym) {
  const st = symState.get(sym);
  if (!st || st.pollDone) return;
  st.pollDone = true;
  st.mode = 'poll';
  console.log(`[Poll] ▶ Fallback ${sym} — poll 1 lần (SignalR không có data)`);
  doPollOnce(sym);
}

function startSignalRForSym(sym) {
  if (symState.has(sym)) return;
  console.log(`[SignalR] ▶ Connect ${sym}`);
  const st = { ws: null, pingTimer: null, fallbackTimer: null, pollDone: false, mode: 'signalr' };
  symState.set(sym, st);

  // Nếu 10s không nhận được data từ SignalR → fallback sang poll
  st.fallbackTimer = setTimeout(() => {
    st.fallbackTimer = null;
    if (st.mode === 'signalr') startPollFallback(sym);
  }, FALLBACK_MS);

  const ws = new WebSocket(SIGNALR_HUB);
  st.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + SIGNALR_RS);
  });

  ws.addEventListener("message", (event) => {
    const raw   = typeof event.data === "string" ? event.data : event.data.toString();
    const parts = raw.split(SIGNALR_RS).filter(s => s.trim());
    for (const part of parts) {
      try {
        const msg = JSON.parse(part);
        if (!st.pingTimer) {
          // Handshake xong → join channel
          ws.send(JSON.stringify({ type: 1, target: "JoinChannel", arguments: [sym], invocationId: "0" }) + SIGNALR_RS);
          st.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 6 }) + SIGNALR_RS);
          }, 15_000);
          console.log(`[SignalR] ✅ Joined ${sym}`);
        }
        if (msg.type === 1 && msg.target === "RealtimePrice") {
          const data = parseMshPrice(msg.arguments?.[0]);
          if (data?.price) {
            if (st.fallbackTimer) { clearTimeout(st.fallbackTimer); st.fallbackTimer = null; }
            st.mode = 'signalr';
            sseBroadcast(sym, data);
          }
        }
      } catch {}
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(st.pingTimer); st.pingTimer = null;
    clearTimeout(st.fallbackTimer); st.fallbackTimer = null;
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
  try { st.ws?.close(); } catch {}
  symState.delete(sym);
  console.log(`[SignalR] ⏹ Stop ${sym}`);
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

    console.log(`\n[${new Date().toLocaleTimeString("vi-VN")}] 🔍 Phân tích chi tiết: ${symbol}`);
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
    if (!sym) { res.writeHead(400); res.end(); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
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
      if (clients) { clients.delete(res); if (!clients.size) { sseClients.delete(sym); stopSignalRForSym(sym); } }
      console.log(`[SSE] ➖ ${sym} (clients: ${sseClients.get(sym)?.size ?? 0})`);
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
      "public", "index.html"
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
      "public", "front.html"
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
      wl.symbols = wl.symbols.filter(s => s !== sym);
      saveWatchlist(wl);
      console.log(`[Watchlist] ➖ ${sym} | còn: ${wl.symbols.length} mã`);
      return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    }
    if (pathname === "/watchlist/scan" && req.method === "GET") {
      const forceRefresh = parsed.query.refresh === "1";
      console.log(`\n[${new Date().toLocaleTimeString("vi-VN")}] 📡 Scan watchlist${forceRefresh ? " (force)" : ""}...`);
      try {
        const result = await scanWatchlist(forceRefresh);
        console.log(`   ✅ ${result.scanned} mã | ${result.alerts.length} alerts`);
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
        return sendJSON(res, 400, { error: "Khối lượng hoặc giá không hợp lệ" });
      const pf = loadPortfolio();
      if (!pf[sym]) pf[sym] = [];
      pf[sym].push({ qty, price, date, id: Date.now() });
      savePortfolio(pf);
      console.log(`[Portfolio] ➕ ${sym} ${qty}@${price} | tổng lệnh: ${pf[sym].length}`);
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
        return sendJSON(res, 400, { error: "Khối lượng hoặc giá không hợp lệ" });
      const pf = loadPortfolio();
      if (pf[sym]) {
        const pos = pf[sym].find(p => p.id === id);
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
      if (pf[sym]) pf[sym] = pf[sym].filter(p => p.id !== id);
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
        return sendJSON(res, 400, { error: "Khối lượng hoặc giá bán không hợp lệ" });

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

      pf[sym] = pf[sym].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      for (let i = 0; i < pf[sym].length && remaining > 0; i++) {
        const pos = pf[sym][i];
        const consumed = Math.min(pos.qty, remaining);
        totalBuyCost += consumed * pos.price;
        remaining -= consumed;
        pos.qty -= consumed;
      }
      // Remove exhausted positions
      pf[sym] = pf[sym].filter(p => p.qty > 0);
      if (!pf[sym].length) delete pf[sym];
      savePortfolio(pf);

      // Record history entry
      const avgBuyPrice = totalBuyCost / sellQty;
      const pnl = (sellPrice - avgBuyPrice) * sellQty;
      const pnlPct = avgBuyPrice > 0 ? ((sellPrice - avgBuyPrice) / avgBuyPrice * 100) : 0;
      const entry = {
        id: Date.now(),
        symbol: sym,
        qty: sellQty,
        buyPrice: parseFloat(avgBuyPrice.toFixed(4)),
        sellPrice,
        sellDate,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2))
      };
      hist.unshift(entry);
      saveHistory(hist);
      console.log(`[Portfolio] 💰 SELL ${sym} ${sellQty}@${sellPrice} PnL:${pnl.toFixed(0)}`);
      return sendJSON(res, 200, { ok: true, entry, positions: pf[sym] || [] });
    }

    // ── Lịch sử giao dịch ────────────────────────────────────────────────────
    if (pathname === "/portfolio/history" && req.method === "GET") {
      const sym = ((parsed.query?.symbol) ?? "").toUpperCase().trim();
      let hist = loadHistory();
      if (sym) hist = hist.filter(h => h.symbol === sym);
      return sendJSON(res, 200, hist);
    }
  }

  // ─── Symbols — list mã đã có data trong tmp/ ────────────────────────────────
  if (pathname === "/symbols" && req.method === "GET") {
    try {
      const files = fs.existsSync(TMP_DIR)
        ? fs.readdirSync(TMP_DIR).filter(f => /\.xlsx$/i.test(f) && f !== "VNINDEX.xlsx")
            .map(f => f.replace(/\.xlsx$/i,"").toUpperCase()).sort()
        : [];
      return sendJSON(res, 200, { symbols: files });
    } catch(e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ─── API: Sectors — đọc database/stocks.csv và nhóm ngành ─────────────────
  if (pathname === "/api/sectors") {
    const BASE_DIR = path.dirname(url.fileURLToPath(import.meta.url));
    const csvPath = path.join(BASE_DIR, "database", "stocks.csv");
    if (!fs.existsSync(csvPath)) return sendJSON(res, 404, { error: "stocks.csv not found" });

    // Bảng nhóm ngành: key = tên hiển thị, value = mảng các giá trị gốc thuộc nhóm đó
    const SECTOR_MAP = {
      "Ngân hàng":               ["Ngân hàng thương mại"],
      "Tài chính":               ["Tài chính","Công ty Tài chính","Công ty đầu tư tài chính"],
      "Chứng khoán & Quỹ":       ["Công ty Chứng khoán","Chứng khoán và Đầu tư","Chứng chỉ Quỹ","Quản lý quỹ"],
      "Bảo hiểm":                ["Bảo hiểm","Bảo hiểm hỗn hợp","Bảo hiểm phi nhân thọ"],
      "Bất động sản":            ["Bất động sản","Bất động sản du lịch","Bất động sản và Xây dựng","Phát triển bất động sản","Môi giới và quản lý bất động sản","Môi giới và quản lý bất động sản; Lương thực; Dược phẩm; Môi giới và quản lý bất động sản","Khu công nghiệp"],
      "Xây dựng":                ["Xây dựng","Xây dựng chuyên biệt","Xây dựng hạ tầng giao thông","Phát triển Hạ tầng giao thông"],
      "Vật liệu xây dựng":       ["Vật liệu xây dựng","VLXD tổng hợp","Xi măng","Bê tông thương phẩm","Gạch"],
      "Điện năng":               ["Điện năng","Nhiệt điện","Thủy điện","Sản xuất điện năng","Phát triển điện năng","Truyền tải và phân phối điện năng"],
      "Dầu khí & Năng lượng":    ["Dầu khí","Hóa dầu","Dịch vụ khai thác Dầu khí","Tổ hợp lọc hóa dầu","Vận tải và kho bãi dầu khí","Kinh doanh gas và nhiên liệu","Kinh doanh sản phẩm khí đốt","Kinh doanh xăng dầu"],
      "Thực phẩm & Đồ uống":     ["Thực phẩm","Chế biến thực phẩm","Bánh kẹo","Lương thực","Sản phẩm sữa","Bia rượu","Nước giải khát","Mía đường","Cà phê","Thuốc lá"],
      "Thủy sản":                ["Thủy sản","Chế biến thủy sản","Chế biến cá tra","Chế biến tôm"],
      "Nông nghiệp & Phân bón":  ["Nông nghiệp","Kinh doanh nông sản","Sản phẩm nông nghiệp tổng hợp","Vật tư nông nghiệp tổng hợp","Hóa chất nông nghiệp","Phân bón","Thức ăn chăn nuôi","Cao su tự nhiên","Lâm nghiệp"],
      "Công nghệ thông tin":     ["Phần mềm","Phần mềm và dịch vụ","Dịch vụ công nghệ thông tin","Gia công phần mềm; Ðiện tự động; Giao thông Thông minh","Thiết bị và công nghệ phần cứng","Hạ tầng viễn thông"],
      "Điện tử & Thiết bị":      ["Thiết bị điện tử","Điện tử gia dụng","Thiết bị điện","Dây và cáp"],
      "Dược phẩm & Y tế":        ["Dược phẩm","Kinh doanh dược phẩm","Thiết bị y tế","Bệnh viện"],
      "Thép & Kim loại":         ["Sản xuất Thép","Chế tạo kết cấu thép","Kim loại và khai khoáng","Kinh doanh thép và vật tư"],
      "Khai khoáng & Than":      ["Than","Khai khoáng và luyện kim"],
      "Hóa chất":                ["Hóa chất","Hóa chất chuyên biệt"],
      "Dệt may":                 ["Dệt may"],
      "Nhựa & Bao bì":           ["Nhựa","Bao bì","Bao bì nhựa"],
      "Vận tải & Logistics":     ["Vận tải đường bộ","Giao nhận - tiếp vận","Logistics","Giao thông vận tải","Hàng hải","Hàng không","Dịch vụ sân bay","Vận hành cảng biển","Bưu chính - chuyển phát nhanh","Taxi và vận tải hành khách","Bến xe"],
      "Cơ khí & Sản xuất":       ["Cơ khí","Cơ khí Lắp máy","Gia công Cơ khí","Chế tạo máy","Sản xuất","Tổ hợp công nghiệp"],
      "Ô tô & Phụ tùng":         ["Ô tô và Phụ tùng","Phụ tùng ô tô","Kinh doanh ô tô","Săm lốp"],
      "Bán lẻ & Thương mại":     ["Thương mại","Thương mại tổng hợp","Kinh doanh hàng điện tử","Kinh doanh Vàng bạc đá quý"],
      "Du lịch & Giải trí":      ["Du lịch","Khách sạn","Phim ảnh và Giải trí"],
      "Giáo dục & Sách":         ["Giáo dục và dịch vụ chuyên nghiệp","Sách và thiết bị giáo dục","Sách và In ấn"],
      "Nội thất & Gia dụng":     ["Nội thất","Sản xuất Đồ gia dụng","Sản phẩm gia dụng","Giấy","Văn phòng phẩm"],
      "Quảng cáo & Truyền thông":["Quảng cáo"],
      "Dịch vụ & Tiện ích":      ["Dịch vụ","Dịch vụ công nghiệp","Dịch vụ tổng hợp","Tư vấn","Cấp thoát nước"],
      "Đa ngành":                ["Tập đoàn đa ngành","Hàng công nghiệp","Hàng tiêu dùng","Nguyên vật liệu","Nguyên vật liệu tổng hợp","Công nghiệp"],
    };

    // Tạo reverse map: rawNganh → groupName
    const reverseMap = {};
    for (const [group, raws] of Object.entries(SECTOR_MAP)) {
      for (const raw of raws) reverseMap[raw] = group;
    }

    const lines = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "").split("\n");
    const headers = lines[0].split(",");
    const iSymbol = headers.indexOf("Symbol");
    const iTitle  = headers.indexOf("Title");
    const iSan    = headers.indexOf("Sàn giao dịch");
    const iNganh  = headers.indexOf("Ngành");

    const groups = {}; // groupName → [{ symbol, title, san, nganh }]

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      // parse csv-aware
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
        cur += ch;
      }
      cols.push(cur);

      const symbol = cols[iSymbol]?.trim() ?? "";
      const title  = cols[iTitle]?.trim() ?? "";
      const san    = cols[iSan]?.trim() ?? "";
      const nganh  = cols[iNganh]?.trim() ?? "";
      if (!symbol) continue;

      // Bỏ qua trái phiếu / chứng chỉ: ký hiệu có chữ số ở cuối (vd: BID122028, BAB122030)
      if (/^[A-Z]{2,4}\d{4,}/.test(symbol)) continue;

      const group = reverseMap[nganh] ?? (nganh ? "Khác" : "Chưa phân loại");
      if (!groups[group]) groups[group] = [];
      groups[group].push({ symbol, title, san, nganh });
    }

    const result = Object.entries(groups)
      .map(([name, stocks]) => ({ name, count: stocks.length, stocks }))
      .sort((a, b) => b.count - a.count);

    return sendJSON(res, 200, result);
  }

  const staticFiles = {
    "/css/style.css":          { file: "public/css/style.css",          mime: "text/css; charset=utf-8" },
    "/js/app.js":              { file: "public/js/app.js",              mime: "application/javascript; charset=utf-8" },
    "/surge.html":             { file: "public/surge.html",             mime: "text/html; charset=utf-8" },
    "/detail.html":            { file: "public/detail.html",            mime: "text/html; charset=utf-8" },
    "/watchlist.html":         { file: "public/watchlist.html",         mime: "text/html; charset=utf-8" },
    "/watcher.html":           { file: "public/watcher.html",           mime: "text/html; charset=utf-8" },
    "/portfolio.html":         { file: "public/portfolio.html",         mime: "text/html; charset=utf-8" },
    "/css/portfolio.css":      { file: "public/css/portfolio.css",      mime: "text/css; charset=utf-8" },
    "/js/portfolio.js":        { file: "public/js/portfolio.js",        mime: "application/javascript; charset=utf-8" },
    "/stocks.csv":             { file: "public/stocks.csv",             mime: "text/csv; charset=utf-8" },
    "/sector.html":            { file: "public/sector.html",            mime: "text/html; charset=utf-8" },
    "/sector-detail.html":     { file: "public/sector-detail.html",     mime: "text/html; charset=utf-8" },
  };
  if (staticFiles[pathname]) {
    const { file, mime } = staticFiles[pathname];
    const filePath = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      file
    );
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": mime });
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

server.listen(PORT, "0.0.0.0", () => {
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address ?? "?";
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
