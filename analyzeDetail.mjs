/**
 * analyzeDetail.mjs — phân tích kỹ thuật chi tiết 1 mã cổ phiếu
 * tại thời điểm cuối cùng trong file data
 * So sánh với index (VNINDEX) từ tmp/index.xlsx
 * Xuất kết quả vào cache/{symbol}/
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";

const inflateRaw = promisify(zlib.inflateRaw);

// ── ZIP / XLSX parser (reuse from analyze.mjs) ──────────────────────────────
function parseZipEntries(buf) {
  const files = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i++;
      continue;
    }
    const compression = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    files[name] = { compression, data };
    i = dataStart + compSize;
  }
  return files;
}

async function readEntry(entry) {
  if (!entry) return "";
  if (entry.compression === 0) return entry.data.toString("utf8");
  try {
    return (await inflateRaw(entry.data)).toString("utf8");
  } catch {
    return entry.data.toString("utf8");
  }
}

function decodeXml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseSharedStrings(xml) {
  const strings = [];
  const re = /<si>[\s\S]*?<\/si>/g;
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) {
    let text = "";
    let t;
    tRe.lastIndex = 0;
    while ((t = tRe.exec(m[0]))) text += decodeXml(t[1]);
    strings.push(text);
  }
  return strings;
}

function parseSheet(xml, strings) {
  const rows = {};
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>(?:[^<]*<v>([^<]*)<\/v>)?/g;
  const typeRe = /\bt="([^"]*)"/;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNum = parseInt(rm[1]);
    const content = rm[2];
    rows[rowNum] = {};
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(content))) {
      const col = cm[1];
      let val = cm[2] ?? "";
      const tm = typeRe.exec(cm[0]);
      if (tm && tm[1] === "s" && val !== "") val = strings[parseInt(val)] ?? "";
      rows[rowNum][col] = val;
    }
  }
  return rows;
}

function parseVol(val) {
  if (val == null || val === "") return 0;
  return (
    parseInt(String(val).replace(/\./g, "").replace(/,/g, "").trim(), 10) || 0
  );
}

function parseDate(val) {
  if (!val) return 0;
  const parts = String(val).split("/");
  if (parts.length !== 3) return 0;
  const [d, m, y] = parts;
  return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`).getTime();
}

async function readXlsx(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = parseZipEntries(buf);
  const sharedXml = await readEntry(entries["xl/sharedStrings.xml"]);
  const sheetXml = await readEntry(entries["xl/worksheets/sheet1.xml"]);
  if (!sheetXml) return null;
  const strings = sharedXml ? parseSharedStrings(sharedXml) : [];
  const rows = parseSheet(sheetXml, strings);

  const header = rows[1] || {};
  const colOf = (name) =>
    Object.entries(header).find(([, v]) => v === name)?.[0];
  const dateCol = colOf("Ngay") || "A";
  const adjCol = colOf("GiaDieuChinh") || "B";
  const closeCol = colOf("GiaDongCua") || "C";
  const changeCol = colOf("ThayDoi") || "D";
  const volCol = colOf("KhoiLuongKhopLenh") || "E";
  const valCol = colOf("GiaTriKhopLenh") || "F";
  const openCol = colOf("GiaMoCua") || "I";
  const highCol = colOf("GiaCaoNhat") || "J";
  const lowCol = colOf("GiaThapNhat") || "K";

  const parseP = (raw) =>
    raw
      ? parseFloat(String(raw).replace(/\./g, "").replace(",", ".")) || null
      : null;

  const data = [];
  for (const [rNum, cells] of Object.entries(rows)) {
    if (parseInt(rNum) <= 1) continue;
    const dateVal = cells[dateCol];
    if (!dateVal) continue;
    const ts = parseDate(dateVal);
    if (!ts) continue;
    data.push({
      date: String(dateVal),
      volume: parseVol(cells[volCol]),
      price: parseP(cells[closeCol]),
      open: parseP(cells[openCol]),
      high: parseP(cells[highCol]),
      low: parseP(cells[lowCol]),
      adj: parseP(cells[adjCol]),
      val: parseP(cells[valCol]),
      change: cells[changeCol] ? String(cells[changeCol]) : null,
      ts,
    });
  }
  data.sort((a, b) => a.ts - b.ts);
  return data;
}

// ── Technical indicators ─────────────────────────────────────────────────────
function sma(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) {
      r.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += arr[j];
    r.push(sum / n);
  }
  return r;
}

function ema(arr, n) {
  const r = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let sum = 0,
    cnt = 0;
  for (let i = 0; i < n && i < arr.length; i++) {
    if (arr[i] != null) {
      sum += arr[i];
      cnt++;
    }
  }
  if (cnt < n) return r;
  r[n - 1] = sum / n;
  for (let i = n; i < arr.length; i++) r[i] = arr[i] * k + r[i - 1] * (1 - k);
  return r;
}

function calcRSI(prices, period = 14) {
  // Wilder Smoothing (chuẩn TradingView / MetaTrader)
  // Bước 1: SMA của period đầu tiên làm seed
  // Bước 2: Wilder EMA = prevAvg * (period-1)/period + current * 1/period
  const rsi = new Array(prices.length).fill(null);
  if (prices.length <= period) return rsi;

  let avgGain = 0, avgLoss = 0;
  // Seed: tính SMA của period phiên đầu
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing cho các phiên tiếp theo
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(prices) {
  const ema12 = ema(prices, 12);
  const ema26 = ema(prices, 26);
  const macdLine = prices.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null
  );
  const validMacd = macdLine.filter((v) => v != null);
  const signalRaw = ema(validMacd, 9);
  const signal = new Array(prices.length).fill(null);
  let vi = 0;
  for (let i = 0; i < prices.length; i++) {
    if (macdLine[i] != null) {
      signal[i] = signalRaw[vi] ?? null;
      vi++;
    }
  }
  const histogram = prices.map((_, i) =>
    macdLine[i] != null && signal[i] != null ? macdLine[i] - signal[i] : null
  );
  return { macdLine, signal, histogram };
}

function calcBB(prices, period = 20) {
  const mid = sma(prices, period);
  const upper = [],
    lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (mid[i] == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++)
      variance += (prices[j] - mid[i]) ** 2;
    variance /= period;
    const std = Math.sqrt(variance);
    upper.push(mid[i] + 2 * std);
    lower.push(mid[i] - 2 * std);
  }
  return { upper, mid, lower };
}

// ── ATR — Average True Range (Wilder) ────────────────────────────────────────
function calcATR(data, period = 14) {
  // True Range = max(H-L, |H-prevC|, |L-prevC|)
  const atr = new Array(data.length).fill(null);
  if (data.length <= period) return atr;

  // Seed: SMA của TR đầu tiên
  let sumTR = 0;
  for (let i = 1; i <= period; i++) {
    const h = data[i].high ?? data[i].price;
    const l = data[i].low ?? data[i].price;
    const prevC = data[i - 1].price;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    sumTR += tr;
  }
  atr[period] = sumTR / period;

  // Wilder smoothing
  for (let i = period + 1; i < data.length; i++) {
    const h = data[i].high ?? data[i].price;
    const l = data[i].low ?? data[i].price;
    const prevC = data[i - 1].price;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}
function findSwings(prices, threshold) {
  const swings = [];
  let lastHighI = 0,
    lastHighP = prices[0];
  let lastLowI = 0,
    lastLowP = prices[0];
  let trend = null;
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (p > lastHighP) {
      lastHighI = i;
      lastHighP = p;
    }
    if (p < lastLowP) {
      lastLowI = i;
      lastLowP = p;
    }
    if (
      trend !== "down" &&
      lastHighP > 0 &&
      ((lastHighP - p) / lastHighP) * 100 >= threshold
    ) {
      swings.push({ idx: lastHighI, price: lastHighP, type: "H" });
      lastLowI = i;
      lastLowP = p;
      trend = "down";
    } else if (
      trend !== "up" &&
      lastLowP > 0 &&
      ((p - lastLowP) / lastLowP) * 100 >= threshold
    ) {
      swings.push({ idx: lastLowI, price: lastLowP, type: "L" });
      lastHighI = i;
      lastHighP = p;
      trend = "up";
    }
  }
  return swings;
}

// ── Support / Resistance detection ───────────────────────────────────────────
function findSupportResistance(data, currentPrice) {
  const highs = data.map((d) => d.high).filter(Boolean);
  const lows = data.map((d) => d.low).filter(Boolean);
  const levels = [];

  // Cluster highs/lows
  const allPrices = [...highs, ...lows].sort((a, b) => a - b);
  const clusters = [];
  let cluster = [allPrices[0]];
  for (let i = 1; i < allPrices.length; i++) {
    if ((allPrices[i] - cluster[cluster.length - 1]) / cluster[0] < 0.015) {
      cluster.push(allPrices[i]);
    } else {
      if (cluster.length >= 3) clusters.push(cluster);
      cluster = [allPrices[i]];
    }
  }
  if (cluster.length >= 3) clusters.push(cluster);

  for (const c of clusters) {
    const avg = c.reduce((s, v) => s + v, 0) / c.length;
    const touches = c.length;
    levels.push({
      price: Math.round(avg * 100) / 100,
      touches,
      type: avg > currentPrice ? "resistance" : "support",
    });
  }

  levels.sort(
    (a, b) =>
      Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
  );
  const supports = levels.filter((l) => l.type === "support").slice(0, 3);
  const resistances = levels.filter((l) => l.type === "resistance").slice(0, 3);
  return { supports, resistances };
}

// ── Candle pattern at latest ─────────────────────────────────────────────────
function detectLatestPatterns(data) {
  if (data.length < 3) return [];
  const patterns = [];
  const i = data.length - 1;
  const { open: o, high: h, low: l, price: c } = data[i];
  if (!o || !h || !l || !c) return [];

  const body = Math.abs(c - o);
  const range = h - l || 0.01;
  const upperShadow = h - Math.max(o, c);
  const lowerShadow = Math.min(o, c) - l;

  if (body / range < 0.1)
    patterns.push({
      name: "Doji",
      signal: "neutral",
      desc: "Thị trường do dự, có thể đảo chiều",
    });
  if (c > o && lowerShadow > body * 2 && upperShadow < body * 0.3)
    patterns.push({
      name: "Hammer",
      signal: "bullish",
      desc: "Tín hiệu đảo chiều tăng",
    });
  if (c < o && upperShadow > body * 2 && lowerShadow < body * 0.3)
    patterns.push({
      name: "Shooting Star",
      signal: "bearish",
      desc: "Tín hiệu đảo chiều giảm",
    });
  if (c > o && body / range > 0.7)
    patterns.push({
      name: "Marubozu tăng",
      signal: "bullish",
      desc: "Áp lực mua rất mạnh",
    });
  if (c < o && body / range > 0.7)
    patterns.push({
      name: "Marubozu giảm",
      signal: "bearish",
      desc: "Áp lực bán rất mạnh",
    });

  // Engulfing (so với phiên trước)
  const prev = data[i - 1];
  if (prev.price && prev.open) {
    if (prev.price < prev.open && c > o && c > prev.open && o < prev.price)
      patterns.push({
        name: "Bullish Engulfing",
        signal: "bullish",
        desc: "Nhấn chìm tăng — tín hiệu đảo chiều mạnh",
      });
    if (prev.price > prev.open && c < o && c < prev.open && o > prev.price)
      patterns.push({
        name: "Bearish Engulfing",
        signal: "bearish",
        desc: "Nhấn chìm giảm — tín hiệu đảo chiều giảm",
      });
  }

  // Morning/Evening star (3 nến)
  if (data.length >= 3) {
    const d3 = data[i - 2],
      d2 = data[i - 1],
      d1 = data[i];
    if (d3.price && d3.open && d2.price && d2.open && d1.price && d1.open) {
      if (
        d3.price < d3.open &&
        Math.abs(d2.price - d2.open) /
          ((d2.high || d2.price) - (d2.low || d2.price) || 1) <
          0.3 &&
        d1.price > d1.open &&
        d1.price > (d3.open + d3.price) / 2
      )
        patterns.push({
          name: "Morning Star",
          signal: "bullish",
          desc: "Sao mai — tín hiệu đảo chiều tăng mạnh",
        });
      if (
        d3.price > d3.open &&
        Math.abs(d2.price - d2.open) /
          ((d2.high || d2.price) - (d2.low || d2.price) || 1) <
          0.3 &&
        d1.price < d1.open &&
        d1.price < (d3.open + d3.price) / 2
      )
        patterns.push({
          name: "Evening Star",
          signal: "bearish",
          desc: "Sao hôm — tín hiệu đảo chiều giảm mạnh",
        });
    }
  }

  return patterns;
}

// ── Trend determination ──────────────────────────────────────────────────────
function determineTrend(prices, ma20, ma50, ma200, rsi, macd) {
  const n = prices.length;
  const latest = prices[n - 1];
  const m20 = ma20[n - 1],
    m50 = ma50[n - 1],
    m200 = ma200?.[n - 1];

  function classifyTimeframe(label, maShort, maLong, lookback) {
    const start = Math.max(0, n - lookback);
    const pctChange = ((latest - prices[start]) / prices[start]) * 100;
    const priceAboveMA = maShort != null ? latest > maShort : null;
    const maRising =
      maShort != null && n > 5 ? maShort > (ma20[n - 6] ?? maShort) : null;
    const currentRSI = rsi[n - 1];
    const currentMACD = macd.histogram[n - 1];

    let direction, strength, signal;

    if (pctChange > 5 && priceAboveMA && maRising) {
      direction = "UPTREND";
      strength = pctChange > 15 ? "mạnh" : "trung bình";
    } else if (pctChange < -5 && priceAboveMA === false) {
      direction = "DOWNTREND";
      strength = pctChange < -15 ? "mạnh" : "trung bình";
    } else {
      direction = "SIDEWAY";
      strength = "trung bình";
    }

    // Signal
    if (direction === "UPTREND" && currentRSI > 70)
      signal = "Quá mua — cẩn trọng điều chỉnh";
    else if (direction === "DOWNTREND" && currentRSI < 30)
      signal = "Quá bán — có thể hồi phục";
    else if (direction === "UPTREND" && currentMACD > 0)
      signal = "Động lực tăng được xác nhận";
    else if (direction === "DOWNTREND" && currentMACD < 0)
      signal = "Động lực giảm vẫn tiếp tục";
    else if (direction === "SIDEWAY") signal = "Chờ phá vỡ vùng tích lũy";
    else signal = "Trung tính";

    return {
      label,
      direction,
      strength,
      pctChange: Math.round(pctChange * 100) / 100,
      priceVsMA: priceAboveMA,
      maRising,
      signal,
    };
  }

  const shortTerm = classifyTimeframe("Ngắn hạn (20 phiên)", m20, m50, 20);
  const midTerm = classifyTimeframe("Trung hạn (50 phiên)", m50, m200, 50);
  const longTerm = classifyTimeframe(
    "Dài hạn (200 phiên)",
    m200,
    null,
    Math.min(200, n - 1)
  );

  // Alignment score
  const dirs = [shortTerm.direction, midTerm.direction, longTerm.direction];
  const upCount = dirs.filter((d) => d === "UPTREND").length;
  const downCount = dirs.filter((d) => d === "DOWNTREND").length;

  let alignment, alignmentDesc;
  if (upCount === 3) {
    alignment = "STRONG_UP";
    alignmentDesc = "⚡ 3/3 khung đồng thuận TĂNG — xác suất tăng cao nhất";
  } else if (downCount === 3) {
    alignment = "STRONG_DOWN";
    alignmentDesc = "⚡ 3/3 khung đồng thuận GIẢM — rủi ro rất cao";
  } else if (upCount === 2) {
    alignment = "MODERATE_UP";
    alignmentDesc =
      "📌 2/3 khung thuận tăng — giao dịch mua được, quản lý rủi ro";
  } else if (downCount === 2) {
    alignment = "MODERATE_DOWN";
    alignmentDesc = "📌 2/3 khung thuận giảm — cẩn trọng, ưu tiên bán";
  } else {
    alignment = "MIXED";
    alignmentDesc = "🔄 Tín hiệu hỗn hợp — chờ xác nhận rõ hơn";
  }

  return { shortTerm, midTerm, longTerm, alignment, alignmentDesc };
}

// ── Predictions ──────────────────────────────────────────────────────────────
function generatePredictions(data, trend, sr, bb, rsi, macd) {
  const latest = data[data.length - 1];
  const price = latest.price;
  const currentRSI = rsi[rsi.length - 1];
  const currentMACD = macd.histogram[macd.histogram.length - 1];

  const predictions = {
    bestBuy: null,
    worstBuy: null,
    bestSell: null,
    worstSell: null,
  };

  // Best buy point + Selling strategy
  if (sr.supports.length > 0) {
    const s1 = sr.supports[0];
    const quality = trend.alignment.includes("UP")
      ? "⭐ A+"
      : trend.alignment === "MIXED"
      ? "📌 B"
      : "🚫 C";

    const buyPrice = s1.price;

    // Stoploss động: dùng ATR × 1.5 (Wilder ATR 14 phiên)
    // Fallback về 5% nếu không đủ dữ liệu OHLC
    const atrArr = calcATR(data, 14);
    const latestATR = atrArr[atrArr.length - 1];
    const atrMultiplier = 1.5;
    const stoploss = latestATR
      ? Math.round((buyPrice - latestATR * atrMultiplier) * 100) / 100
      : Math.round(buyPrice * 0.95 * 100) / 100;
    const atrPct = latestATR ? ((latestATR / buyPrice) * 100).toFixed(2) : null;
    const riskPerShare = Math.max(buyPrice - stoploss, buyPrice * 0.01);

    // Target levels dựa trên kháng cự + R:R ratio
    const r1 = sr.resistances.length > 0 ? sr.resistances[0].price : Math.round(price * 1.08 * 100) / 100;
    const r2 = sr.resistances.length > 1 ? sr.resistances[1].price : Math.round(price * 1.15 * 100) / 100;
    const r3 = Math.round(buyPrice + riskPerShare * 4 * 100) / 100; // R:R = 4:1

    const tp1 = Math.min(r1, Math.round((buyPrice + riskPerShare * 1.5) * 100) / 100); // R:R 1.5
    const tp2 = Math.min(r2, Math.round((buyPrice + riskPerShare * 2.5) * 100) / 100); // R:R 2.5
    const tp3 = Math.round((buyPrice + riskPerShare * 4) * 100) / 100; // R:R 4

    const tp1Pct = ((tp1 - buyPrice) / buyPrice * 100).toFixed(1);
    const tp2Pct = ((tp2 - buyPrice) / buyPrice * 100).toFixed(1);
    const tp3Pct = ((tp3 - buyPrice) / buyPrice * 100).toFixed(1);
    const slPct = ((stoploss - buyPrice) / buyPrice * 100).toFixed(1);

    // Chiến lược chia lệnh theo volatility
    const volatility = data.slice(-20).reduce((s, d) => {
      if (!d.high || !d.low || !d.price) return s;
      return s + (d.high - d.low) / d.price;
    }, 0) / 20 * 100;

    // Nếu biến động cao → chia nhiều lệnh nhỏ, nếu thấp → ít lệnh hơn
    let splitStrategy;
    if (volatility > 4) {
      splitStrategy = {
        type: "aggressive_split",
        desc: `Biến động cao (${volatility.toFixed(1)}%/ngày) — chia 4 lệnh`,
        orders: [
          { pct: 25, action: "Mua", price: buyPrice, note: "Lệnh 1: Vào đầu tiên tại hỗ trợ" },
          { pct: 25, action: "Mua thêm", price: Math.round(buyPrice * 0.98 * 100) / 100, note: "Lệnh 2: Nếu giá giảm thêm 2% — DCA" },
          { pct: 25, action: "Mua thêm", price: Math.round(buyPrice * 1.03 * 100) / 100, note: "Lệnh 3: Xác nhận breakout +3%" },
          { pct: 25, action: "Dự phòng", price: null, note: "Lệnh 4: Giữ tiền chờ cơ hội hoặc thêm tại TP1" },
        ],
      };
    } else if (volatility > 2.5) {
      splitStrategy = {
        type: "moderate_split",
        desc: `Biến động trung bình (${volatility.toFixed(1)}%/ngày) — chia 3 lệnh`,
        orders: [
          { pct: 40, action: "Mua", price: buyPrice, note: "Lệnh 1: Vào chính tại hỗ trợ" },
          { pct: 30, action: "Mua thêm", price: Math.round(buyPrice * 1.02 * 100) / 100, note: "Lệnh 2: Xác nhận tăng +2%" },
          { pct: 30, action: "Dự phòng", price: null, note: "Lệnh 3: Giữ chờ pullback hoặc thêm tại breakout" },
        ],
      };
    } else {
      splitStrategy = {
        type: "conservative",
        desc: `Biến động thấp (${volatility.toFixed(1)}%/ngày) — chia 2 lệnh`,
        orders: [
          { pct: 60, action: "Mua", price: buyPrice, note: "Lệnh 1: Vào chính tại hỗ trợ" },
          { pct: 40, action: "Mua thêm", price: Math.round(buyPrice * 1.02 * 100) / 100, note: "Lệnh 2: Xác nhận xu hướng" },
        ],
      };
    }

    // Chiến lược bán (chốt lời từng phần)
    const sellStrategy = {
      desc: "Chia lệnh bán theo mục tiêu — bảo vệ lợi nhuận, để phần còn lại chạy",
      targets: [
        { name: "TP1 — Chốt nhanh", price: tp1, pct: tp1Pct, sellPct: 30,
          rr: (riskPerShare > 0 ? ((tp1 - buyPrice) / riskPerShare).toFixed(1) : "—"),
          action: `Bán 30% vị thế tại ${tp1}`,
          note: "Bảo vệ vốn — dời stoploss lên điểm hòa vốn" },
        { name: "TP2 — Mục tiêu chính", price: tp2, pct: tp2Pct, sellPct: 40,
          rr: (riskPerShare > 0 ? ((tp2 - buyPrice) / riskPerShare).toFixed(1) : "—"),
          action: `Bán 40% vị thế tại ${tp2}`,
          note: "Dời stoploss lên TP1 — lợi nhuận đã đảm bảo" },
        { name: "TP3 — Để chạy", price: tp3, pct: tp3Pct, sellPct: 30,
          rr: (riskPerShare > 0 ? ((tp3 - buyPrice) / riskPerShare).toFixed(1) : "—"),
          action: `Bán 30% còn lại hoặc trailing stop`,
          note: "Trailing stop 5-7% — để xu hướng quyết định" },
      ],
      trailingStop: {
        pct: volatility > 3 ? 7 : 5,
        desc: `Trailing stop ${volatility > 3 ? "7" : "5"}% cho phần còn lại — tự động bán nếu giá quay đầu`,
      },
    };

    predictions.bestBuy = {
      price: buyPrice,
      reason: `Vùng hỗ trợ mạnh (${s1.touches} lần test). ${
        currentRSI < 40
          ? "RSI quá bán hỗ trợ tín hiệu mua."
          : "Chờ RSI < 40 để xác nhận."
      }`,
      quality,
      stoploss,
      stoplossPct: slPct,
      atrPct,
      stoplossMethod: latestATR ? `ATR(14)×${atrMultiplier} = ${latestATR?.toFixed(2)}` : "Fixed 5%",
      tp1, tp2, tp3,
      tp1Pct, tp2Pct, tp3Pct,
      riskPerShare: Math.round(riskPerShare * 100) / 100,
      volatility: Math.round(volatility * 100) / 100,
      splitStrategy,
      sellStrategy,
    };
  }

  // Worst buy point
  if (sr.resistances.length > 0) {
    const r1 = sr.resistances[0];
    predictions.worstBuy = {
      price: r1.price,
      reason: `Mua tại vùng kháng cự ${r1.price} — rủi ro bị reject cao. ${
        trend.shortTerm.direction === "DOWNTREND" ? "Ngắn hạn đang giảm." : ""
      }`,
      risk:
        "Giá có thể giảm về " +
        (sr.supports.length > 0
          ? sr.supports[0].price
          : Math.round(price * 0.9 * 100) / 100),
    };
  }

  // Best sell point
  if (sr.resistances.length > 0) {
    const r1 = sr.resistances[0];
    const quality = trend.alignment.includes("DOWN")
      ? "⭐ A+"
      : trend.alignment === "MIXED"
      ? "📌 B"
      : "🚫 C";
    predictions.bestSell = {
      price: r1.price,
      reason: `Vùng kháng cự mạnh (${r1.touches} lần test). ${
        currentRSI > 60
          ? "RSI quá mua hỗ trợ tín hiệu bán."
          : "Chờ RSI > 60 để xác nhận."
      }`,
      quality,
    };
  }

  // Worst sell point
  if (sr.supports.length > 0) {
    const s1 = sr.supports[0];
    predictions.worstSell = {
      price: s1.price,
      reason: `Bán tại vùng hỗ trợ ${s1.price} — có thể bắt đáy và hồi phục. ${
        trend.shortTerm.direction === "UPTREND" ? "Ngắn hạn đang tăng." : ""
      }`,
      risk:
        "Giá có thể hồi về " +
        (sr.resistances.length > 0
          ? sr.resistances[0].price
          : Math.round(price * 1.1 * 100) / 100),
    };
  }

  // Overall recommendation
  let recommendation, recColor;
  if (trend.alignment === "STRONG_UP" && currentRSI < 70) {
    recommendation = "MUA";
    recColor = "#2f9e44";
  } else if (trend.alignment === "STRONG_DOWN" && currentRSI > 30) {
    recommendation = "BÁN";
    recColor = "#e03131";
  } else if (trend.alignment === "MODERATE_UP") {
    recommendation = "THEO DÕI MUA";
    recColor = "#40c057";
  } else if (trend.alignment === "MODERATE_DOWN") {
    recommendation = "THEO DÕI BÁN";
    recColor = "#ff6b6b";
  } else {
    recommendation = "CHỜ";
    recColor = "#f59e0b";
  }

  predictions.recommendation = recommendation;
  predictions.recColor = recColor;

  return predictions;
}

// ── RS vs Index ──────────────────────────────────────────────────────────────
function calcRS(stockData, indexData) {
  if (!indexData || indexData.length === 0) return null;

  const idxMap = new Map(indexData.map((d) => [d.date, d]));
  const periods = [
    { label: "1 tuần", days: 5 },
    { label: "1 tháng", days: 22 },
    { label: "3 tháng", days: 66 },
    { label: "6 tháng", days: 132 },
    { label: "1 năm", days: 264 },
  ];

  const n = stockData.length;
  const latest = stockData[n - 1];
  const latestIdx = idxMap.get(latest.date);

  const results = [];
  for (const p of periods) {
    const startI = Math.max(0, n - p.days);
    const stockStart = stockData[startI];
    const stockPct =
      ((latest.price - stockStart.price) / stockStart.price) * 100;

    // Find matching index date
    let idxPct = null;
    const idxStart = idxMap.get(stockStart.date);
    if (latestIdx && idxStart) {
      idxPct = ((latestIdx.price - idxStart.price) / idxStart.price) * 100;
    }

    results.push({
      label: p.label,
      stockPct: Math.round(stockPct * 100) / 100,
      indexPct: idxPct != null ? Math.round(idxPct * 100) / 100 : null,
      outperform: idxPct != null ? stockPct > idxPct : null,
      rs:
        idxPct != null && idxPct !== 0
          ? Math.round((stockPct / idxPct) * 100) / 100
          : null,
    });
  }

  // Correlation (daily returns)
  const stockReturns = [],
    indexReturns = [];
  for (let i = 1; i < stockData.length; i++) {
    const idx = idxMap.get(stockData[i].date);
    const idxPrev = idxMap.get(stockData[i - 1].date);
    if (idx && idxPrev && stockData[i].price && stockData[i - 1].price) {
      stockReturns.push(
        (stockData[i].price - stockData[i - 1].price) / stockData[i - 1].price
      );
      indexReturns.push((idx.price - idxPrev.price) / idxPrev.price);
    }
  }
  let correlation = null;
  if (stockReturns.length > 20) {
    const avgS = stockReturns.reduce((a, b) => a + b, 0) / stockReturns.length;
    const avgI = indexReturns.reduce((a, b) => a + b, 0) / indexReturns.length;
    let cov = 0,
      varS = 0,
      varI = 0;
    for (let i = 0; i < stockReturns.length; i++) {
      cov += (stockReturns[i] - avgS) * (indexReturns[i] - avgI);
      varS += (stockReturns[i] - avgS) ** 2;
      varI += (indexReturns[i] - avgI) ** 2;
    }
    if (varS > 0 && varI > 0)
      correlation = Math.round((cov / Math.sqrt(varS * varI)) * 1000) / 1000;
  }

  return { periods: results, correlation };
}

// ── Volume analysis ──────────────────────────────────────────────────────────
function analyzeVolume(data) {
  const n = data.length;
  const latest = data[n - 1];
  const vols = data.map((d) => d.volume);
  const volMA20 = sma(vols, 20);
  const volMA50 = sma(vols, 50);

  const latestVol = latest.volume;
  const ma20Val = volMA20[n - 1];
  const ma50Val = volMA50[n - 1];

  // Volume trend (last 10 sessions)
  const recent10 = vols.slice(-10);
  const firstHalf = recent10.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const secondHalf = recent10.slice(5).reduce((a, b) => a + b, 0) / 5;

  let volTrend, volTrendDesc;
  if (secondHalf > firstHalf * 1.3) {
    volTrend = "increasing";
    volTrendDesc = "KLGD tăng mạnh — xác nhận xu hướng giá";
  } else if (secondHalf > firstHalf * 1.1) {
    volTrend = "slightly_increasing";
    volTrendDesc = "KLGD tăng nhẹ";
  } else if (secondHalf < firstHalf * 0.7) {
    volTrend = "decreasing";
    volTrendDesc = "KLGD giảm mạnh — xu hướng đang yếu";
  } else if (secondHalf < firstHalf * 0.9) {
    volTrend = "slightly_decreasing";
    volTrendDesc = "KLGD giảm nhẹ — cần theo dõi";
  } else {
    volTrend = "stable";
    volTrendDesc = "KLGD ổn định";
  }

  // Detect surge
  const ratio = ma20Val > 0 ? latestVol / ma20Val : 0;
  const isSurge = ratio > 2;

  return {
    latest: latestVol,
    ma20: Math.round(ma20Val || 0),
    ma50: Math.round(ma50Val || 0),
    ratio: Math.round(ratio * 100) / 100,
    isSurge,
    trend: volTrend,
    trendDesc: volTrendDesc,
  };
}

// ── Multi-timeframe Bullish / Bearish Patterns ──────────────────────────────
function detectMultiTimeframePatterns(data, prices, rsiArr, macdObj, bbObj, maLines) {
  const n = prices.length;
  const { ma20, ma50, ma200 } = maLines;

  function scan(label, sliceLen) {
    const start = Math.max(0, n - sliceLen);
    const d = data.slice(-sliceLen);
    const p = prices.slice(start);
    const vol = d.map(x => x.volume);
    const hi = d.map(x => x.high).filter(Boolean);
    const lo = d.map(x => x.low).filter(Boolean);
    const op = d.map(x => x.open).filter(Boolean);
    const cl = p;
    const ln = p.length;
    if (ln < 5) return { label, bullish: [], bearish: [] };

    const latest = p[ln - 1], prev = p[ln - 2] ?? latest;
    const rsiNow = rsiArr[n - 1], rsiPrev = rsiArr[n - 2];
    const macdH = macdObj.histogram;
    const macdNow = macdH[n - 1], macdPrev = macdH[n - 2];
    const m20 = ma20[n - 1], m50 = ma50[n - 1], m200 = ma200?.[n - 1];
    const bbU = bbObj.upper[n - 1], bbL = bbObj.lower[n - 1], bbM = bbObj.mid[n - 1];
    const pMin = Math.min(...p), pMax = Math.max(...p);
    const pctFromLow = pMin > 0 ? ((latest - pMin) / pMin * 100) : 0;
    const pctFromHigh = pMax > 0 ? ((pMax - latest) / pMax * 100) : 0;
    const avgVol = vol.reduce((a, b) => a + b, 0) / vol.length;
    const lastVol = vol[vol.length - 1] || 0;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

    // Higher highs / Higher lows detection
    const pivots = [];
    for (let i = 2; i < ln - 2; i++) {
      if (p[i] > p[i - 1] && p[i] > p[i - 2] && p[i] > p[i + 1] && p[i] > p[i + 2]) pivots.push({ i, p: p[i], type: 'H' });
      if (p[i] < p[i - 1] && p[i] < p[i - 2] && p[i] < p[i + 1] && p[i] < p[i + 2]) pivots.push({ i, p: p[i], type: 'L' });
    }
    const highs = pivots.filter(x => x.type === 'H');
    const lows = pivots.filter(x => x.type === 'L');
    const hh = highs.length >= 2 && highs[highs.length - 1].p > highs[highs.length - 2].p;
    const hl = lows.length >= 2 && lows[lows.length - 1].p > lows[lows.length - 2].p;
    const lh = highs.length >= 2 && highs[highs.length - 1].p < highs[highs.length - 2].p;
    const ll = lows.length >= 2 && lows[lows.length - 1].p < lows[lows.length - 2].p;

    // Candle patterns at end of slice
    const bullish = [], bearish = [];
    const li = d.length - 1;
    if (li >= 2) {
      const c0 = d[li], c1 = d[li - 1], c2 = d[li - 2];
      const o0 = c0.open, h0 = c0.high, l0 = c0.low, cl0 = c0.price;
      const o1 = c1.open, cl1 = c1.price;
      if (o0 && cl0 && o1 && cl1) {
        const body0 = Math.abs(cl0 - o0), range0 = (h0 || cl0) - (l0 || cl0) || 0.01;
        const uShadow = (h0 || cl0) - Math.max(o0, cl0), lShadow = Math.min(o0, cl0) - (l0 || cl0);

        // Candle patterns
        if (cl0 > o0 && lShadow > body0 * 2 && uShadow < body0 * 0.3) bullish.push({ name: "Hammer", strength: 70, desc: "Nến búa — tín hiệu đảo chiều tăng" });
        if (cl0 < o0 && uShadow > body0 * 2 && lShadow < body0 * 0.3) bearish.push({ name: "Shooting Star", strength: 70, desc: "Sao băng — tín hiệu đảo chiều giảm" });
        if (cl1 < o1 && cl0 > o0 && cl0 > o1 && o0 < cl1) bullish.push({ name: "Bullish Engulfing", strength: 80, desc: "Nhấn chìm tăng — phe mua áp đảo" });
        if (cl1 > o1 && cl0 < o0 && cl0 < o1 && o0 > cl1) bearish.push({ name: "Bearish Engulfing", strength: 80, desc: "Nhấn chìm giảm — phe bán áp đảo" });
        if (body0 / range0 < 0.1) {
          if (pctFromHigh < 5) bearish.push({ name: "Doji tại đỉnh", strength: 65, desc: "Doji gần đỉnh — do dự, có thể đảo chiều giảm" });
          else if (pctFromLow < 5) bullish.push({ name: "Doji tại đáy", strength: 65, desc: "Doji gần đáy — do dự, có thể đảo chiều tăng" });
        }
        if (cl0 > o0 && body0 / range0 > 0.7) bullish.push({ name: "Marubozu tăng", strength: 75, desc: "Nến tăng thân dài — áp lực mua rất mạnh" });
        if (cl0 < o0 && body0 / range0 > 0.7) bearish.push({ name: "Marubozu giảm", strength: 75, desc: "Nến giảm thân dài — áp lực bán rất mạnh" });

        // Morning/Evening Star
        if (c2.open && c2.price) {
          if (c2.price < c2.open && Math.abs(cl1 - o1) / ((c1.high || cl1) - (c1.low || cl1) || 1) < 0.3 && cl0 > o0 && cl0 > (c2.open + c2.price) / 2)
            bullish.push({ name: "Morning Star", strength: 85, desc: "Sao mai — đảo chiều tăng mạnh (3 nến)" });
          if (c2.price > c2.open && Math.abs(cl1 - o1) / ((c1.high || cl1) - (c1.low || cl1) || 1) < 0.3 && cl0 < o0 && cl0 < (c2.open + c2.price) / 2)
            bearish.push({ name: "Evening Star", strength: 85, desc: "Sao hôm — đảo chiều giảm mạnh (3 nến)" });
        }
      }
    }

    // ── Structural / Indicator patterns ──

    // MA crossovers
    if (m20 != null && m50 != null) {
      const m20p = ma20[n - 2], m50p = ma50[n - 2];
      if (m20p != null && m50p != null) {
        if (m20p < m50p && m20 > m50) bullish.push({ name: "Golden Cross (MA20×MA50)", strength: 85, desc: "MA20 cắt lên MA50 — tín hiệu tăng trung hạn" });
        if (m20p > m50p && m20 < m50) bearish.push({ name: "Death Cross (MA20×MA50)", strength: 85, desc: "MA20 cắt xuống MA50 — tín hiệu giảm trung hạn" });
      }
    }
    if (m50 != null && m200 != null) {
      const m50p = ma50[n - 2], m200p = ma200?.[n - 2];
      if (m50p != null && m200p != null) {
        if (m50p < m200p && m50 > m200) bullish.push({ name: "Golden Cross (MA50×MA200)", strength: 90, desc: "MA50 cắt lên MA200 — tín hiệu tăng dài hạn mạnh" });
        if (m50p > m200p && m50 < m200) bearish.push({ name: "Death Cross (MA50×MA200)", strength: 90, desc: "MA50 cắt xuống MA200 — tín hiệu giảm dài hạn mạnh" });
      }
    }

    // Price vs MA
    if (m20 != null && latest > m20 && prev <= m20) bullish.push({ name: "Breakout MA20", strength: 70, desc: "Giá vượt lên MA20 — xu hướng tăng ngắn hạn" });
    if (m20 != null && latest < m20 && prev >= m20) bearish.push({ name: "Breakdown MA20", strength: 70, desc: "Giá phá xuống MA20 — xu hướng giảm ngắn hạn" });
    if (m50 != null && latest > m50 && prev <= m50) bullish.push({ name: "Breakout MA50", strength: 75, desc: "Giá vượt lên MA50 — xác nhận xu hướng tăng" });
    if (m50 != null && latest < m50 && prev >= m50) bearish.push({ name: "Breakdown MA50", strength: 75, desc: "Giá phá xuống MA50 — xác nhận xu hướng giảm" });

    // RSI
    if (rsiNow != null) {
      if (rsiNow < 30) bullish.push({ name: "RSI Quá bán (<30)", strength: 70, desc: `RSI = ${rsiNow.toFixed(1)} — có thể hồi phục` });
      if (rsiNow > 70) bearish.push({ name: "RSI Quá mua (>70)", strength: 70, desc: `RSI = ${rsiNow.toFixed(1)} — có thể điều chỉnh` });
      if (rsiPrev != null) {
        if (rsiPrev < 30 && rsiNow > 30) bullish.push({ name: "RSI thoát vùng quá bán", strength: 75, desc: "RSI vượt lên 30 — tín hiệu hồi phục" });
        if (rsiPrev > 70 && rsiNow < 70) bearish.push({ name: "RSI thoát vùng quá mua", strength: 75, desc: "RSI rơi xuống 70 — tín hiệu suy yếu" });
      }
      // RSI divergence
      if (highs.length >= 2 && rsiNow < rsiArr[start + highs[highs.length - 2]?.i] && latest > highs[highs.length - 2]?.p)
        bearish.push({ name: "RSI phân kỳ âm", strength: 80, desc: "Giá tạo đỉnh cao hơn nhưng RSI thấp hơn — suy yếu" });
      if (lows.length >= 2 && rsiNow > rsiArr[start + lows[lows.length - 2]?.i] && latest < lows[lows.length - 2]?.p)
        bullish.push({ name: "RSI phân kỳ dương", strength: 80, desc: "Giá tạo đáy thấp hơn nhưng RSI cao hơn — tích lũy" });
    }

    // MACD
    if (macdNow != null && macdPrev != null) {
      if (macdPrev < 0 && macdNow > 0) bullish.push({ name: "MACD cắt lên 0", strength: 75, desc: "Histogram chuyển dương — động lực tăng" });
      if (macdPrev > 0 && macdNow < 0) bearish.push({ name: "MACD cắt xuống 0", strength: 75, desc: "Histogram chuyển âm — động lực giảm" });
      if (macdNow > 0 && macdNow > macdPrev) bullish.push({ name: "MACD tăng tốc", strength: 65, desc: "Histogram dương và đang tăng — momentum tốt" });
      if (macdNow < 0 && macdNow < macdPrev) bearish.push({ name: "MACD giảm tốc", strength: 65, desc: "Histogram âm và đang giảm — momentum xấu" });
    }

    // Bollinger Bands
    if (bbU != null && bbL != null) {
      if (latest > bbU) bearish.push({ name: "Vượt BB Upper", strength: 65, desc: "Giá trên dải Bollinger trên — quá mua, có thể quay lại" });
      if (latest < bbL) bullish.push({ name: "Dưới BB Lower", strength: 65, desc: "Giá dưới dải Bollinger dưới — quá bán, có thể hồi" });
      const bbWidth = bbU - bbL;
      if (bbM && bbWidth / bbM < 0.05) bullish.push({ name: "BB Squeeze", strength: 70, desc: "Bollinger Bands co hẹp — sắp có biến động lớn (breakout)" });
    }

    // Structure
    if (hh && hl) bullish.push({ name: "Higher Highs + Higher Lows", strength: 80, desc: "Cấu trúc tăng: đỉnh cao hơn, đáy cao hơn" });
    if (lh && ll) bearish.push({ name: "Lower Highs + Lower Lows", strength: 80, desc: "Cấu trúc giảm: đỉnh thấp hơn, đáy thấp hơn" });

    // Double bottom / top
    if (lows.length >= 2) {
      const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
      if (l1 && l2 && Math.abs(l1.p - l2.p) / l1.p < 0.02 && latest > l2.p * 1.03)
        bullish.push({ name: "Double Bottom", strength: 85, desc: `Hai đáy gần bằng nhau (~${l1.p.toFixed(1)}) — tín hiệu đảo chiều tăng` });
    }
    if (highs.length >= 2) {
      const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
      if (h1 && h2 && Math.abs(h1.p - h2.p) / h1.p < 0.02 && latest < h2.p * 0.97)
        bearish.push({ name: "Double Top", strength: 85, desc: `Hai đỉnh gần bằng nhau (~${h1.p.toFixed(1)}) — tín hiệu đảo chiều giảm` });
    }

    // Volume confirmation
    if (volRatio > 2 && latest > prev) bullish.push({ name: "KLGD đột biến + giá tăng", strength: 75, desc: `KLGD gấp ${volRatio.toFixed(1)}x TB — xác nhận lực mua` });
    if (volRatio > 2 && latest < prev) bearish.push({ name: "KLGD đột biến + giá giảm", strength: 75, desc: `KLGD gấp ${volRatio.toFixed(1)}x TB — xác nhận lực bán` });

    // Sort by strength
    bullish.sort((a, b) => b.strength - a.strength);
    bearish.sort((a, b) => b.strength - a.strength);

    return { label, sessions: sliceLen, bullish, bearish };
  }

  return {
    shortTerm: scan("Ngắn hạn (20 phiên)", 20),
    midTerm: scan("Trung hạn (60 phiên)", 60),
    longTerm: scan("Dài hạn (200 phiên)", Math.min(200, data.length)),
  };
}

// ── CANSLIM / SEPA / Momentum Scoring ────────────────────────────────────────
// Chỉ dùng dữ liệu giá/khối lượng (không có BCTC), nên đánh giá dựa trên
// price action, volume, relative strength, trend structure

function scoreCANSLIM(data, prices, volumes, rsi, macd, ma50, ma200, indexData) {
  const n = prices.length;
  const latest = prices[n - 1];
  const criteria = [];

  // C — Current Quarterly Earnings: proxy = xu hướng giá 1 quý (66 phiên)
  const q1 = Math.max(0, n - 66);
  const qReturn = ((latest - prices[q1]) / prices[q1]) * 100;
  const cScore = qReturn > 15 ? 10 : qReturn > 5 ? 7 : qReturn > 0 ? 4 : 1;
  criteria.push({ key: "C", name: "Đà tăng trưởng quý gần nhất", score: cScore, max: 10,
    detail: `Giá ${qReturn > 0 ? "tăng" : "giảm"} ${Math.abs(qReturn).toFixed(1)}% trong ~66 phiên qua`,
    pass: cScore >= 7 });

  // A — Annual Earnings: proxy = xu hướng giá 1 năm (264 phiên)
  const y1 = Math.max(0, n - 264);
  const yReturn = ((latest - prices[y1]) / prices[y1]) * 100;
  const aScore = yReturn > 30 ? 10 : yReturn > 10 ? 7 : yReturn > 0 ? 4 : 1;
  criteria.push({ key: "A", name: "Tăng trưởng dài hạn (1 năm)", score: aScore, max: 10,
    detail: `Giá ${yReturn > 0 ? "tăng" : "giảm"} ${Math.abs(yReturn).toFixed(1)}% trong ~1 năm`,
    pass: aScore >= 7 });

  // N — New: proxy = Giá gần đỉnh 52 tuần?
  const high52 = Math.max(...prices.slice(Math.max(0, n - 264)));
  const pctFromHigh = ((high52 - latest) / high52) * 100;
  const nScore = pctFromHigh < 5 ? 10 : pctFromHigh < 15 ? 7 : pctFromHigh < 30 ? 4 : 1;
  criteria.push({ key: "N", name: "Gần đỉnh mới (52 tuần)", score: nScore, max: 10,
    detail: `Cách đỉnh 52w: ${pctFromHigh.toFixed(1)}% (đỉnh: ${high52.toFixed(1)})`,
    pass: nScore >= 7 });

  // S — Supply & Demand: KLGD đột biến khi tăng giá
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[n - 1];
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const priceUp = latest > (prices[n - 2] || latest);
  const sScore = volRatio > 2 && priceUp ? 10 : volRatio > 1.5 && priceUp ? 7 : volRatio > 1 ? 4 : 2;
  criteria.push({ key: "S", name: "Cung cầu (KLGD + giá)", score: sScore, max: 10,
    detail: `KLGD ${volRatio.toFixed(1)}x TB20, giá ${priceUp ? "tăng ✓" : "giảm ✗"}`,
    pass: sScore >= 7 });

  // L — Leader or Laggard: RS vs Index
  let lScore = 5;
  let lDetail = "Không có dữ liệu index";
  if (indexData && indexData.length > 66) {
    const idxPrices = indexData.map(d => d.price).filter(Boolean);
    const in2 = idxPrices.length;
    const idxQ = ((idxPrices[in2 - 1] - idxPrices[Math.max(0, in2 - 66)]) / idxPrices[Math.max(0, in2 - 66)]) * 100;
    const rsRatio = idxQ !== 0 ? qReturn / idxQ : 0;
    lScore = rsRatio > 2 ? 10 : rsRatio > 1.2 ? 8 : rsRatio > 0.8 ? 5 : 2;
    lDetail = `RS ratio: ${rsRatio.toFixed(2)} (CP: ${qReturn.toFixed(1)}% vs VNI: ${idxQ.toFixed(1)}%)`;
  }
  criteria.push({ key: "L", name: "Dẫn dắt vs Thị trường", score: lScore, max: 10,
    detail: lDetail, pass: lScore >= 7 });

  // I — Institutional: proxy = Volume trend tăng dần
  const vol10ago = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
  const vol10now = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volGrowth = vol10ago > 0 ? ((vol10now - vol10ago) / vol10ago) * 100 : 0;
  const iScore = volGrowth > 30 ? 10 : volGrowth > 10 ? 7 : volGrowth > 0 ? 5 : 2;
  criteria.push({ key: "I", name: "Dòng tiền tổ chức (proxy KLGD)", score: iScore, max: 10,
    detail: `KLGD 10 phiên gần tăng ${volGrowth.toFixed(0)}% so với 10 phiên trước`,
    pass: iScore >= 7 });

  // M — Market Direction: xu hướng thị trường chung
  let mScore = 5, mDetail = "Không có index";
  if (indexData && indexData.length > 20) {
    const idxP = indexData.map(d => d.price).filter(Boolean);
    const idxN = idxP.length;
    const idxMA20 = idxP.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const idxLatest = idxP[idxN - 1];
    if (idxLatest > idxMA20 * 1.02) { mScore = 9; mDetail = "Thị trường uptrend (VNI > MA20)"; }
    else if (idxLatest > idxMA20 * 0.98) { mScore = 5; mDetail = "Thị trường sideway"; }
    else { mScore = 2; mDetail = "Thị trường downtrend (VNI < MA20)"; }
  }
  criteria.push({ key: "M", name: "Xu hướng thị trường (VNINDEX)", score: mScore, max: 10,
    detail: mDetail, pass: mScore >= 7 });

  const total = criteria.reduce((s, c) => s + c.score, 0);
  const maxTotal = criteria.reduce((s, c) => s + c.max, 0);
  const passCount = criteria.filter(c => c.pass).length;

  return { method: "CANSLIM", criteria, total, maxTotal, passCount, totalCriteria: criteria.length,
    grade: total >= 56 ? "A" : total >= 42 ? "B" : total >= 28 ? "C" : "D",
    verdict: total >= 56 ? "Rất tốt — đáp ứng hầu hết tiêu chí CANSLIM" :
             total >= 42 ? "Khá — có tiềm năng nhưng cần theo dõi thêm" :
             total >= 28 ? "Trung bình — thiếu nhiều tiêu chí" : "Yếu — không phù hợp CANSLIM"
  };
}

function scoreSEPA(data, prices, volumes, ma20, ma50, ma200, rsi) {
  const n = prices.length;
  const latest = prices[n - 1];
  const criteria = [];

  // Trend Template (Mark Minervini)
  // 1. Price > MA200
  const above200 = ma200[n - 1] != null && latest > ma200[n - 1];
  criteria.push({ name: "Giá > MA200", pass: above200, score: above200 ? 10 : 0, max: 10,
    detail: ma200[n - 1] ? `${latest.toFixed(1)} ${above200 ? ">" : "<"} MA200 (${ma200[n - 1].toFixed(1)})` : "Chưa đủ dữ liệu MA200" });

  // 2. MA50 > MA200
  const ma50above200 = ma50[n - 1] != null && ma200[n - 1] != null && ma50[n - 1] > ma200[n - 1];
  criteria.push({ name: "MA50 > MA200", pass: ma50above200, score: ma50above200 ? 10 : 0, max: 10,
    detail: ma50[n - 1] && ma200[n - 1] ? `MA50 (${ma50[n - 1].toFixed(1)}) ${ma50above200 ? ">" : "<"} MA200 (${ma200[n - 1].toFixed(1)})` : "N/A" });

  // 3. MA200 đang tăng (so 20 phiên trước)
  const ma200rising = ma200[n - 1] != null && ma200[n - 21] != null && ma200[n - 1] > ma200[n - 21];
  criteria.push({ name: "MA200 đang tăng", pass: ma200rising, score: ma200rising ? 10 : 0, max: 10,
    detail: ma200[n - 1] && ma200[n - 21] ? `MA200 hiện: ${ma200[n - 1].toFixed(1)} vs 20 phiên trước: ${ma200[n - 21]?.toFixed(1)}` : "N/A" });

  // 4. Price > MA50
  const above50 = ma50[n - 1] != null && latest > ma50[n - 1];
  criteria.push({ name: "Giá > MA50", pass: above50, score: above50 ? 10 : 0, max: 10,
    detail: ma50[n - 1] ? `${latest.toFixed(1)} ${above50 ? ">" : "<"} MA50 (${ma50[n - 1].toFixed(1)})` : "N/A" });

  // 5. Price > MA20 (near-term trend)
  const above20 = ma20[n - 1] != null && latest > ma20[n - 1];
  criteria.push({ name: "Giá > MA20", pass: above20, score: above20 ? 10 : 0, max: 10,
    detail: ma20[n - 1] ? `${latest.toFixed(1)} ${above20 ? ">" : "<"} MA20 (${ma20[n - 1].toFixed(1)})` : "N/A" });

  // 6. Giá cách đỉnh 52w không quá 25%
  const high52 = Math.max(...prices.slice(Math.max(0, n - 264)));
  const pctFromHigh = ((high52 - latest) / high52) * 100;
  const nearHigh = pctFromHigh < 25;
  criteria.push({ name: "Cách đỉnh 52w < 25%", pass: nearHigh, score: nearHigh ? 10 : pctFromHigh < 40 ? 5 : 0, max: 10,
    detail: `Cách đỉnh: ${pctFromHigh.toFixed(1)}% (đỉnh: ${high52.toFixed(1)})` });

  // 7. RS > 70 (dùng RSI làm proxy)
  const rsiOk = rsi[n - 1] != null && rsi[n - 1] > 50;
  criteria.push({ name: "RSI > 50 (momentum dương)", pass: rsiOk, score: rsiOk ? 10 : rsi[n - 1] > 40 ? 5 : 0, max: 10,
    detail: `RSI = ${rsi[n - 1]?.toFixed(1) ?? "N/A"}` });

  // 8. KLGD tăng khi giá tăng
  const vol20 = volumes.slice(-20);
  const price20 = prices.slice(-20);
  let upVolAvg = 0, upCount = 0, dnVolAvg = 0, dnCount = 0;
  for (let i = 1; i < vol20.length; i++) {
    if (price20[i] > price20[i - 1]) { upVolAvg += vol20[i]; upCount++; }
    else { dnVolAvg += vol20[i]; dnCount++; }
  }
  upVolAvg = upCount > 0 ? upVolAvg / upCount : 0;
  dnVolAvg = dnCount > 0 ? dnVolAvg / dnCount : 0;
  const volConfirm = upVolAvg > dnVolAvg * 1.1;
  criteria.push({ name: "KLGD ngày tăng > ngày giảm", pass: volConfirm, score: volConfirm ? 10 : 5, max: 10,
    detail: `Ngày tăng: ${Math.round(upVolAvg).toLocaleString()} vs ngày giảm: ${Math.round(dnVolAvg).toLocaleString()}` });

  const total = criteria.reduce((s, c) => s + c.score, 0);
  const maxTotal = criteria.reduce((s, c) => s + c.max, 0);
  const passCount = criteria.filter(c => c.pass).length;

  return { method: "SEPA (Minervini)", criteria, total, maxTotal, passCount, totalCriteria: criteria.length,
    grade: passCount >= 7 ? "A" : passCount >= 5 ? "B" : passCount >= 3 ? "C" : "D",
    verdict: passCount >= 7 ? "Trend Template hoàn hảo — cổ phiếu ở giai đoạn 2 (tăng trưởng)" :
             passCount >= 5 ? "Gần đạt Trend Template — theo dõi chờ hoàn thiện" :
             passCount >= 3 ? "Chưa đạt — có thể đang ở giai đoạn 1 (tích lũy) hoặc 3 (phân phối)" :
             "Không đạt — cổ phiếu đang ở giai đoạn 4 (downtrend)"
  };
}

function scoreMomentum(data, prices, volumes, rsi, macd, ma20, ma50) {
  const n = prices.length;
  const latest = prices[n - 1];
  const criteria = [];

  // 1. Price Momentum (ROC 20)
  const roc20 = n > 20 ? ((latest - prices[n - 21]) / prices[n - 21]) * 100 : 0;
  const roc20Score = roc20 > 10 ? 10 : roc20 > 5 ? 8 : roc20 > 0 ? 5 : roc20 > -5 ? 3 : 1;
  criteria.push({ name: "Price ROC (20 phiên)", score: roc20Score, max: 10,
    detail: `Thay đổi 20 phiên: ${roc20 > 0 ? "+" : ""}${roc20.toFixed(1)}%`,
    pass: roc20Score >= 7 });

  // 2. Price Momentum (ROC 60)
  const roc60 = n > 60 ? ((latest - prices[n - 61]) / prices[n - 61]) * 100 : 0;
  const roc60Score = roc60 > 20 ? 10 : roc60 > 10 ? 8 : roc60 > 0 ? 5 : roc60 > -10 ? 3 : 1;
  criteria.push({ name: "Price ROC (60 phiên)", score: roc60Score, max: 10,
    detail: `Thay đổi 60 phiên: ${roc60 > 0 ? "+" : ""}${roc60.toFixed(1)}%`,
    pass: roc60Score >= 7 });

  // 3. RSI Momentum
  const rsiNow = rsi[n - 1];
  const rsiScore = rsiNow > 60 ? 10 : rsiNow > 50 ? 7 : rsiNow > 40 ? 4 : 1;
  criteria.push({ name: "RSI Momentum", score: rsiScore, max: 10,
    detail: `RSI = ${rsiNow?.toFixed(1) ?? "N/A"} ${rsiNow > 60 ? "(mạnh)" : rsiNow > 50 ? "(trung tính+)" : "(yếu)"}`,
    pass: rsiScore >= 7 });

  // 4. MACD Momentum
  const mH = macd.histogram[n - 1], mHP = macd.histogram[n - 2];
  const macdAccel = mH != null && mHP != null && mH > mHP;
  const macdPos = mH > 0;
  const macdScore = macdPos && macdAccel ? 10 : macdPos ? 7 : !macdPos && macdAccel ? 5 : 2;
  criteria.push({ name: "MACD Histogram", score: macdScore, max: 10,
    detail: `Histogram: ${mH?.toFixed(3) ?? "N/A"} ${macdPos ? "(dương)" : "(âm)"} ${macdAccel ? "↑ tăng tốc" : "↓ giảm tốc"}`,
    pass: macdScore >= 7 });

  // 5. Trend Alignment (giá vs MA20 vs MA50)
  const aboveMA20 = ma20[n - 1] != null && latest > ma20[n - 1];
  const aboveMA50 = ma50[n - 1] != null && latest > ma50[n - 1];
  const ma20aboveMA50 = ma20[n - 1] != null && ma50[n - 1] != null && ma20[n - 1] > ma50[n - 1];
  const trendScore = (aboveMA20 && aboveMA50 && ma20aboveMA50) ? 10 : (aboveMA20 && aboveMA50) ? 7 : aboveMA20 ? 4 : 1;
  criteria.push({ name: "Trend Alignment (MA)", score: trendScore, max: 10,
    detail: `Giá ${aboveMA20 ? ">" : "<"} MA20, ${aboveMA50 ? ">" : "<"} MA50, MA20 ${ma20aboveMA50 ? ">" : "<"} MA50`,
    pass: trendScore >= 7 });

  // 6. Volume Momentum
  const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volMom = vol20 > 0 ? vol5 / vol20 : 1;
  const volScore = volMom > 1.5 ? 10 : volMom > 1.2 ? 7 : volMom > 0.8 ? 4 : 1;
  criteria.push({ name: "Volume Momentum", score: volScore, max: 10,
    detail: `KLGD 5 phiên / 20 phiên: ${volMom.toFixed(2)}x ${volMom > 1.2 ? "(tăng)" : volMom > 0.8 ? "(ổn định)" : "(giảm)"}`,
    pass: volScore >= 7 });

  // 7. Breakout Momentum (giá so với Bollinger Upper)
  const highs20 = prices.slice(-20);
  const highest20 = Math.max(...highs20);
  const nearBreakout = latest >= highest20 * 0.98;
  const bkScore = latest > highest20 ? 10 : nearBreakout ? 7 : 3;
  criteria.push({ name: "Breakout (đỉnh 20 phiên)", score: bkScore, max: 10,
    detail: `Giá ${latest.toFixed(1)} vs đỉnh 20p ${highest20.toFixed(1)} ${latest > highest20 ? "— ĐÃ BREAKOUT" : nearBreakout ? "— gần breakout" : "— chưa"}`,
    pass: bkScore >= 7 });

  const total = criteria.reduce((s, c) => s + c.score, 0);
  const maxTotal = criteria.reduce((s, c) => s + c.max, 0);
  const passCount = criteria.filter(c => c.pass).length;

  return { method: "Momentum", criteria, total, maxTotal, passCount, totalCriteria: criteria.length,
    grade: total >= 56 ? "A" : total >= 42 ? "B" : total >= 28 ? "C" : "D",
    verdict: total >= 56 ? "Momentum cực mạnh — xu hướng tăng rõ ràng, tất cả chỉ báo đồng thuận" :
             total >= 42 ? "Momentum tích cực — đang có đà nhưng chưa hoàn toàn" :
             total >= 28 ? "Momentum trung tính — thiếu xác nhận rõ ràng" :
             "Momentum yếu/âm — xu hướng giảm hoặc sideway"
  };
}

// ── Đánh giá nhóm đầu tư: Ngắn / Trung / Dài hạn ──────────────────────────
function assessInvestmentProfile(data, prices, volumes, rsi, macd, bb, ma20, ma50, ma200, trend, vol, indexData) {
  const n = prices.length;
  const latest = prices[n - 1];

  function assess(label, period, desc) {
    const start = Math.max(0, n - period);
    const p = prices.slice(start);
    const v = volumes.slice(start);
    const ln = p.length;
    if (ln < 5) return { label, period, desc, score: 0, max: 100, grade: "N/A", verdict: "Không đủ dữ liệu", factors: [] };

    const factors = [];
    let score = 0;

    // 1. Xu hướng giá (25đ)
    const ret = ((p[ln - 1] - p[0]) / p[0]) * 100;
    const annualized = period >= 200 ? ret : ret * (264 / period);
    let trendScore;
    if (period <= 25) trendScore = ret > 5 ? 25 : ret > 2 ? 20 : ret > 0 ? 12 : ret > -5 ? 5 : 0;
    else if (period <= 80) trendScore = ret > 15 ? 25 : ret > 5 ? 20 : ret > 0 ? 12 : ret > -10 ? 5 : 0;
    else trendScore = annualized > 20 ? 25 : annualized > 10 ? 20 : annualized > 0 ? 12 : annualized > -10 ? 5 : 0;
    score += trendScore;
    factors.push({ name: "Xu hướng giá", score: trendScore, max: 25,
      detail: `${ret > 0 ? "+" : ""}${ret.toFixed(1)}% trong ${ln} phiên${period >= 100 ? ` (quy năm: ${annualized.toFixed(0)}%)` : ""}`,
      signal: trendScore >= 20 ? "bullish" : trendScore >= 12 ? "neutral" : "bearish" });

    // 2. Biến động (20đ)
    let sumDr = 0;
    for (let i = 1; i < ln; i++) sumDr += Math.abs(p[i] - p[i - 1]) / p[i - 1];
    const avgDailyVol = (sumDr / (ln - 1)) * 100;
    let volScore;
    if (period <= 25) volScore = avgDailyVol > 3 ? 20 : avgDailyVol > 2 ? 16 : avgDailyVol > 1.5 ? 10 : 5;
    else if (period <= 80) volScore = avgDailyVol > 1.5 && avgDailyVol < 4 ? 20 : avgDailyVol > 1 ? 14 : 8;
    else volScore = avgDailyVol < 2 ? 20 : avgDailyVol < 3 ? 14 : avgDailyVol < 4 ? 8 : 3;
    score += volScore;
    factors.push({ name: "Biến động", score: volScore, max: 20,
      detail: `${avgDailyVol.toFixed(2)}%/ngày (${avgDailyVol > 3 ? "Cao" : avgDailyVol > 2 ? "TB" : "Thấp"})`,
      signal: volScore >= 16 ? "bullish" : volScore >= 10 ? "neutral" : "bearish" });

    // 3. Thanh khoản (15đ)
    const avgV = v.reduce((a, b) => a + b, 0) / v.length;
    let liqScore;
    if (period <= 25) liqScore = avgV > 1000000 ? 15 : avgV > 500000 ? 12 : avgV > 100000 ? 7 : 3;
    else liqScore = avgV > 500000 ? 15 : avgV > 200000 ? 12 : avgV > 50000 ? 8 : 3;
    score += liqScore;
    factors.push({ name: "Thanh khoản", score: liqScore, max: 15,
      detail: `TB ${Math.round(avgV).toLocaleString("en-US")} CP/phiên`,
      signal: liqScore >= 12 ? "bullish" : liqScore >= 7 ? "neutral" : "bearish" });

    // 4. Vị trí kỹ thuật (20đ)
    const m20v = ma20[n - 1], m50v = ma50[n - 1], m200v = ma200?.[n - 1];
    const rsiNow = rsi[n - 1], macdH = macd.histogram[n - 1];
    let techScore = 0, techD = [];
    if (period <= 25) {
      if (m20v && latest > m20v) { techScore += 7; techD.push("Giá > MA20"); }
      if (rsiNow > 40 && rsiNow < 70) { techScore += 7; techD.push(`RSI ${rsiNow.toFixed(0)}`); }
      else if (rsiNow <= 30) { techScore += 4; techD.push(`RSI ${rsiNow.toFixed(0)} quá bán`); }
      if (macdH > 0) { techScore += 6; techD.push("MACD+"); }
    } else if (period <= 80) {
      if (m50v && latest > m50v) { techScore += 7; techD.push("Giá > MA50"); }
      if (m20v && m50v && m20v > m50v) { techScore += 7; techD.push("MA20 > MA50"); }
      if (rsiNow > 45 && rsiNow < 75) { techScore += 6; techD.push(`RSI ${rsiNow.toFixed(0)}`); }
    } else {
      if (m200v && latest > m200v) { techScore += 8; techD.push("Giá > MA200"); }
      if (m50v && m200v && m50v > m200v) { techScore += 7; techD.push("MA50 > MA200"); }
      if (m200v && ma200[n - 21] && m200v > ma200[n - 21]) { techScore += 5; techD.push("MA200 ↑"); }
    }
    techScore = Math.min(techScore, 20);
    score += techScore;
    factors.push({ name: "Vị trí kỹ thuật", score: techScore, max: 20,
      detail: techD.length ? techD.join(" · ") : "Không đạt",
      signal: techScore >= 15 ? "bullish" : techScore >= 8 ? "neutral" : "bearish" });

    // 5. Risk/Reward (20đ)
    const high52 = Math.max(...prices.slice(Math.max(0, n - 264)));
    const low52 = Math.min(...prices.slice(Math.max(0, n - 264)));
    const pctFromHigh = ((high52 - latest) / high52) * 100;
    const range52 = high52 - low52;
    const posInRange = range52 > 0 ? ((latest - low52) / range52) * 100 : 50;
    let rrScore, rrDetail;
    if (period <= 25) {
      rrScore = pctFromHigh < 10 ? 20 : pctFromHigh < 20 ? 14 : pctFromHigh < 35 ? 8 : 3;
      rrDetail = `Cách đỉnh 52w: ${pctFromHigh.toFixed(1)}%`;
    } else if (period <= 80) {
      rrScore = posInRange > 30 && posInRange < 70 ? 20 : posInRange >= 70 ? 10 : 12;
      rrDetail = `Vị trí ${posInRange.toFixed(0)}% trong range 52w`;
    } else {
      rrScore = posInRange < 40 ? 20 : posInRange < 60 ? 14 : posInRange < 80 ? 8 : 3;
      rrDetail = `Vị trí ${posInRange.toFixed(0)}% range — ${posInRange < 50 ? "vùng giá trị" : "vùng đắt"}`;
    }
    score += rrScore;
    factors.push({ name: "Risk / Reward", score: rrScore, max: 20,
      detail: rrDetail, signal: rrScore >= 15 ? "bullish" : rrScore >= 8 ? "neutral" : "bearish" });

    const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : "D";
    const suitability = score >= 80 ? "Rất phù hợp" : score >= 65 ? "Phù hợp" : score >= 45 ? "Trung bình" : "Không phù hợp";
    let verdict, suggestion;
    if (period <= 25) {
      verdict = score >= 70 ? "Momentum tốt, thanh khoản cao — phù hợp swing trading 1-4 tuần" : score >= 50 ? "Có thể lướt sóng, cần kỷ luật stoploss" : "Không nên giao dịch ngắn hạn lúc này";
      suggestion = score >= 70 ? "Vào lệnh khi breakout hoặc pullback về MA20, stoploss 3-5%" : score >= 50 ? "Chờ pullback về MA20, stoploss chặt 3%" : "Chờ đợi hoặc chuyển mã khác";
    } else if (period <= 80) {
      verdict = score >= 70 ? "Xu hướng trung hạn rõ ràng — phù hợp nắm giữ 1-6 tháng" : score >= 50 ? "Có tiềm năng nhưng chưa đủ xác nhận" : "Không phù hợp đầu tư trung hạn hiện tại";
      suggestion = score >= 70 ? "Mua tại hỗ trợ hoặc breakout MA50, R:R ≥ 2:1" : score >= 50 ? "Chờ giá vượt MA50 + KLGD xác nhận" : "Bỏ qua, quay lại khi MA20 cắt lên MA50";
    } else {
      verdict = score >= 70 ? "Nền tảng vững — phù hợp tích lũy dài hạn 6+ tháng" : score >= 50 ? "Có yếu tố dài hạn, đang tích lũy" : "Chưa phù hợp đầu tư dài hạn";
      suggestion = score >= 70 ? "DCA mỗi tháng tại vùng hỗ trợ, review mỗi quý" : score >= 50 ? "Vị thế nhỏ 30%, thêm khi MA50 > MA200" : "Chờ tín hiệu đáy (giá > MA200)";
    }
    return { label, period, desc, score, max: 100, grade, suitability, verdict, suggestion, factors,
      bullCount: factors.filter(f => f.signal === "bullish").length,
      bearCount: factors.filter(f => f.signal === "bearish").length };
  }

  const st = assess("Ngắn hạn", 20, "Swing trading 1-4 tuần");
  const mt = assess("Trung hạn", 60, "Position trading 1-6 tháng");
  const lt = assess("Dài hạn", 200, "Đầu tư 6+ tháng");

  // Tìm nhóm phù hợp nhất
  const all = [st, mt, lt];
  const best = all.reduce((a, b) => a.score > b.score ? a : b);

  return { shortTerm: st, midTerm: mt, longTerm: lt, bestFit: best.label };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════════════════════════════════════
export async function analyzeDetail(tmpDir, symbol, options = {}) {
  const { cacheDir = "cache" } = options;

  symbol = symbol.toUpperCase().trim();
  const stockFile = path.join(tmpDir, `${symbol}.xlsx`);
  const indexFile = path.join(tmpDir, "VNINDEX.xlsx");

  if (!fs.existsSync(stockFile))
    return { error: `File ${stockFile} không tồn tại` };

  let stockData, indexData;
  try {
    stockData = await readXlsx(stockFile);
  } catch (e) {
    return { error: `Lỗi đọc file ${symbol}: ${e.message}` };
  }
  if (!stockData || stockData.length < 30)
    return {
      error: `Dữ liệu ${symbol} quá ít (${
        stockData?.length ?? 0
      } phiên, cần ≥30)`,
    };

  try {
    indexData = fs.existsSync(indexFile) ? await readXlsx(indexFile) : null;
  } catch {
    indexData = null;
  }

  const prices = stockData.map((d) => d.price).filter(Boolean);
  const n = prices.length;
  const latest = stockData[stockData.length - 1];

  // Indicators
  const ma5 = sma(prices, 5);
  const ma10 = sma(prices, 10);
  const ma20 = sma(prices, 20);
  const ma50 = sma(prices, 50);
  const ma200 = sma(prices, 200);
  const rsi = calcRSI(prices);
  const macd = calcMACD(prices);
  const bb = calcBB(prices);
  const atr = calcATR(stockData, 14);

  // Trend analysis
  const trend = determineTrend(prices, ma20, ma50, ma200, rsi, macd);

  // Support / Resistance
  const sr = findSupportResistance(stockData.slice(-200), latest.price);

  // Candle patterns
  const patterns = detectLatestPatterns(stockData);

  // Volume
  const vol = analyzeVolume(stockData);

  // RS vs Index
  const rs = calcRS(stockData, indexData);

  // Predictions
  const predictions = generatePredictions(stockData, trend, sr, bb, rsi, macd);

  // Multi-timeframe patterns
  const mtfPatterns = detectMultiTimeframePatterns(stockData, prices, rsi, macd, bb, { ma20, ma50, ma200 });

  // Scoring methodologies
  const vols = stockData.map(d => d.volume);
  const canslim = scoreCANSLIM(stockData, prices, vols, rsi, macd, ma50, ma200, indexData);
  const sepa = scoreSEPA(stockData, prices, vols, ma20, ma50, ma200, rsi);
  const momentum = scoreMomentum(stockData, prices, vols, rsi, macd, ma20, ma50);

  // Investment horizon profile
  const investProfile = assessInvestmentProfile(stockData, prices, vols, rsi, macd, bb, ma20, ma50, ma200, trend, vol, indexData);

  // Chart data (last 264 sessions)
  const chartLen = Math.min(264, stockData.length);
  const chartData = stockData.slice(-chartLen);
  const chartPrices = prices.slice(-chartLen);

  const result = {
    symbol,
    latestDate: latest.date,
    latestPrice: latest.price,
    latestOpen: latest.open,
    latestHigh: latest.high,
    latestLow: latest.low,
    latestChange: latest.change,
    totalSessions: stockData.length,
    dateRange: { from: stockData[0].date, to: latest.date },
    indicators: {
      ma5: ma5[n - 1] ? Math.round(ma5[n - 1] * 100) / 100 : null,
      ma10: ma10[n - 1] ? Math.round(ma10[n - 1] * 100) / 100 : null,
      ma20: ma20[n - 1] ? Math.round(ma20[n - 1] * 100) / 100 : null,
      ma50: ma50[n - 1] ? Math.round(ma50[n - 1] * 100) / 100 : null,
      ma200: ma200[n - 1] ? Math.round(ma200[n - 1] * 100) / 100 : null,
      rsi: rsi[n - 1] ? Math.round(rsi[n - 1] * 100) / 100 : null,
      macd: macd.macdLine[n - 1]
        ? Math.round(macd.macdLine[n - 1] * 1000) / 1000
        : null,
      macdSignal: macd.signal[n - 1]
        ? Math.round(macd.signal[n - 1] * 1000) / 1000
        : null,
      macdHistogram: macd.histogram[n - 1]
        ? Math.round(macd.histogram[n - 1] * 1000) / 1000
        : null,
      bbUpper: bb.upper[n - 1] ? Math.round(bb.upper[n - 1] * 100) / 100 : null,
      bbMid: bb.mid[n - 1] ? Math.round(bb.mid[n - 1] * 100) / 100 : null,
      bbLower: bb.lower[n - 1] ? Math.round(bb.lower[n - 1] * 100) / 100 : null,
      atr: atr[n - 1] ? Math.round(atr[n - 1] * 100) / 100 : null,
      atrPct: atr[n - 1] && prices[n - 1] ? Math.round(atr[n - 1] / prices[n - 1] * 10000) / 100 : null,
    },
    trend,
    supportResistance: sr,
    candlePatterns: patterns,
    volume: vol,
    rsVsIndex: rs,
    predictions,
    multiTimeframePatterns: mtfPatterns,
    scoring: { canslim, sepa, momentum },
    investmentProfile: investProfile,
    chart: {
      labels: chartData.map((d) => d.date),
      prices: chartData.map((d) => d.price),
      opens: chartData.map((d) => d.open),
      highs: chartData.map((d) => d.high),
      lows: chartData.map((d) => d.low),
      volumes: chartData.map((d) => d.volume),
      ma20: sma(chartPrices, 20),
      ma50: sma(chartPrices, 50),
      rsi: calcRSI(chartPrices),
      macdHist: calcMACD(chartPrices).histogram,
      bbUpper: calcBB(chartPrices).upper,
      bbMid: calcBB(chartPrices).mid,
      bbLower: calcBB(chartPrices).lower,
      srLevels: {
        supports: sr.supports,
        resistances: sr.resistances,
      },
    },
  };

  // Save to cache/{symbol}/
  try {
    const outDir = path.join(cacheDir, symbol);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "analysis.json"),
      JSON.stringify(result, null, 2),
      "utf8"
    );
    console.log(`  ✅ Saved: ${outDir}/analysis.json`);
  } catch (e) {
    console.warn("Cache write error:", e.message);
  }

  return result;
}
