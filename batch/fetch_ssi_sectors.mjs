/**
 * fetch_ssi_sectors.mjs
 * Lấy danh sách cổ phiếu theo ngành ICB từ SSI iboard API.
 * - Tên công ty + sàn: lấy từ SSI /stock endpoint (nguồn chính)
 * - Fallback: stocks.csv cho các mã không có trong SSI /stock
 * - Mã không tìm thấy trong SSI /stock → đánh dấu "Hủy niêm yết"
 * Lưu vào: database/ssi_sectors.csv
 *
 * Chạy: node batch/fetch_ssi_sectors.mjs
 */

import https from "https";
import fs    from "fs";
import path  from "path";
import url   from "url";

const BASE_DIR    = path.dirname(url.fileURLToPath(import.meta.url));
const OUT_PATH    = path.join(BASE_DIR, "..", "database", "ssi_sectors.csv");
const STOCKS_PATH = path.join(BASE_DIR, "..", "database", "stocks.csv");

const SSI_SECTORS_URL = "https://iboard-api.ssi.com.vn/statistics/company/sectors-data";
const SSI_STOCKS_URL  = "https://iboard-query.ssi.com.vn/stock?symbol=_";

// Exchange SSI → tên chuẩn
const SAN_MAP = { hose: "HOSE", hnx: "HASTC", upcom: "UPCOM" };

// ── Fetch helper ──────────────────────────────────────────────────────────────
function fetchJSON(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Origin":  "https://iboard.ssi.com.vn",
        "Referer": "https://iboard.ssi.com.vn/",
        "Accept":  "application/json",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── Đọc stocks.csv → symbol → { title, san } làm fallback ────────────────────
function loadFallbackCSV() {
  if (!fs.existsSync(STOCKS_PATH)) return {};
  const lines   = fs.readFileSync(STOCKS_PATH, "utf8").replace(/^\uFEFF/, "").split("\n");
  const headers = lines[0].split(",");
  const iSym   = headers.indexOf("Symbol");
  const iTitle = headers.indexOf("Title");
  const iSan   = headers.indexOf("Sàn giao dịch");
  const map    = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const sym  = cols[iSym]?.trim();
    if (!sym) continue;
    map[sym] = { title: cols[iTitle]?.trim() ?? "", san: cols[iSan]?.trim() ?? "" };
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Đang tải dữ liệu từ SSI (song song)...");

  const [sectorsJson, stocksJson] = await Promise.all([
    fetchJSON(SSI_SECTORS_URL),
    fetchJSON(SSI_STOCKS_URL),
  ]);

  // ── Validate ───────────────────────────────────────────────────────────────
  if (sectorsJson.code !== "SUCCESS" || !Array.isArray(sectorsJson.data)) {
    console.error("Lỗi sectors API:", sectorsJson);
    process.exit(1);
  }
  if (stocksJson.code !== "SUCCESS" || !Array.isArray(stocksJson.data)) {
    console.error("Lỗi stocks API:", stocksJson);
    process.exit(1);
  }

  // ── Build map symbol → { title, san } từ SSI /stock (nguồn chính) ─────────
  // Chỉ lấy stockType = 's' (cổ phiếu đang niêm yết)
  const activeSet  = new Set(); // mã đang niêm yết
  const symbolInfo = {};
  for (const s of stocksJson.data) {
    if (!s.stockSymbol || s.stockType !== "s") continue;
    activeSet.add(s.stockSymbol);
    symbolInfo[s.stockSymbol] = {
      title: s.companyNameVi ?? "",
      san:   SAN_MAP[s.exchange] ?? "",
    };
  }

  // ── Fallback: stocks.csv cho tên của mã đã hủy niêm yết ──────────────────
  const fallback     = loadFallbackCSV();
  let   fallbackUsed = 0;
  for (const [sym, info] of Object.entries(fallback)) {
    if (!symbolInfo[sym] && info.title) {
      symbolInfo[sym] = { title: info.title, san: info.san };
      fallbackUsed++;
    }
  }

  const sectors = sectorsJson.data;
  console.log(`Ngành: ${sectors.length} | Đang niêm yết (SSI): ${activeSet.size} | Fallback CSV: ${fallbackUsed}`);

  // ── Gom rows ───────────────────────────────────────────────────────────────
  const rows      = [];
  let stt         = 1;
  let cntActive   = 0;
  let cntDelisted = 0;

  for (const sec of sectors) {
    const nameVi = sec.industryName?.vn ?? sec.industryName?.vi ?? "";
    const nameEn = sec.industryName?.en ?? "";
    const code   = sec.industryCode ?? "";
    const syms   = sec.listCompany ?? [];
    const delisted = syms.filter(({ symbol }) => symbol && !activeSet.has(symbol)).length;

    console.log(`  [${code}] ${nameVi}: ${syms.length} mã (${delisted} đã hủy)`);

    for (const { symbol } of syms) {
      if (!symbol) continue;
      const isDelisted = !activeSet.has(symbol);
      const info       = symbolInfo[symbol] ?? {};
      if (isDelisted) cntDelisted++; else cntActive++;
      rows.push({
        stt: stt++, symbol, code, nameVi, nameEn,
        title:     info.title ?? "",
        san:       info.san   ?? "",
        delisted:  isDelisted ? "Y" : "",
      });
    }
  }

  // ── Ghi CSV ────────────────────────────────────────────────────────────────
  const header = "STT,Symbol,ICB Code,Ngành (VI),Ngành (EN),Tên công ty,Sàn,Hủy niêm yết";
  const lines  = rows.map(r => [
    r.stt,
    r.symbol,
    r.code,
    `"${r.nameVi}"`,
    `"${r.nameEn}"`,
    `"${r.title.replace(/"/g, '""')}"`,
    r.san,
    r.delisted,
  ].join(","));

  fs.writeFileSync(OUT_PATH, [header, ...lines].join("\n") + "\n", "utf8");

  console.log(`\nĐã lưu ${rows.length} mã → database/ssi_sectors.csv`);
  console.log(`  Đang niêm yết: ${cntActive} | Đã hủy niêm yết: ${cntDelisted}`);
}

main().catch(e => { console.error(e); process.exit(1); });
