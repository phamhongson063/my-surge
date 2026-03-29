import https from "https";
import fs from "fs";
import path from "path";
import { sendJSON, BASE_DIR } from "../lib/utils.mjs";

export async function handle(req, res, { pathname, parsed }) {
  // ─── API: Fetch & save historical price (SSI) ─────────────────────────────
  if (pathname === "/api/history-fetch" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    const days = parseInt(parsed.query.days) || 1100;
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

    // ── SSI statistics API ────────────────────────────────────────────────────
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

                  const histDir = path.join(BASE_DIR, "database", "history");
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
                  console.log(`[History/SSI] ✅ ${sym}: ${records.length} phiên`);
                  sendJSON(res, 200, {
                    ok: true,
                    symbol: sym,
                    count: records.length,
                    source: "ssi",
                  });
                  return resolve(true);
                }
                console.warn(`[History/SSI] ⚠️ ${sym}: no data`);
                sendJSON(res, 502, { error: "Không có dữ liệu từ SSI" });
              } catch (e) {
                console.warn(`[History/SSI] Parse error ${sym}: ${e.message}`);
                sendJSON(res, 502, { error: e.message });
              }
              resolve(true);
            });
            rsp.on("error", (e) => {
              sendJSON(res, 502, { error: e.message });
              resolve(true);
            });
          }
        )
        .on("error", (e) => {
          sendJSON(res, 502, { error: e.message });
          resolve(true);
        });
    });
    return true;
  }

  // ─── Symbols — list mã đã có data ────────────────────────────────────────
  if (pathname === "/symbols" && req.method === "GET") {
    try {
      const histDir = path.join(BASE_DIR, "database", "history");
      const delistedPath = path.join(BASE_DIR, "database", "delisted.json");

      let delisted = new Set();
      try {
        if (fs.existsSync(delistedPath)) {
          const d = JSON.parse(fs.readFileSync(delistedPath, "utf8"));
          delisted = new Set(d.symbols || []);
        }
      } catch (_) {}

      const minVolume = parseInt(parsed.query.minVolume) || 0;

      let files = fs.existsSync(histDir)
        ? fs
            .readdirSync(histDir)
            .filter((f) => /\.json$/i.test(f))
            .map((f) => f.replace(/\.json$/i, "").toUpperCase())
            .filter((sym) => !delisted.has(sym))
            .sort()
        : [];

      if (minVolume > 0) {
        files = files.filter((sym) => {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(histDir, `${sym}.json`), "utf8"));
            const records = raw.records;
            if (!Array.isArray(records) || records.length === 0) return false;
            const lastVol = records[records.length - 1].volume ?? 0;
            return lastVol >= minVolume;
          } catch (_) { return false; }
        });
      }

      sendJSON(res, 200, { symbols: files });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  // ─── Mark delisted ────────────────────────────────────────────────────────
  if (pathname === "/api/mark-delisted" && req.method === "POST") {
    try {
      const body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
        req.on("error", reject);
      });
      const symbol = (body.symbol ?? "").toUpperCase().trim();
      if (!symbol) { sendJSON(res, 400, { error: "Thiếu symbol" }); return true; }

      const delistedPath = path.join(BASE_DIR, "database", "delisted.json");
      let data = { symbols: [] };
      try {
        if (fs.existsSync(delistedPath))
          data = JSON.parse(fs.readFileSync(delistedPath, "utf8"));
      } catch (_) {}

      if (!data.symbols.includes(symbol)) {
        data.symbols.push(symbol);
        data.symbols.sort();
        fs.writeFileSync(delistedPath, JSON.stringify(data, null, 2), "utf8");
        console.log(`[Delisted] ✂️  ${symbol} đã được đánh dấu hủy niêm yết`);
      }
      sendJSON(res, 200, { ok: true, symbol });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}
