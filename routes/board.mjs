import https from "https";
import fs from "fs";
import { sendJSON } from "../lib/utils.mjs";
import { getSsiToken, saveSsiToken, getSsiTokenFile } from "../lib/ssiToken.mjs";
import { parseBody } from "../analyze.mjs";

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
              resolve();
            });
            rsp.on("error", (e) => {
              sendJSON(res, 502, { error: e.message });
              resolve();
            });
          }
        )
        .on("error", (e) => {
          sendJSON(res, 502, { error: e.message });
          resolve();
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
          resolve();
        });
        rsp.on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(); });
      }).on("error", e => { sendJSON(res, 502, { error: e.message }); resolve(); });
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

  return false;
}
