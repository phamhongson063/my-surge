import { sendJSON } from "../lib/utils.mjs";
import { analyzeAll, analyzeDetail } from "../analyze.mjs";

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
      const result = await analyzeDetail(null, symbol);
      sendJSON(res, result.error ? 400 : 200, result);
    } catch (err) {
      console.error(`   ❌ Lỗi: ${err.message}`);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
