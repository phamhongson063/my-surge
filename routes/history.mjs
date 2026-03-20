import https from "https";
import fs from "fs";
import path from "path";
import { sendJSON, BASE_DIR } from "../lib/utils.mjs";
import { isoToApi, isoToDisplay, todayISO, fetchFromCafeF, fetchHistoryCafeF } from "../lib/cafef.mjs";

const TMP_DIR = "tmp";

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

export async function handle(req, res, { pathname, parsed }) {
  // ─── API: Fetch & save historical price (SSI nếu có token, fallback CafeF) ──
  if (pathname === "/api/history-fetch" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    const days = parseInt(parsed.query.days) || 420;
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Mã không hợp lệ" });
      return true;
    }

    // ── Kiểm tra cache còn mới không (stale_hours=24 → bỏ qua fetch nếu < 24h) ─
    const staleHours = parseFloat(parsed.query.stale_hours) || 0;
    if (staleHours > 0) {
      const fPath = path.join(BASE_DIR, "database", "history", `${sym}.json`);
      if (fs.existsSync(fPath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(fPath, "utf8"));
          const ageHours = (Date.now() - new Date(cached.updated).getTime()) / 3_600_000;
          if (ageHours < staleHours) {
            sendJSON(res, 200, {
              ok: true, symbol: sym,
              count: cached.records?.length || 0,
              source: "cache", cached: true, ageHours: parseFloat(ageHours.toFixed(1)),
            });
            return true;
          }
        } catch { /* cache corrupt, refetch */ }
      }
    }

    // ── SSI statistics API (không cần token) ─────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86400;
    const ssiUrl = `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=1D&symbol=${sym}&from=${from}&to=${now}`;

    await new Promise((resolve) => {
      https
        .get(
          ssiUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              Origin: "https://iboard.ssi.com.vn",
              Referer: "https://iboard.ssi.com.vn/",
              Accept: "application/json",
            },
          },
          (rsp) => {
            const chunks = [];
            rsp.on("data", (c) => chunks.push(c));
            rsp.on("end", async () => {
              try {
                const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const d = json?.data;
                if (
                  json.code === "SUCCESS" &&
                  Array.isArray(d?.t) &&
                  d.t.length > 0
                ) {
                  const records = d.t
                    .map((ts, i) => ({
                      date: new Date(ts * 1000).toISOString().slice(0, 10),
                      open: d.o[i],
                      high: d.h[i],
                      low: d.l[i],
                      close: d.c[i],
                      volume: d.v[i],
                    }))
                    .sort((a, b) => a.date.localeCompare(b.date));

                  const histDir = path.join(
                    BASE_DIR,
                    "database",
                    "history"
                  );
                  fs.mkdirSync(histDir, { recursive: true });
                  fs.writeFileSync(
                    path.join(histDir, `${sym}.json`),
                    JSON.stringify(
                      {
                        symbol: sym,
                        source: "ssi",
                        updated: new Date().toISOString(),
                        records,
                      },
                      null,
                      2
                    )
                  );
                  console.log(
                    `[History/SSI] ✅ ${sym}: ${records.length} phiên`
                  );
                  sendJSON(res, 200, {
                    ok: true,
                    symbol: sym,
                    count: records.length,
                    source: "ssi",
                  });
                  return resolve();
                }
                console.warn(
                  `[History/SSI] ⚠️ ${sym}: no data → fallback CafeF`
                );
              } catch (e) {
                console.warn(
                  `[History/SSI] Parse error ${sym}: ${e.message} → fallback CafeF`
                );
              }
              await fetchHistoryCafeF(sym, days, res);
              resolve();
            });
            rsp.on("error", async () => {
              await fetchHistoryCafeF(sym, days, res);
              resolve();
            });
          }
        )
        .on("error", async () => {
          await fetchHistoryCafeF(sym, days, res);
          resolve();
        });
    });
    return true;
  }

  if (pathname === "/download" && req.method === "GET") {
    await handleDownload(req, res, parsed.query);
    return true;
  }

  // ─── Symbols — list mã đã có data trong tmp/ ────────────────────────────────
  if (pathname === "/symbols" && req.method === "GET") {
    try {
      const histDir = path.join(BASE_DIR, "database", "history");
      const files = fs.existsSync(histDir)
        ? fs
            .readdirSync(histDir)
            .filter((f) => /\.json$/i.test(f))
            .map((f) => f.replace(/\.json$/i, "").toUpperCase())
            .sort()
        : [];
      sendJSON(res, 200, { symbols: files });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}
