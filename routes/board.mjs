import https from "https";
import fs from "fs";
import { sendJSON } from "../lib/utils.mjs";
import { getSsiToken, saveSsiToken, getSsiTokenFile } from "../lib/ssiToken.mjs";
import { parseBody } from "../analyze.mjs";
import { lookupStockFromCache, fetchStockFromSSI } from "../lib/board.mjs";

export async function handle(req, res, { pathname, parsed }) {
  if (pathname === "/api/board") {
    const group = parsed.query.group; // VN30, HNX30, ...
    const exchange = parsed.query.exchange; // hose, hnx, upcom
    const indexId = parsed.query.index; // VNINDEX, VN30, HNXIndex, HNX30

    let targetUrl;
    if (indexId) {
      targetUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(
        indexId
      )}?hasHistory=false`;
    } else if (group) {
      targetUrl = `https://iboard-query.ssi.com.vn/stock/group/${encodeURIComponent(
        group
      )}`;
    } else if (exchange) {
      targetUrl = `https://iboard-query.ssi.com.vn/stock/exchange/${encodeURIComponent(
        exchange
      )}`;
    } else {
      sendJSON(res, 400, { error: "Cần group, exchange hoặc index" });
      return true;
    }

    await new Promise((resolve) => {
      https
        .get(
          targetUrl,
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
            rsp.on("end", () => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(Buffer.concat(chunks));
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

  if (pathname === "/api/index-intraday") {
    const symbol = (parsed.query.symbol ?? "").trim();
    if (!symbol) { sendJSON(res, 400, { error: "Thiếu symbol" }); return true; }
    const ssiUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(symbol)}?hasHistory=true`;
    await new Promise((resolve) => {
      https.get(ssiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Origin: "https://iboard.ssi.com.vn",
          Referer: "https://iboard.ssi.com.vn/",
          Accept: "application/json",
        },
      }, (rsp) => {
        const chunks = [];
        rsp.on("data", c => chunks.push(c));
        rsp.on("end", () => {
          try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(Buffer.concat(chunks));
          } catch { sendJSON(res, 502, { error: "error" }); }
          resolve(true);
        });
        rsp.on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
      }).on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
    });
    return true;
  }

  // ── /price?symbol=XXX — giá realtime 1 mã từ SSI (dùng cho portfolio) ──────
  if (pathname === "/price" && req.method === "GET") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Thiếu hoặc sai symbol" });
      return true;
    }
    let s = lookupStockFromCache(sym) || await fetchStockFromSSI(sym);
    if (!s) {
      sendJSON(res, 404, { error: "Không tìm thấy mã " + sym });
      return true;
    }
    const mp  = s.matchedPrice ?? 0;  // raw VND
    const ref = s.refPrice ?? s.referencePrice ?? 0;
    const chgVal = ref > 0 ? (mp - ref) / 1000 : null;
    const chgPct = ref > 0 ? ((mp - ref) / ref * 100) : null;
    const chgStr = chgVal != null
      ? `${chgVal >= 0 ? '+' : ''}${chgVal.toFixed(2)}(${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`
      : null;
    sendJSON(res, 200, {
      price: mp / 1000,
      ref:   ref / 1000,
      change: chgStr,
    });
    return true;
  }

  if (pathname === "/api/ssi-token" && req.method === "GET") {
    const ssiToken = getSsiToken();
    const SSI_TOKEN_FILE = getSsiTokenFile();
    sendJSON(res, 200, {
      hasToken: !!ssiToken,
      savedAt: ssiToken
        ? (() => {
            try {
              return JSON.parse(fs.readFileSync(SSI_TOKEN_FILE, "utf8"))
                .savedAt;
            } catch {
              return null;
            }
          })()
        : null,
    });
    return true;
  }

  if (pathname === "/api/ssi-token" && req.method === "POST") {
    const body = await parseBody(req);
    const token = (body?.token ?? "").trim();
    if (!token) { sendJSON(res, 400, { error: "Thiếu token" }); return true; }
    saveSsiToken(token);
    sendJSON(res, 200, { ok: true });
    return true;
  }

  // ── /api/chart-data — OHLCV daily từ SSI stats (không cần token) ───────────
  if (pathname === "/api/chart-data") {
    const sym  = (parsed.query.symbol ?? "").toUpperCase().trim();
    const days = parseInt(parsed.query.days) || 365;
    const resolution = ["1","5","15","30","60","1D"].includes(parsed.query.resolution)
      ? parsed.query.resolution : "1D";
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Thiếu hoặc sai symbol" });
      return true;
    }
    const now  = Math.floor(Date.now() / 1000);
    // Intraday: from = 9:00 AM VN today (UTC+7 = UTC-2h offset inverted)
    let from;
    if (resolution !== "1D") {
      const vnNow  = new Date(Date.now() + 7 * 3600000);
      const vnDay  = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate());
      from = Math.floor(vnDay / 1000) - 7 * 3600 + 9 * 3600; // 9:00 AM VN in UTC seconds
    } else {
      from = now - days * 86400;
    }
    const ssiUrl = `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=${resolution}&symbol=${sym}&from=${from}&to=${now}`;
    return new Promise((resolve) => {
      https.get(ssiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Origin: "https://iboard.ssi.com.vn",
          Referer: "https://iboard.ssi.com.vn/",
          Accept: "application/json",
        },
      }, (rsp) => {
        const chunks = [];
        rsp.on("data", c => chunks.push(c));
        rsp.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks));
          resolve(true);
        });
        rsp.on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
      }).on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
    });
  }

  // ── /api/recent-trades — lịch sử khớp lệnh từ SSI iboard-query ─────────────
  if (pathname === "/api/recent-trades") {
    const sym = (parsed.query.symbol ?? "").toUpperCase().trim();
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Thiếu hoặc sai symbol" });
      return true;
    }
    const pageSize = Math.min(parseInt(parsed.query.pageSize) || 50, 100);
    const lastId   = parsed.query.lastId ? `&lastId=${encodeURIComponent(parsed.query.lastId)}` : '';
    const ssiUrl = `https://iboard-query.ssi.com.vn/le-table/stock/${sym}?pageSize=${pageSize}${lastId}`;
    return new Promise((resolve) => {
      https.get(ssiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Origin: "https://iboard.ssi.com.vn",
          Referer: "https://iboard.ssi.com.vn/",
          Accept: "application/json",
        },
      }, (rsp) => {
        const chunks = [];
        rsp.on("data", c => chunks.push(c));
        rsp.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks));
          resolve(true);
        });
        rsp.on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
      }).on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(true); });
    });
  }

  return false;
}
