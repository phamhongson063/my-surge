import fs from "fs";
import path from "path";
import { sendJSON, BASE_DIR } from "../lib/utils.mjs";
import { fetchMarketSnapshot } from "../lib/snapshot.mjs";

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

export async function handle(req, res, { pathname, parsed }) {
  // ─── API: Sectors — đọc database/ssi_sectors.csv (ICB SSI) ─────────────────
  if (pathname === "/api/sectors") {
    const ssiPath = path.join(BASE_DIR, "database", "ssi_sectors.csv");
    const stocksPath = path.join(BASE_DIR, "database", "stocks.csv");

    if (!fs.existsSync(ssiPath)) {
      sendJSON(res, 404, {
        error:
          "ssi_sectors.csv not found. Chạy: node batch/fetch_ssi_sectors.mjs",
      });
      return true;
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

    sendJSON(res, 200, result);
    return true;
  }

  // ─── API: All-sectors comparison ─────────────────────────────────────────────
  if (pathname === "/api/all-sectors-analysis" && req.method === "GET") {
    const ssiPath = path.join(BASE_DIR, "database", "ssi_sectors.csv");
    if (!fs.existsSync(ssiPath)) {
      sendJSON(res, 404, { error: "ssi_sectors.csv not found" });
      return true;
    }

    const ssiLines = fs.readFileSync(ssiPath, "utf8").split("\n");
    const sectorsMap = new Map();
    for (const line of ssiLines.slice(1)) {
      if (!line.trim()) continue;
      const c = parseCSVLine(line);
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
    sendJSON(res, 200, results);
    return true;
  }

  // ─── API: Sector analysis — compute metrics from cached history ──────────────
  if (pathname === "/api/sector-analysis" && req.method === "GET") {
    const symsParam = parsed.query.symbols || "";
    const symbols = symsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{1,10}$/.test(s));
    if (!symbols.length) {
      sendJSON(res, 400, { error: "Thiếu symbols" });
      return true;
    }

    const histDir = path.join(BASE_DIR, "database", "history");
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
      sendJSON(res, 200, {
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
      return true;
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

    sendJSON(res, 200, {
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
    return true;
  }

  return false;
}
