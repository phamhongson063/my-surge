/**
 * watchlist.mjs — Quản lý watchlist và quét tín hiệu
 *
 * Lưu trữ: settings/watchlist.json
 * Tích hợp vào main.mjs qua import
 *
 * Endpoints (thêm vào main.mjs):
 *   GET  /watchlist              → lấy danh sách + trạng thái tín hiệu hiện tại
 *   POST /watchlist/add          → { symbol }
 *   POST /watchlist/remove       → { symbol }
 *   GET  /watchlist/scan         → quét toàn bộ watchlist, trả alerts
 */

import fs from "fs";
import path from "path";
import { analyzeDetail } from "./analyzeDetail.mjs";

const WATCHLIST_FILE = path.join("settings", "watchlist.json");
const TMP_DIR = "tmp";
const CACHE_DIR = "cache";

// ── Đọc / ghi watchlist ───────────────────────────────────────────────────────
function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE))
      return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
  } catch {}
  return { symbols: [], lastScan: null, alerts: [] };
}

function saveWatchlist(data) {
  try {
    fs.mkdirSync("settings", { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.warn("[Watchlist] Save error:", e.message);
  }
}

// ── Phân tích tín hiệu từ result của analyzeDetail ────────────────────────────
function extractSignals(symbol, result) {
  const signals = [];
  const ind = result.indicators;
  const trend = result.trend;
  const vol = result.volume;
  const price = result.latestPrice;

  // ── RSI oversold / overbought ─────────────────────────────────────────────
  if (ind.rsi != null) {
    if (ind.rsi < 30)
      signals.push({
        type: "RSI_OVERSOLD",
        level: "buy",
        title: `RSI quá bán (${ind.rsi.toFixed(1)})`,
        desc: "RSI < 30 — vùng quá bán, khả năng hồi phục",
        value: ind.rsi,
      });
    else if (ind.rsi > 70)
      signals.push({
        type: "RSI_OVERBOUGHT",
        level: "sell",
        title: `RSI quá mua (${ind.rsi.toFixed(1)})`,
        desc: "RSI > 70 — vùng quá mua, cẩn trọng điều chỉnh",
        value: ind.rsi,
      });
  }

  // ── MACD crossover ────────────────────────────────────────────────────────
  if (ind.macd != null && ind.macdSignal != null) {
    const hist = ind.macdHistogram;
    if (hist != null) {
      if (hist > 0 && ind.macd > ind.macdSignal)
        signals.push({
          type: "MACD_BULL_CROSS",
          level: "buy",
          title: "MACD cắt lên Signal",
          desc: `MACD (${ind.macd.toFixed(3)}) vượt Signal (${ind.macdSignal.toFixed(3)})`,
          value: hist,
        });
      else if (hist < 0 && ind.macd < ind.macdSignal)
        signals.push({
          type: "MACD_BEAR_CROSS",
          level: "sell",
          title: "MACD cắt xuống Signal",
          desc: `MACD (${ind.macd.toFixed(3)}) dưới Signal (${ind.macdSignal.toFixed(3)})`,
          value: hist,
        });
    }
  }

  // ── Giá vs MA20 ───────────────────────────────────────────────────────────
  if (ind.ma20 != null && price != null) {
    const pct = ((price - ind.ma20) / ind.ma20) * 100;
    if (Math.abs(pct) < 0.5)
      signals.push({
        type: "PRICE_AT_MA20",
        level: "watch",
        title: `Giá tại MA20 (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`,
        desc: `Giá ${price} đang test MA20 ${ind.ma20} — vùng quyết định`,
        value: pct,
      });
  }

  // ── Volume đột biến ───────────────────────────────────────────────────────
  if (vol?.isSurge)
    signals.push({
      type: "VOLUME_SURGE",
      level: "watch",
      title: `Khối lượng đột biến ×${vol.ratio?.toFixed(1)}`,
      desc: `KLGD ${vol.ratio?.toFixed(1)}× trung bình 20 phiên`,
      value: vol.ratio,
    });

  // ── Trend alignment ───────────────────────────────────────────────────────
  if (trend?.alignment === "STRONG_UP")
    signals.push({
      type: "TREND_STRONG_UP",
      level: "buy",
      title: "3/3 khung đồng thuận TĂNG",
      desc: trend.alignmentDesc,
      value: 3,
    });
  else if (trend?.alignment === "STRONG_DOWN")
    signals.push({
      type: "TREND_STRONG_DOWN",
      level: "sell",
      title: "3/3 khung đồng thuận GIẢM",
      desc: trend.alignmentDesc,
      value: 3,
    });

  // ── BB Squeeze (BB width thu hẹp) ─────────────────────────────────────────
  if (ind.bbUpper != null && ind.bbLower != null && price != null) {
    const bbWidth = ((ind.bbUpper - ind.bbLower) / price) * 100;
    if (bbWidth < 5)
      signals.push({
        type: "BB_SQUEEZE",
        level: "watch",
        title: `BB Squeeze (width ${bbWidth.toFixed(1)}%)`,
        desc: "Bollinger Bands thu hẹp — sắp có biến động lớn",
        value: bbWidth,
      });
  }

  // ── Giá gần hỗ trợ / kháng cự ────────────────────────────────────────────
  if (result.supportResistance) {
    const { supports, resistances } = result.supportResistance;
    supports.forEach((s) => {
      const pct = ((price - s.price) / s.price) * 100;
      if (pct >= 0 && pct < 2)
        signals.push({
          type: "NEAR_SUPPORT",
          level: "buy",
          title: `Giá gần hỗ trợ ${s.price} (+${pct.toFixed(1)}%)`,
          desc: `Vùng hỗ trợ ${s.touches} lần test — cơ hội mua tốt`,
          value: pct,
        });
    });
    resistances.forEach((r) => {
      const pct = ((r.price - price) / price) * 100;
      if (pct >= 0 && pct < 2)
        signals.push({
          type: "NEAR_RESISTANCE",
          level: "sell",
          title: `Giá gần kháng cự ${r.price} (còn ${pct.toFixed(1)}%)`,
          desc: `Vùng kháng cự ${r.touches} lần test — cân nhắc chốt lời`,
          value: pct,
        });
    });
  }

  return signals;
}

// ── Quét toàn bộ watchlist ────────────────────────────────────────────────────
export async function scanWatchlist(forceRefresh = false) {
  const wl = loadWatchlist();
  if (!wl.symbols.length) return { scanned: 0, alerts: [], symbols: [] };

  const results = [];
  const allAlerts = [];

  for (const symbol of wl.symbols) {
    try {
      // Dùng cache nếu có (< 24h) trừ khi forceRefresh
      const cachePath = path.join(CACHE_DIR, symbol, "analysis.json");
      let result = null;

      if (!forceRefresh && fs.existsSync(cachePath)) {
        const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
        if (ageMs < 24 * 60 * 60 * 1000) {
          try { result = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch {}
        }
      }

      if (!result || result.error) {
        result = await analyzeDetail(TMP_DIR, symbol, { cacheDir: CACHE_DIR });
      }

      if (result.error) {
        results.push({ symbol, error: result.error, signals: [] });
        continue;
      }

      const signals = extractSignals(symbol, result);
      const buySignals = signals.filter((s) => s.level === "buy").length;
      const sellSignals = signals.filter((s) => s.level === "sell").length;

      results.push({
        symbol,
        price: result.latestPrice,
        date: result.latestDate,
        change: result.latestChange,
        rsi: result.indicators.rsi,
        macdHist: result.indicators.macdHistogram,
        trend: result.trend?.alignment,
        signals,
        buySignals,
        sellSignals,
        recommendation: result.predictions?.recommendation,
        recColor: result.predictions?.recColor,
      });

      if (signals.length > 0) {
        allAlerts.push({ symbol, signals, price: result.latestPrice, date: result.latestDate });
      }
    } catch (e) {
      results.push({ symbol, error: e.message, signals: [] });
    }
  }

  const scanResult = {
    scanned: results.length,
    scanTime: new Date().toISOString(),
    alerts: allAlerts,
    symbols: results,
  };

  // Lưu lại alerts
  wl.lastScan = scanResult.scanTime;
  wl.alerts = allAlerts;
  saveWatchlist(wl);

  return scanResult;
}

// ── Handlers cho main.mjs ─────────────────────────────────────────────────────
export function handleWatchlist(pathname, method, body, sendJSON, res) {
  // GET /watchlist
  if (pathname === "/watchlist" && method === "GET") {
    const wl = loadWatchlist();
    return sendJSON(res, 200, wl);
  }

  // POST /watchlist/add  { symbol }
  if (pathname === "/watchlist/add" && method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym))
      return sendJSON(res, 400, { error: "Mã không hợp lệ" });
    const wl = loadWatchlist();
    if (!wl.symbols.includes(sym)) {
      wl.symbols.push(sym);
      saveWatchlist(wl);
    }
    return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
  }

  // POST /watchlist/remove  { symbol }
  if (pathname === "/watchlist/remove" && method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    const wl = loadWatchlist();
    wl.symbols = wl.symbols.filter((s) => s !== sym);
    saveWatchlist(wl);
    return sendJSON(res, 200, { ok: true, symbols: wl.symbols });
  }

  // GET /watchlist/scan?refresh=1
  if (pathname === "/watchlist/scan" && method === "GET") {
    return null; // async, caller phải tự handle
  }

  return false; // không match
}

// ── Parse body từ request ─────────────────────────────────────────────────────
export function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}
