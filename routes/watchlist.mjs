import { sendJSON } from "../lib/utils.mjs";
import {
  parseBody,
  loadWatchlist,
  saveWatchlist,
  scanWatchlist,
} from "../analyze.mjs";

export async function handle(req, res, { pathname, parsed }) {
  if (!pathname.startsWith("/watchlist")) return false;

  let body = {};
  if (req.method === "POST") body = await parseBody(req);

  if (pathname === "/watchlist" && req.method === "GET") {
    sendJSON(res, 200, loadWatchlist());
    return true;
  }

  if (pathname === "/watchlist/add" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Mã không hợp lệ" });
      return true;
    }
    const wl = loadWatchlist();
    if (!wl.symbols.includes(sym)) wl.symbols.push(sym);
    saveWatchlist(wl);
    console.log(`[Watchlist] ➕ ${sym} | tổng: ${wl.symbols.length} mã`);
    sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    return true;
  }

  if (pathname === "/watchlist/remove" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    const wl = loadWatchlist();
    wl.symbols = wl.symbols.filter((s) => s !== sym);
    saveWatchlist(wl);
    console.log(`[Watchlist] ➖ ${sym} | còn: ${wl.symbols.length} mã`);
    sendJSON(res, 200, { ok: true, symbols: wl.symbols });
    return true;
  }

  if (pathname === "/watchlist/scan" && req.method === "GET") {
    const forceRefresh = parsed.query.refresh === "1";
    console.log(
      `\n[${new Date().toLocaleTimeString("vi-VN")}] 📡 Scan watchlist${
        forceRefresh ? " (force)" : ""
      }...`
    );
    try {
      const result = await scanWatchlist(forceRefresh);
      console.log(
        `   ✅ ${result.scanned} mã | ${result.alerts.length} alerts`
      );
      sendJSON(res, 200, result);
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
