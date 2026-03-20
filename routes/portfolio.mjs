import { sendJSON } from "../lib/utils.mjs";
import {
  parseBody,
  loadPortfolio,
  savePortfolio,
  loadHistory,
  saveHistory,
} from "../analyze.mjs";

export async function handle(req, res, { pathname, parsed }) {
  if (!pathname.startsWith("/portfolio")) return false;

  let body = {};
  if (req.method === "POST") body = await parseBody(req);

  if (pathname === "/portfolio" && req.method === "GET") {
    sendJSON(res, 200, loadPortfolio());
    return true;
  }

  if (pathname === "/portfolio/add" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    if (!sym || !/^[A-Z0-9]{1,10}$/.test(sym)) {
      sendJSON(res, 400, { error: "Mã không hợp lệ" });
      return true;
    }
    const qty = parseInt(body?.qty);
    const price = parseFloat(body?.price);
    const date = body?.date || new Date().toISOString().slice(0, 10);
    if (!qty || qty <= 0 || !price || price <= 0) {
      sendJSON(res, 400, {
        error: "Khối lượng hoặc giá không hợp lệ",
      });
      return true;
    }
    const pf = loadPortfolio();
    if (!pf[sym]) pf[sym] = [];
    pf[sym].push({ qty, price, date, id: Date.now() });
    savePortfolio(pf);
    console.log(
      `[Portfolio] ➕ ${sym} ${qty}@${price} | tổng lệnh: ${pf[sym].length}`
    );
    sendJSON(res, 200, { ok: true, positions: pf[sym] });
    return true;
  }

  if (pathname === "/portfolio/edit" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    const id = body?.id;
    const qty = parseInt(body?.qty);
    const price = parseFloat(body?.price);
    const date = body?.date;
    if (!sym || !id) { sendJSON(res, 400, { error: "Thiếu mã hoặc id" }); return true; }
    if (!qty || qty <= 0 || !price || price <= 0) {
      sendJSON(res, 400, {
        error: "Khối lượng hoặc giá không hợp lệ",
      });
      return true;
    }
    const pf = loadPortfolio();
    if (pf[sym]) {
      const pos = pf[sym].find((p) => p.id === id);
      if (pos) {
        pos.qty = qty;
        pos.price = price;
        if (date) pos.date = date;
        savePortfolio(pf);
        console.log(`[Portfolio] ✏️ ${sym} id:${id} → ${qty}@${price}`);
        sendJSON(res, 200, { ok: true, positions: pf[sym] });
        return true;
      }
    }
    sendJSON(res, 404, { error: "Không tìm thấy lệnh" });
    return true;
  }

  if (pathname === "/portfolio/remove" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    const id = body?.id;
    const pf = loadPortfolio();
    if (pf[sym]) pf[sym] = pf[sym].filter((p) => p.id !== id);
    if (pf[sym] && !pf[sym].length) delete pf[sym];
    savePortfolio(pf);
    console.log(`[Portfolio] ➖ ${sym} id:${id}`);
    sendJSON(res, 200, { ok: true, positions: pf[sym] || [] });
    return true;
  }

  // ── Bán cổ phiếu (FIFO) ──────────────────────────────────────────────────
  if (pathname === "/portfolio/sell" && req.method === "POST") {
    const sym = (body?.symbol ?? "").toUpperCase().trim();
    if (!sym) { sendJSON(res, 400, { error: "Thiếu mã" }); return true; }
    const sellQty = parseInt(body?.qty);
    const sellPrice = parseFloat(body?.price);
    const sellDate = body?.date || new Date().toISOString().slice(0, 10);
    if (!sellQty || sellQty <= 0 || !sellPrice || sellPrice <= 0) {
      sendJSON(res, 400, {
        error: "Khối lượng hoặc giá bán không hợp lệ",
      });
      return true;
    }

    const pf = loadPortfolio();
    if (!pf[sym] || !pf[sym].length) {
      sendJSON(res, 400, { error: `Không có vị thế ${sym}` });
      return true;
    }

    const totalQty = pf[sym].reduce((s, p) => s + p.qty, 0);
    if (sellQty > totalQty) {
      sendJSON(res, 400, { error: `Chỉ có ${totalQty} CP ${sym}` });
      return true;
    }

    // FIFO: consume from oldest positions first
    let remaining = sellQty;
    let totalBuyCost = 0;
    const hist = loadHistory();

    pf[sym] = pf[sym].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id - b.id
    );
    for (let i = 0; i < pf[sym].length && remaining > 0; i++) {
      const pos = pf[sym][i];
      const consumed = Math.min(pos.qty, remaining);
      totalBuyCost += consumed * pos.price;
      remaining -= consumed;
      pos.qty -= consumed;
    }
    // Remove exhausted positions
    pf[sym] = pf[sym].filter((p) => p.qty > 0);
    if (!pf[sym].length) delete pf[sym];
    savePortfolio(pf);

    // Record history entry
    const avgBuyPrice = totalBuyCost / sellQty;
    const pnl = (sellPrice - avgBuyPrice) * sellQty;
    const pnlPct =
      avgBuyPrice > 0 ? ((sellPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
    const entry = {
      id: Date.now(),
      symbol: sym,
      qty: sellQty,
      buyPrice: parseFloat(avgBuyPrice.toFixed(4)),
      sellPrice,
      sellDate,
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
    };
    hist.unshift(entry);
    saveHistory(hist);
    console.log(
      `[Portfolio] 💰 SELL ${sym} ${sellQty}@${sellPrice} PnL:${pnl.toFixed(
        0
      )}`
    );
    sendJSON(res, 200, { ok: true, entry, positions: pf[sym] || [] });
    return true;
  }

  // ── Lịch sử giao dịch ────────────────────────────────────────────────────
  if (pathname === "/portfolio/history" && req.method === "GET") {
    const sym = (parsed.query?.symbol ?? "").toUpperCase().trim();
    let hist = loadHistory();
    if (sym) hist = hist.filter((h) => h.symbol === sym);
    sendJSON(res, 200, hist);
    return true;
  }

  return false;
}
