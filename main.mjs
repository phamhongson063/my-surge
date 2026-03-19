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
import https from "https";
import fs from "fs";
import path from "path";
import url from "url";
import { analyzeAll, analyzeDetail, scanWatchlist, parseBody, loadWatchlist, saveWatchlist, loadPortfolio, savePortfolio, loadHistory, saveHistory } from "./analyze.mjs";

const PORT = process.env.PORT || 3000;
const TMP_DIR = "tmp";

// ─── SSE realtime: SignalR WebSocket tới realtime.cafef.vn ───────────────────
const sseClients   = new Map(); // sym → Set<res>
const ssePriceCache = new Map(); // sym → { data, ts }
const wsConnections = new Map(); // sym → { ws, pingTimer, joined }

const SIGNALR_HUB = "wss://realtime.cafef.vn/hub/priceshub";
const SIGNALR_RS  = "\x1e"; // SignalR record separator

function parseCafeFPrice(v) {
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

function startSignalRForSym(sym) {
  if (wsConnections.has(sym)) return;
  console.log(`[SignalR] ▶ Connect ${sym}`);
  const ws   = new WebSocket(SIGNALR_HUB);
  const conn = { ws, pingTimer: null, joined: false };
  wsConnections.set(sym, conn);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + SIGNALR_RS);
  });

  ws.addEventListener("message", (event) => {
    const raw   = typeof event.data === "string" ? event.data : event.data.toString();
    const parts = raw.split(SIGNALR_RS).filter(s => s.trim());
    for (const part of parts) {
      try {
        const msg = JSON.parse(part);
        if (!conn.joined) {
          conn.joined = true;
          ws.send(JSON.stringify({ type: 1, target: "JoinChannel", arguments: [sym], invocationId: "0" }) + SIGNALR_RS);
          conn.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 6 }) + SIGNALR_RS);
          }, 15_000);
          console.log(`[SignalR] ✅ Joined ${sym}`);
          continue;
        }
        if (msg.type === 1 && msg.target === "RealtimePrice") {
          const data = parseCafeFPrice(msg.arguments?.[0]);
          if (data?.price) sseBroadcast(sym, data);
        }
      } catch {}
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(conn.pingTimer);
    wsConnections.delete(sym);
    console.log(`[SignalR] ❌ Closed ${sym}`);
    if (sseClients.get(sym)?.size > 0) setTimeout(() => startSignalRForSym(sym), 5_000);
  });

  ws.addEventListener("error", (err) => {
    console.error(`[SignalR] Error ${sym}:`, err.message ?? err);
  });
}

function stopSignalRForSym(sym) {
  const conn = wsConnections.get(sym);
  if (!conn) return;
  clearInterval(conn.pingTimer);
  conn.ws.close();
  wsConnections.delete(sym);
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
    const mshUrl = `https://msh-appdata.cafef.vn/rest-api/api/v1/Watchlists/${sym}/price`;
    try {
      const data = await new Promise((resolve, reject) => {
        https.get(mshUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Origin": "https://cafef.vn",
            "Referer": "https://cafef.vn/",
          }
        }, (rsp) => {
          if (rsp.statusCode >= 300 && rsp.statusCode < 400 && rsp.headers.location) {
            rsp.resume();
            return reject(new Error(`Redirect: ${rsp.headers.location}`));
          }
          const chunks = [];
          rsp.on("data", c => chunks.push(c));
          rsp.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch (e) { reject(new Error("Invalid JSON from MSH")); }
          });
          rsp.on("error", reject);
        }).on("error", reject);
      });
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

  const staticFiles = {
    "/css/style.css":      { file: "public/css/style.css",      mime: "text/css; charset=utf-8" },
    "/js/app.js":          { file: "public/js/app.js",          mime: "application/javascript; charset=utf-8" },
    "/surge.html":         { file: "public/surge.html",         mime: "text/html; charset=utf-8" },
    "/detail.html":        { file: "public/detail.html",        mime: "text/html; charset=utf-8" },
    "/watchlist.html":     { file: "public/watchlist.html",     mime: "text/html; charset=utf-8" },
    "/watcher.html":       { file: "public/watcher.html",       mime: "text/html; charset=utf-8" },
    "/portfolio.html":     { file: "public/portfolio.html",     mime: "text/html; charset=utf-8" },
    "/css/portfolio.css":  { file: "public/css/portfolio.css",  mime: "text/css; charset=utf-8" },
    "/js/portfolio.js":    { file: "public/js/portfolio.js",    mime: "application/javascript; charset=utf-8" },
    "/stocks.csv":         { file: "public/stocks.csv",         mime: "text/csv; charset=utf-8" },
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

server.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  CafeF Stock Downloader Server               ║`);
  console.log(`║  http://localhost:${PORT}                       ║`);
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
