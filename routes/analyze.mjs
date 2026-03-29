import fs from "fs";
import path from "path";
import { sendJSON, BASE_DIR, SSI_HEADERS } from "../lib/utils.mjs";
import { analyzeAll, analyzeDetail } from "../analyze.mjs";

const COMPANY_INFO_CACHE = path.join(BASE_DIR, "database", "company_info.json");

function currentWeekKey() {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const week = Math.ceil(((now - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function parseCSVLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

async function getCompanyInfo(symbol) {
  const weekKey = currentWeekKey();
  let cache = {};
  try { if (fs.existsSync(COMPANY_INFO_CACHE)) cache = JSON.parse(fs.readFileSync(COMPANY_INFO_CACHE, "utf8")); }
  catch (_) {}

  if (cache[symbol]?.weekKey === weekKey) return cache[symbol].data;

  // Đọc sectors CSV
  let nameVi = "", nameEn = "", icbCode = "", sectorVi = "", sectorEn = "", exchange = "";
  const ssiPath = path.join(BASE_DIR, "database", "ssi_sectors.csv");
  if (fs.existsSync(ssiPath)) {
    for (const line of fs.readFileSync(ssiPath, "utf8").split("\n").slice(1)) {
      if (!line.trim()) continue;
      const c = parseCSVLine(line);
      if ((c[1]?.trim() ?? "") !== symbol) continue;
      icbCode = c[2]?.trim() ?? ""; sectorVi = c[3]?.trim() ?? "";
      sectorEn = c[4]?.trim() ?? ""; nameVi = c[5]?.trim() ?? "";
      exchange = c[6]?.trim() ?? "";
      break;
    }
  }

  // Fetch SSI live
  let indexGroups = [], parValue = null, isin = "", nameEnLive = "";
  let issueShare = null, outstandingShare = null, charterCapital = null, foundingDate = null, numberOfEmployee = null;

  // Fetch song song: stock info + company profile
  await Promise.all([
    fetch(`https://iboard-query.ssi.com.vn/stock?symbol=${symbol}`, { headers: SSI_HEADERS })
      .then(r => r.json())
      .then(j => {
        const stock = (j.data ?? []).find(s => s.stockSymbol === symbol && s.stockType === "s" && s.boardId === "MAIN")
                    ?? (j.data ?? []).find(s => s.stockSymbol === symbol && s.stockType === "s");
        if (stock) {
          indexGroups = stock.indexGroups ?? [];
          parValue = stock.parValue ?? null;
          isin = stock.isin ?? "";
          nameEnLive = stock.companyNameEn ?? "";
          if (!nameVi && stock.companyNameVi) nameVi = stock.companyNameVi;
          if (!exchange && stock.exchange)
            exchange = { hose: "HOSE", hnx: "HASTC", upcom: "UPCOM" }[stock.exchange] ?? stock.exchange;
        }
      }).catch(() => {}),

    fetch(`https://iboard-api.ssi.com.vn/statistics/company/company-profile?symbol=${symbol}`, { headers: SSI_HEADERS })
      .then(r => r.json())
      .then(j => {
        const p = j.data;
        if (!p) return;
        issueShare      = p.issueShare > 0 ? Math.round(p.issueShare) : null;
        outstandingShare = p.quantity > 0 ? Math.round(p.quantity) : null;
        charterCapital  = p.charterCapital > 0 ? p.charterCapital : null;
        foundingDate    = p.foundingDate ? p.foundingDate.split(" ")[0] : null;
        numberOfEmployee = p.numberOfEmployee > 0 ? p.numberOfEmployee : null;
        if (!icbCode && p.subSectorCode) icbCode = String(p.subSectorCode);
        if (!exchange && p.exchange) exchange = p.exchange;
        if (!nameVi && p.companyName) nameVi = p.companyName;
      }).catch(() => {}),
  ]);

  const data = { symbol, nameVi, nameEn: nameEnLive || nameEn, icbCode, sectorVi, sectorEn, exchange, indexGroups, parValue, isin, issueShare, outstandingShare, charterCapital, foundingDate, numberOfEmployee };
  try { cache[symbol] = { weekKey, data }; fs.writeFileSync(COMPANY_INFO_CACHE, JSON.stringify(cache, null, 2), "utf8"); } catch (_) {}
  return data;
}

export async function handle(req, res, { pathname, parsed }) {
  if (pathname === "/analyze" && req.method === "GET") {
    const maPeriod = parseInt(parsed.query.ma) || 20;
    const result = await analyzeAll(null, { maPeriod });
    sendJSON(res, result.error ? 400 : 200, result);
    return true;
  }

  // ─── Detail analysis ───────────────────────────────────────────────────────
  if (pathname === "/analyze-detail" && req.method === "GET") {
    const symbol = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!symbol) { sendJSON(res, 400, { error: "Thiếu tham số symbol" }); return true; }

    console.log(
      `\n[${new Date().toLocaleTimeString(
        "vi-VN"
      )}] 🔍 Phân tích chi tiết: ${symbol}`
    );
    try {
      const lite = parsed.query.lite === "1";
      const [result, companyInfo] = await Promise.all([
        analyzeDetail(null, symbol),
        lite ? Promise.resolve(null) : getCompanyInfo(symbol),
      ]);
      if (!result.error && companyInfo) result.companyInfo = companyInfo;
      sendJSON(res, result.error ? 400 : 200, result);
    } catch (err) {
      console.error(`   ❌ Lỗi: ${err.message}`);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
