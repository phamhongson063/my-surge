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
import { analyzeAll, analyzeDetail, scanWatchlist, parseBody, loadWatchlist, saveWatchlist } from "./analyze.mjs";

const PORT = 3000;
const TMP_DIR = "tmp";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

  // Serve front.html tại /front.html, index.html tại /
  if (pathname === "/" || pathname === "/index.html") {
    const htmlPath = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
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
    "/style.css":      { file: "style.css",      mime: "text/css; charset=utf-8" },
    "/app.js":         { file: "app.js",          mime: "application/javascript; charset=utf-8" },
    "/surge.html":     { file: "surge.html",      mime: "text/html; charset=utf-8" },
    "/detail.html":    { file: "detail.html",     mime: "text/html; charset=utf-8" },
    "/watchlist.html": { file: "watchlist.html",  mime: "text/html; charset=utf-8" },
    "/watcher.html":   { file: "watcher.html",    mime: "text/html; charset=utf-8" },
    "/stocks.csv":     { file: "stocks.csv",      mime: "text/csv; charset=utf-8" },
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
