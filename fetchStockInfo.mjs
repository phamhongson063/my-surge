/**
 * fetchStockInfo.mjs — Tự động lấy thông tin công ty từ CafeF
 * và cập nhật vào stocks_info.json
 *
 * Cách dùng:
 *   node fetchStockInfo.mjs DGC PVT HPG      ← lấy cụ thể vài mã
 *   node fetchStockInfo.mjs --all             ← lấy tất cả mã trong tmp/*.xlsx
 *   node fetchStockInfo.mjs --missing         ← chỉ lấy mã chưa có trong stocks_info.json
 *
 * Nguồn: s.cafef.vn/{exchange}/{SYMBOL}/thong-tin-chung.chn
 *   → <meta description> chứa: Nhóm ngành, Chủ tịch, TGĐ, P/E, giá
 *   → <title> chứa: "SYMBOL: Tên công ty (EXCHANGE)"
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "cache", "stocks_info.json");
const TMP_DIR = path.join(__dirname, "tmp");

// ── Load / Save DB ──────────────────────────────────────────────────────────
function loadDB() {
  try { return fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, "utf8")) : {}; }
  catch { return {}; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// ── HTTP fetch with redirect ────────────────────────────────────────────────
function fetchPage(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 4) return reject(new Error("Too many redirects"));
      const proto = u.startsWith("https") ? https : http;
      const req = proto.get(u, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,*/*",
          "Accept-Language": "vi-VN,vi;q=0.9",
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, u).href;
          return go(next, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    };
    go(targetUrl);
  });
}

// ── Scrape 1 mã — song song 3 sàn, timeout 3s ──────────────────────────────
async function scrapeSymbol(symbol) {
  symbol = symbol.toUpperCase().trim();
  const info = { symbol, companyName: null, exchange: null, industry: null, chairman: null, ceo: null, pe: null, price: null };

  const exchanges = ["hose", "hnx", "upcom"];

  // Hàm parse HTML lấy thông tin từ <title> + <meta description>
  function parseHTML(html, ex) {
    const result = { companyName: null, exchange: ex.toUpperCase(), industry: null, chairman: null, ceo: null, pe: null, price: null };

    // <title>
    const titleM = html.match(/<title[^>]*>\s*([^<]+)/i);
    if (titleM) {
      const t = titleM[1].trim();
      let nm = t.match(/^[A-Z0-9]+\s*[:：]\s*(.+?)(?:\s*\||\s*\(|\s*$)/);
      if (nm) result.companyName = nm[1].trim();
      if (!result.companyName) {
        nm = t.match(/[-–]\s*(.{5,}?)(?:\s*\||\s*\(|\s*$)/);
        if (nm) result.companyName = nm[1].trim();
      }
      const exM = t.match(/\((\w+)\)/);
      if (exM) result.exchange = exM[1];
    }

    // <meta description>
    const metaM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i)
               || html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
    if (metaM) {
      const d = metaM[1];
      if (!result.companyName) { const m = d.match(/hồ sơ\s+(.+?)\s*\(mã/i); if (m) result.companyName = m[1].trim(); }
      { const m = d.match(/Nhóm ngành:\s*([^,;]+)/i) || d.match(/ngành:\s*([^,;]+)/i); if (m) result.industry = m[1].trim(); }
      { const m = d.match(/Chủ tịch[^:]*:\s*([^,;]+)/i); if (m) result.chairman = m[1].trim(); }
      { const m = d.match(/(?:Tổng Giám đốc|TGĐ|Giám đốc)[^:]*:\s*([^,;]+)/i); if (m) result.ceo = m[1].trim(); }
      { const m = d.match(/P\/E:\s*([\d.,]+)/i); if (m) result.pe = m[1].trim(); }
      { const m = d.match(/giá cổ phiếu:\s*([\d.,]+)/i) || d.match(/giá:\s*([\d.,]+)/i); if (m) result.price = m[1].trim(); }
    }
    return result;
  }

  // Hàm thử 1 URL — resolve nếu tìm thấy mã, reject nếu không
  function tryUrl(urlStr, ex) {
    return new Promise(async (resolve, reject) => {
      try {
        const html = await fetchPage(urlStr, 3000); // timeout 3s
        if (html.includes(`>${symbol}<`) || html.includes(`"${symbol}"`) || html.includes(`(${symbol})`)) {
          resolve({ html, ex });
        } else {
          reject(new Error("not found"));
        }
      } catch (e) { reject(e); }
    });
  }

  // Bắn song song tất cả URL — lấy cái nào thành công đầu tiên
  const allAttempts = [];
  for (const ex of exchanges) {
    allAttempts.push(tryUrl(`https://s.cafef.vn/${ex}/${symbol}/thong-tin-chung.chn`, ex));
    allAttempts.push(tryUrl(`https://s.cafef.vn/${ex}/${symbol}/ban-lanh-dao.chn`, ex));
  }

  try {
    const { html, ex } = await Promise.any(allAttempts);
    const parsed = parseHTML(html, ex);
    Object.assign(info, parsed);
  } catch {
    // Tất cả đều fail — info giữ null
  }

  if (!info.companyName) info.companyName = null;
  return info;
}

// ── Lấy danh sách mã từ tmp/ ────────────────────────────────────────────────
function getSymbolsFromTmp() {
  if (!fs.existsSync(TMP_DIR)) return [];
  return fs.readdirSync(TMP_DIR)
    .filter(f => /\.xlsx$/i.test(f) && !f.startsWith("~$") && f.toLowerCase() !== "index.xlsx")
    .map(f => path.basename(f, path.extname(f)).toUpperCase());
}

// ── Sleep ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const db = loadDB();
  let symbols = [];

  if (args.includes("--all")) {
    symbols = getSymbolsFromTmp();
    console.log(`📂 Tìm thấy ${symbols.length} mã trong tmp/`);
  } else if (args.includes("--missing")) {
    const allTmp = getSymbolsFromTmp();
    symbols = allTmp.filter(s => !db[s] || !db[s].companyName || !db[s].industry);
    console.log(`📂 ${allTmp.length} mã trong tmp/, ${symbols.length} chưa có thông tin`);
  } else if (args.length > 0) {
    symbols = args.filter(a => !a.startsWith("-")).map(s => s.toUpperCase());
  } else {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║  fetchStockInfo.mjs — Lấy thông tin công ty từ CafeF ║
╚═══════════════════════════════════════════════════════╝

Cách dùng:
  node fetchStockInfo.mjs DGC PVT HPG    ← lấy vài mã cụ thể
  node fetchStockInfo.mjs --all           ← tất cả mã trong tmp/
  node fetchStockInfo.mjs --missing       ← chỉ mã chưa có info

Kết quả lưu vào: ${DB_PATH}
`);
    return;
  }

  if (symbols.length === 0) {
    console.log("Không có mã nào để xử lý.");
    return;
  }

  console.log(`\n🔍 Bắt đầu lấy thông tin ${symbols.length} mã...\n`);

  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const progress = `[${i + 1}/${symbols.length}]`;

    // Nếu đã có đầy đủ và không force, skip
    if (!args.includes("--force") && db[sym]?.companyName && db[sym]?.industry) {
      console.log(`  ${progress} ⏭  ${sym} — đã có (${db[sym].companyName})`);
      skipped++;
      continue;
    }

    try {
      const info = await scrapeSymbol(sym);

      if (info.companyName) {
        // Merge: giữ lại data cũ nếu scrape mới không có
        const existing = db[sym] || {};
        db[sym] = {
          symbol: sym,
          companyName: info.companyName || existing.companyName,
          exchange: info.exchange || existing.exchange,
          industry: info.industry || existing.industry,
          chairman: info.chairman || existing.chairman,
          ceo: info.ceo || existing.ceo,
          pe: info.pe || existing.pe,
        };
        console.log(`  ${progress} ✅ ${sym} — ${info.companyName} | ${info.industry || "?"} | ${info.exchange || "?"}`);
        success++;
      } else {
        console.log(`  ${progress} ❌ ${sym} — không tìm thấy thông tin`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${progress} ❌ ${sym} — lỗi: ${err.message}`);
      failed++;
    }

    // Rate limit: chờ 500ms giữa mỗi request
    if (i < symbols.length - 1) await sleep(500);
  }

  // Save
  saveDB(db);

  console.log(`
════════════════════════════════════════
  ✅ Thành công: ${success}
  ⏭  Đã có sẵn:  ${skipped}
  ❌ Thất bại:    ${failed}
  📁 Đã lưu:     ${DB_PATH}
  📊 Tổng mã:    ${Object.keys(db).length}
════════════════════════════════════════
`);
}

// ── Export cho main.mjs gọi được ─────────────────────────────────────────────
export { scrapeSymbol, loadDB, saveDB };

// Chỉ chạy main() khi gọi trực tiếp, không chạy khi import
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main().catch(console.error);
