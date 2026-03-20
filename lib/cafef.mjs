import https from "https";
import fs from "fs";
import path from "path";
import { BASE_DIR, sendJSON } from "./utils.mjs";

// yyyy-mm-dd  →  mm/dd/yyyy  (API CafeF)
export function isoToApi(iso) {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// mm/dd/yyyy  →  mmddyyyy  (filename tag)
export function apiToTag(apiDate) {
  return apiDate.replace(/\//g, "");
}

// dd/mm/yyyy  (hiển thị)  ←  yyyy-mm-dd
export function isoToDisplay(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Core download (tái sử dụng logic từ download_stock.mjs) ────────────────

export function fetchFromCafeF(targetUrl, symbol, redirectCount = 0) {
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

// ─── CafeF history fetch (fallback) — có pagination để lấy > 500 records ─────
export async function fetchHistoryCafeF(sym, days, res) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400_000);
  const fmt = (d) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
      d.getDate()
    ).padStart(2, "0")}/${d.getFullYear()}`;
  const startStr = fmt(startDate);
  const endStr   = fmt(endDate);
  const PAGE_SIZE = 500; // CafeF max per page
  const MAX_PAGES = 10;  // safety: tối đa 10 trang = 5000 records

  // Fetch một trang, trả về array rows hoặc []
  function fetchPage(pageIndex) {
    return new Promise((resolve) => {
      const url = `https://cafef.vn/du-lieu/Ajax/PageNew/DataHistory/PriceHistory.ashx` +
        `?Symbol=${sym}&StartDate=${startStr}&EndDate=${endStr}` +
        `&PageIndex=${pageIndex}&PageSize=${PAGE_SIZE}`;
      https.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: `https://cafef.vn/du-lieu/lich-su-giao-dich-${sym.toLowerCase()}-1.chn`,
          Accept: "application/json",
        },
      }, (rsp) => {
        const chunks = [];
        rsp.on("data", (c) => chunks.push(c));
        rsp.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(Array.isArray(json?.Data?.Data) ? json.Data.Data : []);
          } catch { resolve([]); }
        });
        rsp.on("error", () => resolve([]));
      }).on("error", () => resolve([]));
    });
  }

  try {
    let allRows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await fetchPage(page);
      if (rows.length === 0) break;
      allRows = allRows.concat(rows);
      console.log(`[History/CafeF] ${sym} page ${page}: ${rows.length} rows (total: ${allRows.length})`);
      if (rows.length < PAGE_SIZE) break; // last page
    }

    if (allRows.length === 0) {
      sendJSON(res, 200, { ok: false, symbol: sym, message: "Không có dữ liệu" });
      return;
    }

    // Parse, dedup theo date, sort tăng dần
    const map = new Map();
    for (const r of allRows) {
      const [d, m, y] = (r.Ngay || "").split("/");
      const date = `${y}-${m}-${d}`;
      if (!date || date === "undefined-undefined-undefined") continue;
      map.set(date, {
        date,
        open:   r.GiaMoCua,
        high:   r.GiaCaoNhat,
        low:    r.GiaThapNhat,
        close:  r.GiaDongCua,
        volume: r.KhoiLuongKhopLenh,
      });
    }
    const records = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));

    const histDir = path.join(BASE_DIR, "database", "history");
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(
      path.join(histDir, `${sym}.json`),
      JSON.stringify({ symbol: sym, source: "cafef", updated: new Date().toISOString(), records }, null, 2)
    );
    console.log(`[History/CafeF] ✅ ${sym}: ${records.length} phiên (${records[0]?.date} → ${records[records.length-1]?.date})`);
    sendJSON(res, 200, { ok: true, symbol: sym, count: records.length, source: "cafef" });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}
