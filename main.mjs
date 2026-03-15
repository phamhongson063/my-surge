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
import { analyzeAll } from "./analyze.mjs";
import { analyzeDetail } from "./analyzeDetail.mjs";
import { scrapeSymbol, loadDB as loadStockDB, saveDB as saveStockDB } from "./fetchStockInfo.mjs";
import { scanWatchlist, parseBody } from "./watchlist.mjs";

const PORT = 3000;
const TMP_DIR   = "tmp";
const CACHE_DIR = "cache";

// ─── Cache helpers ───────────────────────────────────────────────────────────
function todayTag() {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}
function cacheFilePath(maPeriod) {
  return path.join(CACHE_DIR, `analyze_ma${maPeriod}_${todayTag()}.json`);
}
function readCache(maPeriod) {
  try {
    const fp = cacheFilePath(maPeriod);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { return null; }
}
function writeCache(maPeriod, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFilePath(maPeriod), JSON.stringify(data), "utf8");
  } catch(e) { console.warn("Cache write error:", e.message); }
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
    const maPeriod  = parseInt(parsed.query.ma) || 20;
    const useCache  = parsed.query.cache === "1";

    if (useCache) {
      const cached = readCache(maPeriod);
      if (cached) {
        console.log(`[Cache] HIT — ma${maPeriod} ${todayTag()}`);
        cached._fromCache = true;
        return sendJSON(res, 200, cached);
      }
      console.log(`[Cache] MISS — tính toán mới ma${maPeriod} ${todayTag()}`);
    }

    const result = await analyzeAll(TMP_DIR, { maPeriod });
    if (!result.error && useCache) writeCache(maPeriod, result);
    return sendJSON(res, result.error ? 400 : 200, result);
  }

  // ─── Company info (stocks_info.json là nguồn duy nhất, không tạo file phụ) ──
  if (pathname === "/company-info" && req.method === "GET") {
    const symbol = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!symbol) return sendJSON(res, 400, { error: "Thiếu symbol" });

    // 1) Check stocks_info.json — nếu đủ thông tin thì trả ngay
    const db = loadStockDB();
    const dbEntry = db[symbol] || null;

    if (dbEntry?.companyName && dbEntry.companyName !== symbol && dbEntry?.industry) {
      return sendJSON(res, 200, dbEntry);
    }

    // 2) DB có data nhưng thiếu field → trả ngay, scrape ngầm để bổ sung
    if (dbEntry?.companyName && dbEntry.companyName !== symbol) {
      sendJSON(res, 200, dbEntry);
      scrapeSymbol(symbol).then(info => {
        if (info.companyName || info.industry) {
          const merged = {
            symbol,
            companyName: info.companyName || dbEntry.companyName,
            exchange:    info.exchange    || dbEntry.exchange,
            industry:    info.industry    || dbEntry.industry,
            chairman:    info.chairman    || dbEntry.chairman,
            ceo:         info.ceo         || dbEntry.ceo,
            pe:          info.pe          || null,
          };
          db[symbol] = merged;
          saveStockDB(db);
          console.log(`   🔄 Background update: ${symbol} | ${merged.industry || "?"}`);
        }
      }).catch(() => {});
      return;
    }

    // 3) Hoàn toàn không có → scrape blocking lần đầu, lưu vào stocks_info.json
    console.log(`[${new Date().toLocaleTimeString("vi-VN")}] 🏢 Scrape mới: ${symbol}`);
    try {
      const info = await scrapeSymbol(symbol);
      const result = {
        symbol,
        companyName: info.companyName || symbol,
        exchange:    info.exchange    || null,
        industry:    info.industry    || null,
        chairman:    info.chairman    || null,
        ceo:         info.ceo         || null,
        pe:          info.pe          || null,
      };
      if (result.companyName !== symbol || result.industry) {
        db[symbol] = result;
        saveStockDB(db);
      }
      console.log(`   ✅ ${result.companyName} | ${result.industry || "?"} | ${result.exchange || "?"}`);
      return sendJSON(res, 200, result);
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      return sendJSON(res, 200, { symbol, companyName: symbol });
    }
  }

  // ─── Detail analysis ───────────────────────────────────────────────────────
  if (pathname === "/analyze-detail" && req.method === "GET") {
    const symbol = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!symbol) return sendJSON(res, 400, { error: "Thiếu tham số symbol" });

    const forceRefresh = parsed.query.refresh === "1";
    const detailCachePath = path.join(CACHE_DIR, symbol, "analysis.json");

    // ── Đọc cache nếu còn hạn (< 24h) và không bị force refresh ──────────────
    if (!forceRefresh) {
      try {
        if (fs.existsSync(detailCachePath)) {
          const ageMs = Date.now() - fs.statSync(detailCachePath).mtimeMs;
          if (ageMs < 24 * 60 * 60 * 1000) {
            const cached = JSON.parse(fs.readFileSync(detailCachePath, "utf8"));
            if (cached && !cached.error) {
              cached._fromCache = true;
              cached._cacheAgeMin = Math.floor(ageMs / 60000);
              console.log(`[Cache] HIT detail — ${symbol} (${Math.floor(ageMs/60000)} phút tuổi)`);
              return sendJSON(res, 200, cached);
            }
          }
        }
      } catch (e) {
        console.warn(`[Cache] Lỗi đọc cache detail ${symbol}:`, e.message);
      }
    }

    console.log(`\n[${new Date().toLocaleTimeString("vi-VN")}] 🔍 Phân tích chi tiết: ${symbol}${forceRefresh ? " (force refresh)" : ""}`);
    try {
      const result = await analyzeDetail(TMP_DIR, symbol, { cacheDir: CACHE_DIR });
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

  if (pathname === "/analyze" && req.method === "GET") {
    const ma = parseInt(parsed.query.ma) || MA_PERIOD;
    const ratio = parseFloat(parsed.query.ratio) || SURGE_RATIO;
    try {
      const results = analyzeAll(ma, ratio);
      const files = fs.existsSync(TMP_DIR)
        ? fs.readdirSync(TMP_DIR).filter((f) => /\.xlsx$/i.test(f)).length
        : 0;
      return sendJSON(res, 200, {
        results,
        totalFiles: files,
        scanTime: new Date().toLocaleTimeString("vi-VN"),
      });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // ─── Watchlist ──────────────────────────────────────────────────────────────
  if (pathname.startsWith("/watchlist")) {
    // Parse body cho POST requests
    let body = {};
    if (req.method === "POST") body = await parseBody(req);

    // GET /watchlist — trả danh sách + alerts gần nhất
    if (pathname === "/watchlist" && req.method === "GET") {
      const WLFILE = path.join(CACHE_DIR, "watchlist.json");
      try {
        const wl = fs.existsSync(WLFILE)
          ? JSON.parse(fs.readFileSync(WLFILE, "utf8"))
          : { symbols: [], lastScan: null, alerts: [] };
        return sendJSON(res, 200, wl);
      } catch { return sendJSON(res, 200, { symbols: [], lastScan: null, alerts: [] }); }
    }

    // POST /watchlist/add  { symbol }
    if (pathname === "/watchlist/add" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym))
        return sendJSON(res, 400, { error: "Mã không hợp lệ" });
      const WLFILE = path.join(CACHE_DIR, "watchlist.json");
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      let wl = { symbols: [], lastScan: null, alerts: [] };
      try { if (fs.existsSync(WLFILE)) wl = JSON.parse(fs.readFileSync(WLFILE, "utf8")); } catch {}
      if (!wl.symbols.includes(sym)) wl.symbols.push(sym);
      fs.writeFileSync(WLFILE, JSON.stringify(wl, null, 2));
      console.log(`[Watchlist] ➕ ${sym} | tổng: ${wl.symbols.length} mã`);
      return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    }

    // POST /watchlist/remove  { symbol }
    if (pathname === "/watchlist/remove" && req.method === "POST") {
      const sym = (body?.symbol ?? "").toUpperCase().trim();
      const WLFILE = path.join(CACHE_DIR, "watchlist.json");
      let wl = { symbols: [], lastScan: null, alerts: [] };
      try { if (fs.existsSync(WLFILE)) wl = JSON.parse(fs.readFileSync(WLFILE, "utf8")); } catch {}
      wl.symbols = wl.symbols.filter(s => s !== sym);
      fs.writeFileSync(WLFILE, JSON.stringify(wl, null, 2));
      console.log(`[Watchlist] ➖ ${sym} | còn: ${wl.symbols.length} mã`);
      return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    }

    // GET /watchlist/scan?refresh=1  — quét toàn bộ watchlist
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

  const staticFiles = {
    "/style.css": { file: "style.css", mime: "text/css; charset=utf-8" },
    "/app.js": {
      file: "app.js",
      mime: "application/javascript; charset=utf-8",
    },
    "/surge.html": { file: "surge.html", mime: "text/html; charset=utf-8" },
    "/detail.html": { file: "detail.html", mime: "text/html; charset=utf-8" },
    "/stocks.csv": { file: "stocks.csv", mime: "text/csv; charset=utf-8" },
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
  console.log(`  GET /watchlist/scan?refresh=1 → Force scan (bỏ qua cache)\n`);
});
