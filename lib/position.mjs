/**
 * position.mjs — Tư vấn Vị thế Cổ phiếu Pro (V1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phân tích vị thế đang nắm giữ theo chuẩn IBD/O'Neil:
 *   - Sức khỏe vị thế (Health Score)
 *   - Quản lý rủi ro: Stoploss động (ATR/Support/MA/IBD-8%)
 *   - Take Profit 3 mức theo Risk:Reward
 *   - Conviction Score: đếm tín hiệu bull/bear hội tụ
 *   - Tư vấn hành động theo 3 khung thời gian
 *
 * Input:
 *   analysisResult  — kết quả từ analyzeDetail() (toàn bộ object)
 *   position        — { avgPrice: number, qty: number }
 *   customConfig    — override cấu hình mặc định (optional)
 *
 * Output: PositionAdvice object (xem schema bên dưới)
 */

// ─── 1. CONFIG ────────────────────────────────────────────────────────────────

export const DEFAULT_POSITION_CONFIG = {
  RISK: {
    MAX_LOSS_PCT: 8,         // IBD: cắt lỗ tối đa 8% từ giá vốn (hard floor)
    ATR_MULT: 2.0,           // SL ATR-based  = giá - ATR_MULT × ATR
    TRAIL_ATR_MULT: 1.5,     // Trailing SL   = giá - TRAIL_ATR_MULT × ATR (khi đang lãi)
    TRAIL_TRIGGER_PCT: 10,   // % lãi tối thiểu để bật trailing stop
  },
  PROFIT: {
    TP1_RR: 1.0,             // Risk:Reward = 1:1  → Chốt phần nhỏ
    TP2_RR: 2.0,             // R:R = 1:2
    TP3_RR: 3.0,             // R:R = 1:3
    TP1_SIZE_PCT: 25,        // % vị thế chốt tại TP1
    TP2_SIZE_PCT: 25,        // % vị thế chốt tại TP2
    TP3_SIZE_PCT: 50,        // % vị thế chốt tại TP3
    RES_SNAP_PCT: 2,         // Snap TP sang mức kháng cự nếu lệch < 2%
  },
  CONVICTION: {
    ADD: 70,    // score >= 70 → Có thể mua thêm
    HOLD: 45,   // 45–69      → Giữ nguyên
    REDUCE: 25, // 25–44      → Giảm bớt
    // < 25     → Thoát
  },
  HEALTH_GRADES: { A: 75, B: 55, C: 35 }, // Thang điểm, dưới C là D
};

// ─── 2. UTILS ─────────────────────────────────────────────────────────────────

/** Deep merge cấu hình */
function deepMerge(target, source) {
  const out = { ...target };
  if (source && typeof source === "object") {
    Object.keys(source).forEach((k) => {
      if (source[k] && typeof source[k] === "object" && !Array.isArray(source[k])) {
        out[k] = deepMerge(target[k] ?? {}, source[k]);
      } else {
        out[k] = source[k];
      }
    });
  }
  return out;
}

const r2 = (v) => (v != null ? Math.round(v * 100) / 100 : null);
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// ─── 3. STOPLOSS ──────────────────────────────────────────────────────────────

/**
 * Tính stoploss tối ưu từ nhiều phương pháp, ưu tiên mức bảo vệ chặt nhất
 * nhưng không thấp hơn IBD 8% hard floor.
 */
function calcStopLoss(d, avgPrice, curPrice, pnlPct, cfg) {
  const atr = d.indicators?.atr ?? 0;
  const ma20 = d.indicators?.ma20;
  const ma50 = d.indicators?.ma50;
  const supports = (d.supportResistance?.supports ?? []).map((s) =>
    typeof s === "object" ? s.price : s
  );

  const candidates = [];

  // 1. ATR-based — chặt hơn khi đang lãi (trailing)
  if (atr > 0) {
    const mult =
      pnlPct >= cfg.RISK.TRAIL_TRIGGER_PCT
        ? cfg.RISK.TRAIL_ATR_MULT
        : cfg.RISK.ATR_MULT;
    const atrStop = curPrice - mult * atr;
    if (atrStop > 0) candidates.push({ price: r2(atrStop), basis: "ATR" });
  }

  // 2. Support-based — hỗ trợ gần nhất dưới giá hiện tại
  const nearSupport = supports
    .filter((s) => s > 0 && s < curPrice)
    .sort((a, b) => b - a)[0];
  if (nearSupport) candidates.push({ price: r2(nearSupport), basis: "Hỗ trợ" });

  // 3. MA20 hoặc MA50 làm hỗ trợ động
  if (ma20 && ma20 < curPrice) candidates.push({ price: r2(ma20), basis: "MA20" });
  else if (ma50 && ma50 < curPrice) candidates.push({ price: r2(ma50), basis: "MA50" });

  // 4. IBD 8% hard floor từ giá vốn
  const ibdStop = r2(avgPrice * (1 - cfg.RISK.MAX_LOSS_PCT / 100));
  candidates.push({ price: ibdStop, basis: `IBD -${cfg.RISK.MAX_LOSS_PCT}%` });

  // Chọn: mức cao nhất hợp lệ (bảo vệ chặt nhất), không thấp hơn IBD floor
  const valid = candidates
    .filter((c) => c.price < curPrice && c.price >= ibdStop)
    .sort((a, b) => b.price - a.price);

  const chosen = valid[0] ?? { price: ibdStop, basis: `IBD -${cfg.RISK.MAX_LOSS_PCT}%` };
  const pctFromCurrent = r2(((curPrice - chosen.price) / curPrice) * 100);
  const pctFromAvg = r2(((avgPrice - chosen.price) / avgPrice) * 100);

  return { ...chosen, pctFromCurrent, pctFromAvg };
}

// ─── 4. TAKE PROFITS ──────────────────────────────────────────────────────────

/**
 * Tính 3 mức Take Profit theo Risk:Reward.
 * Nếu có mức kháng cự gần (lệch < RES_SNAP_PCT%), snap TP về đó.
 */
function calcTakeProfits(curPrice, slPrice, resistances, cfg) {
  const risk = curPrice - slPrice;
  if (risk <= 0) return [];

  const resArr = (resistances ?? []).map((r) =>
    typeof r === "object" ? r.price : r
  );

  const tpDefs = [
    { level: 1, rr: cfg.PROFIT.TP1_RR, size: cfg.PROFIT.TP1_SIZE_PCT, action: `Chốt ${cfg.PROFIT.TP1_SIZE_PCT}% vị thế` },
    { level: 2, rr: cfg.PROFIT.TP2_RR, size: cfg.PROFIT.TP2_SIZE_PCT, action: `Chốt thêm ${cfg.PROFIT.TP2_SIZE_PCT}%` },
    { level: 3, rr: cfg.PROFIT.TP3_RR, size: cfg.PROFIT.TP3_SIZE_PCT, action: `Thoát ${cfg.PROFIT.TP3_SIZE_PCT}% còn lại` },
  ];

  return tpDefs.map((tp) => {
    let price = curPrice + tp.rr * risk;
    // Snap về kháng cự gần nhất nếu trong ngưỡng
    const nearRes = resArr.find(
      (res) => Math.abs(res - price) / price < cfg.PROFIT.RES_SNAP_PCT / 100
    );
    if (nearRes) price = nearRes;
    price = r2(price);
    const pctFromCurrent = r2(((price - curPrice) / curPrice) * 100);
    return { level: tp.level, price, pctFromCurrent, rr: tp.rr, size: tp.size, action: tp.action };
  });
}

// ─── 5. HEALTH SCORE ──────────────────────────────────────────────────────────

/**
 * Tổng điểm sức khỏe vị thế 0–100, tổng hợp từ:
 *   P&L (35pts) + Trend (20pts) + TrendPro/FTD (15pts) + Scoring (18pts) + Pattern (7pts) + Volume (5pts)
 */
function calcPositionHealth(pnlPct, d, cfg) {
  let score = 50;
  const breakdown = { pnl: 0, trend: 0, trendPro: 0, scoring: 0, pattern: 0, volume: 0 };

  // ── P&L (±35) ──
  let pnlPts;
  if      (pnlPct >= 25)  pnlPts = 35;
  else if (pnlPct >= 15)  pnlPts = 25;
  else if (pnlPct >= 8)   pnlPts = 15;
  else if (pnlPct >= 3)   pnlPts = 8;
  else if (pnlPct >= 0)   pnlPts = 2;
  else if (pnlPct >= -3)  pnlPts = -6;
  else if (pnlPct >= -6)  pnlPts = -15;
  else if (pnlPct >= -8)  pnlPts = -25;
  else                    pnlPts = -35;
  breakdown.pnl = pnlPts;

  // ── Trend alignment (±20) ──
  const alignMap = {
    STRONG_UP: 20, MODERATE_UP: 12, MIXED: 0, MODERATE_DOWN: -12, STRONG_DOWN: -20,
  };
  const trendPts = alignMap[d?.trend?.alignment] ?? 0;
  breakdown.trend = trendPts;

  // ── TrendPro (±15): score ngắn hạn + FTD + divergence ──
  let tpPts = 0;
  const tp = d?.trendPro;
  if (tp && !tp.error) {
    const tpScore = tp.summary?.scores?.shortTerm ?? 50;
    tpPts += Math.round((tpScore - 50) * 0.2);      // ±10 từ trend score
    if (tp.ftd?.isFTD) tpPts += 10;                  // +10 FTD bonus
    if (tp.shortTerm?.divergence?.type === "BULLISH") tpPts += 5;
    if (tp.shortTerm?.divergence?.type === "BEARISH") tpPts -= 5;
  }
  breakdown.trendPro = tpPts;

  // ── Scoring methods (±12): CANSLIM + SEPA + Momentum ──
  let scPts = 0;
  const sc = d?.scoring;
  if (sc) {
    [sc.canslim?.grade, sc.sepa?.grade, sc.momentum?.grade].forEach((g) => {
      if (g === "A") scPts += 4;
      else if (g === "B") scPts += 2;
      else if (g === "C") scPts -= 2;
      else if (g === "D") scPts -= 4;
    });
  }
  breakdown.scoring = scPts;

  // ── Pattern verdict (±7) ──
  let patPts = 0;
  const pvScore = d?.patternVerdict?.overall?.score;
  if (pvScore != null) patPts = Math.round((pvScore - 50) / 7);
  breakdown.pattern = patPts;

  // ── Volume confirmation (±5) ──
  let volPts = 0;
  const vol = d?.volume;
  if (vol?.isSurge) {
    volPts = d?.trend?.shortTerm?.direction === "UPTREND" ? 5 : -5;
  }
  breakdown.volume = volPts;

  const raw = 50 + pnlPts + trendPts + tpPts + scPts + patPts + volPts;
  const final = clamp(Math.round(raw));
  const G = cfg.HEALTH_GRADES;
  const grade = final >= G.A ? "A" : final >= G.B ? "B" : final >= G.C ? "C" : "D";

  const LABEL_MAP = { A: "Rất tốt", B: "Tốt", C: "Trung bình", D: "Yếu / Nguy hiểm" };
  const COLOR_MAP = { A: "var(--up)", B: "var(--navy)", C: "var(--am)", D: "var(--dn)" };

  return { score: final, grade, label: LABEL_MAP[grade], color: COLOR_MAP[grade], breakdown };
}

// ─── 6. CONVICTION ────────────────────────────────────────────────────────────

/**
 * Đếm tín hiệu hội tụ bull/bear để đo mức độ thuyết phục của vị thế.
 * Score = 50 + (net_bull / total_signals) × 50
 */
function calcConviction(d, pnlPct, cfg) {
  const bullSignals = [];
  const bearSignals = [];
  const neutralSignals = [];

  const tp = d?.trendPro;
  const ind = d?.indicators;
  const al = d?.trend?.alignment;
  const vol = d?.volume;
  const sc = d?.scoring;
  const rsi = ind?.rsi;
  const macdH = ind?.macdHistogram;
  const curPrice = d?.latestPrice;
  const ma20 = ind?.ma20;
  const ma50 = ind?.ma50;
  const shortDir = d?.trend?.shortTerm?.direction;

  // ─ Bull signals ─
  if (al === "STRONG_UP")                bullSignals.push("3/3 khung thời gian đồng thuận TĂNG");
  if (al === "MODERATE_UP")              bullSignals.push("2/3 khung thời gian tăng");
  if (tp?.ftd?.isFTD)                    bullSignals.push(`Follow-Through Day ✓ (ngày ${tp.ftd.daysSinceBottom} từ đáy)`);
  if ((tp?.shortTerm?.score ?? 0) >= 70) bullSignals.push(`Trend Pro ngắn hạn mạnh (${tp.shortTerm.score}/100)`);
  if (tp?.shortTerm?.divergence?.type === "BULLISH") bullSignals.push("Phân kỳ tăng RSI ngắn hạn");
  if (tp?.midTerm?.divergence?.type === "BULLISH")   bullSignals.push("Phân kỳ tăng RSI trung hạn");
  if (curPrice && ma20 && ma50 && curPrice > ma20 && ma20 > ma50)
    bullSignals.push("Giá > MA20 > MA50 (Golden alignment)");
  if (rsi != null && rsi >= 45 && rsi <= 65) bullSignals.push(`RSI ${rsi.toFixed(0)} trong vùng lý tưởng (45–65)`);
  if (macdH != null && macdH > 0)        bullSignals.push("MACD histogram dương");
  if (vol?.isSurge && shortDir === "UPTREND") bullSignals.push("Volume đột biến xác nhận tăng giá");
  if (sc?.canslim?.grade === "A")        bullSignals.push("CANSLIM Grade A");
  else if (sc?.canslim?.grade === "B")   bullSignals.push("CANSLIM Grade B");
  if (sc?.sepa?.grade === "A")           bullSignals.push("SEPA Grade A");
  if (sc?.momentum?.grade === "A")       bullSignals.push("Momentum Grade A");
  if (pnlPct >= 15) bullSignals.push(`Đang lãi ${pnlPct.toFixed(1)}% — buffer an toàn dồi dào`);
  else if (pnlPct >= 5) bullSignals.push(`Đang lãi ${pnlPct.toFixed(1)}%`);

  // ─ Bear signals ─
  if (al === "STRONG_DOWN")   bearSignals.push("3/3 khung thời gian đồng thuận GIẢM");
  if (al === "MODERATE_DOWN") bearSignals.push("2/3 khung thời gian giảm");
  if ((tp?.shortTerm?.score ?? 50) <= 35) bearSignals.push(`Trend Pro ngắn hạn yếu (${tp?.shortTerm?.score}/100)`);
  if (tp?.shortTerm?.divergence?.type === "BEARISH") bearSignals.push("⚠ Phân kỳ giảm RSI ngắn hạn");
  if (tp?.midTerm?.divergence?.type === "BEARISH")   bearSignals.push("⚠ Phân kỳ giảm RSI trung hạn");
  if (curPrice && ma20 && curPrice < ma20) bearSignals.push("Giá dưới MA20 — xu hướng ngắn hạn yếu");
  if (ma20 && ma50 && ma20 < ma50)         bearSignals.push("MA20 < MA50 — cấu trúc giảm");
  if (rsi != null && rsi > 75) bearSignals.push(`RSI ${rsi.toFixed(0)} — vùng quá mua (> 75)`);
  if (rsi != null && rsi < 30) bearSignals.push(`RSI ${rsi.toFixed(0)} — đà giảm mạnh (< 30)`);
  if (macdH != null && macdH < 0) bearSignals.push("MACD histogram âm");
  if (pnlPct <= -6)  bearSignals.push(`Đang lỗ ${Math.abs(pnlPct).toFixed(1)}% — tiệm cận ngưỡng cắt lỗ`);
  if (sc?.canslim?.grade === "D") bearSignals.push("CANSLIM Grade D");
  if (sc?.sepa?.grade === "D")    bearSignals.push("SEPA Grade D");

  // ─ Neutral ─
  if (al === "MIXED") neutralSignals.push("Tín hiệu xu hướng lẫn lộn (Mixed)");
  if (rsi != null && rsi > 65 && rsi <= 75) neutralSignals.push(`RSI ${rsi.toFixed(0)} — vùng cao, thận trọng`);
  if (vol?.trend === "decreasing") neutralSignals.push("Volume đang giảm dần — theo dõi đà");
  if (pnlPct > -5 && pnlPct < 5) neutralSignals.push("P&L gần hòa vốn — chờ xác nhận hướng");

  const net = bullSignals.length - bearSignals.length;
  const total = bullSignals.length + bearSignals.length + neutralSignals.length || 1;
  const score = clamp(Math.round(50 + (net / total) * 50));

  const THR = cfg.CONVICTION;
  let canAdd = false;
  let addSizing = "Không thêm vị thế";
  if      (score >= THR.ADD)    { canAdd = true; addSizing = "Có thể thêm tối đa 20% vốn bổ sung"; }
  else if (score >= THR.HOLD)   { addSizing = "Giữ nguyên — chưa đủ điều kiện mua thêm"; }
  else if (score >= THR.REDUCE) { addSizing = "Cân nhắc giảm 25–50% vị thế"; }
  else                          { addSizing = "Cắt giảm mạnh hoặc thoát toàn bộ"; }

  return { score, bullSignals, bearSignals, neutralSignals, canAdd, addSizing };
}

// ─── 7. TIMEFRAME ADVISORS ────────────────────────────────────────────────────

function adviseShortTerm(pnlPct, d, stopLoss, conviction, cfg) {
  const tpScore = d?.trendPro?.summary?.scores?.shortTerm ?? 50;
  const isFTD   = d?.trendPro?.ftd?.isFTD ?? false;
  const bearDiv = d?.trendPro?.shortTerm?.divergence?.type === "BEARISH";

  let action, urgency, reasons = [], watchFor = [], trigger;

  if (pnlPct <= -(cfg.RISK.MAX_LOSS_PCT)) {
    action = "CẮT LỖ NGAY";
    urgency = "NGAY";
    reasons = [
      `Lỗ ${Math.abs(pnlPct).toFixed(1)}% — vượt ngưỡng IBD ${cfg.RISK.MAX_LOSS_PCT}%`,
      "Nguyên tắc #1: Bảo toàn vốn trước khi nghĩ đến lợi nhuận",
    ];
    trigger = "Thực hiện ngay phiên tiếp theo, không chờ đợi";
    watchFor = [];
  } else if (pnlPct <= -5 && tpScore < 40) {
    action = "THOÁT 50%";
    urgency = "SỚM";
    reasons = [
      `Lỗ ${Math.abs(pnlPct).toFixed(1)}% kết hợp Trend yếu (${tpScore}/100)`,
      "Giảm rủi ro — giữ 50% chờ tín hiệu phục hồi rõ ràng",
    ];
    trigger = `Thoát 50% nếu giá phá vỡ ${stopLoss.price} (cơ sở: ${stopLoss.basis})`;
    watchFor = [`Stoploss toàn phần tại ${stopLoss.price}`, "Xem xét lại sau 5 phiên"];
  } else if (bearDiv && pnlPct > 0) {
    action = "CHỐT 25–30%";
    urgency = "SỚM";
    reasons = [
      "Phân kỳ giảm RSI — tín hiệu đảo chiều tiềm năng",
      "Bảo vệ lợi nhuận khi thị trường cảnh báo",
    ];
    trigger = "Chốt 25% khi giá chạm kháng cự gần nhất";
    watchFor = ["Theo dõi RSI và volume 3–5 phiên tới", "Giá có giữ trên MA20 không?"];
  } else if (pnlPct >= 20) {
    action = "CHỐT 25–30%";
    urgency = "THEO DÕI";
    reasons = [
      `Đang lãi ${pnlPct.toFixed(1)}% — khóa lợi nhuận`,
      "Giữ core position để theo đà, chốt một phần bảo vệ",
    ];
    trigger = "Chốt khi giá chạm TP1 hoặc kháng cự kỹ thuật";
    watchFor = ["Trailing stop ATR", "Volume giảm → tín hiệu yếu đà"];
  } else if (isFTD && tpScore >= 60) {
    action = "GIỮ — XEM XÉT THÊM";
    urgency = "THEO DÕI";
    reasons = [
      `Follow-Through Day xác nhận — tín hiệu bull mạnh nhất (IBD)`,
      `Trend Pro ngắn hạn: ${tpScore}/100`,
    ];
    trigger = "Mua thêm nếu giá break kháng cự với volume >= 1.4x TB";
    watchFor = ["Breakout xác nhận kèm volume", "Không mua khi volume yếu"];
  } else if (tpScore >= 60 && conviction.score >= 60) {
    action = "GIỮ VỮNG";
    urgency = "THEO DÕI";
    reasons = [
      `Trend ngắn hạn tốt (${tpScore}/100)`,
      `Conviction ${conviction.score}/100 — ${conviction.bullSignals.length} tín hiệu bull`,
    ];
    trigger = `Bán nếu giá đóng cửa dưới stoploss ${stopLoss.price} (${stopLoss.basis})`;
    watchFor = ["RSI divergence xuất hiện?", "Volume khi tiếp cận kháng cự"];
  } else if (tpScore >= 45) {
    action = "GIỮ — THEO DÕI";
    urgency = "THEO DÕI";
    reasons = ["Trend trung tính — chưa có tín hiệu rõ ràng để hành động"];
    trigger = `Thoát nếu giá phá vỡ stoploss ${stopLoss.price}`;
    watchFor = ["Xem lại trend sau 3–5 phiên", "Breakout nào xuất hiện trước?"];
  } else {
    action = "THẬN TRỌNG";
    urgency = "SỚM";
    reasons = [`Trend ngắn hạn yếu (${tpScore}/100) — đà giảm tiềm tàng`];
    trigger = `Giảm 25% nếu phá vỡ ${stopLoss.price}`;
    watchFor = ["Chờ confirmation từ volume và RSI", "Không thêm vị thế"];
  }

  return { action, urgency, conviction: conviction.score, reasons, watchFor, trigger };
}

function adviseMidTerm(pnlPct, d, stopLoss, cfg) {
  const midScore = d?.trendPro?.summary?.scores?.midTerm ?? 50;
  const al       = d?.trend?.alignment;
  const curPrice = d?.latestPrice;
  const ma50     = d?.indicators?.ma50;
  const aboveMa50 = ma50 && curPrice > ma50;

  let action, urgency, reasons = [], watchFor = [], trigger;

  if (pnlPct <= -15) {
    action = "THOÁT 50–100%";
    urgency = "SỚM";
    reasons = [
      `Lỗ ${Math.abs(pnlPct).toFixed(1)}% — cấu trúc vị thế hỏng nghiêm trọng`,
      "Mất MA50, luận điểm đầu tư cần đánh giá lại toàn bộ",
    ];
    trigger = "Thoát 50% ngay, 50% còn lại đặt stoploss chặt";
    watchFor = ["Tin tức cơ bản có thay đổi không?", "Cân nhắc tái vào khi có tín hiệu mới"];
  } else if (pnlPct < 0 && !aboveMa50 && midScore < 45) {
    action = "GIẢM 25–50%";
    urgency = "SỚM";
    reasons = [
      `Dưới MA50 + Trend trung hạn yếu (${midScore}/100)`,
      `Đang lỗ ${Math.abs(pnlPct).toFixed(1)}% — rủi ro tiếp tục tăng`,
    ];
    trigger = "Giảm vị thế tại các phiên phục hồi kỹ thuật (dead-cat bounce)";
    watchFor = ["MA50 như ngưỡng kháng cự cần vượt để đảo chiều", "Volume khi tiếp cận MA50"];
  } else if (al === "STRONG_UP" && aboveMa50) {
    action = "GIỮ CORE";
    urgency = "THEO DÕI";
    reasons = [
      "3/3 khung đồng thuận tăng — uptrend toàn diện",
      "Giá trên MA50 xác nhận xu hướng trung hạn còn nguyên",
    ];
    trigger = `Trailing stop: thoát khi giá đóng cửa dưới MA50 (${ma50 ? r2(ma50) : "—"})`;
    watchFor = ["Kiểm tra MA50 hàng tuần", "Volume tại kháng cự tiếp theo"];
  } else if (aboveMa50 && midScore >= 50) {
    action = "GIỮ — XEM XÉT TP";
    urgency = "THEO DÕI";
    reasons = [
      `Trend trung hạn ổn (${midScore}/100), giá trên MA50`,
      "Cân nhắc chốt một phần khi chạm kháng cự mạnh",
    ];
    trigger = "Chốt 25% khi giá chạm kháng cự trung hạn hoặc RSI > 70";
    watchFor = ["Volume khi tiếp cận kháng cự", "MA50 giữ hay hỏng?"];
  } else {
    action = "TRUNG LẬP";
    urgency = "THEO DÕI";
    reasons = [`Trend trung hạn (${midScore}/100) chưa rõ xu hướng`];
    trigger = `Vượt MA50 ${ma50 ? "(" + r2(ma50) + ")" : ""} với volume → tín hiệu bullish`;
    watchFor = ["MA50 là ngưỡng quyết định", "Phá vỡ xuống → giảm vị thế"];
  }

  return { action, urgency, conviction: clamp(midScore), reasons, watchFor, trigger };
}

function adviseLongTerm(pnlPct, d, cfg) {
  const al       = d?.trend?.alignment;
  const longDir  = d?.trend?.longTerm?.direction;
  const curPrice = d?.latestPrice;
  const ma200    = d?.indicators?.ma200;
  const aboveMa200 = ma200 && curPrice > ma200;

  let action, urgency, reasons = [], watchFor = [], trigger;

  if (pnlPct <= -20 || (longDir === "DOWNTREND" && al === "STRONG_DOWN")) {
    action = "ĐÁNH GIÁ LẠI";
    urgency = "SỚM";
    reasons = [
      "Downtrend dài hạn + lỗ lớn — rủi ro mất vốn dai dẳng",
      "Cần xem xét lại fundamentals và luận điểm gốc",
    ];
    trigger = "Thoát hoàn toàn nếu fundamentals thay đổi hoặc tiếp tục lỗ";
    watchFor = ["Tin tức ngành nghề và công ty", "Có catalyst phục hồi không?"];
  } else if (longDir === "UPTREND" && aboveMa200 && pnlPct >= 30) {
    action = "GIỮ + TRAILING STOP";
    urgency = "THEO DÕI";
    reasons = [
      `Uptrend dài hạn bền vững, đang lãi ${pnlPct.toFixed(1)}%`,
      "Để lợi nhuận chạy với trailing stop MA200 — đừng bán sớm winner",
    ];
    trigger = `Thoát khi giá đóng cửa dưới MA200 (${ma200 ? r2(ma200) : "—"}) hoặc fundamentals đổi`;
    watchFor = ["MA200 như ngưỡng hỗ trợ chiến lược", "Earnings, dividend, tin tức ngành"];
  } else if (longDir === "UPTREND" && aboveMa200) {
    action = "GIỮ DÀI HẠN";
    urgency = "THEO DÕI";
    reasons = [
      "Uptrend dài hạn còn nguyên vẹn, giá trên MA200",
      "Không cần hành động — để xu hướng làm việc",
    ];
    trigger = `Trailing stop tại MA200 (${ma200 ? r2(ma200) : "—"})`;
    watchFor = ["Earnings reports, cổ tức", "Ngành nghề còn tăng trưởng?"];
  } else {
    action = "TRUNG LẬP DÀI HẠN";
    urgency = "THEO DÕI";
    reasons = ["Không có tín hiệu rõ ràng về xu hướng dài hạn"];
    trigger = `Vượt MA200 ${ma200 ? "(" + r2(ma200) + ")" : ""} → bullish structure`;
    watchFor = ["Xu hướng ngành dài hạn", "Kết quả kinh doanh các quý tới"];
  }

  const longScore = longDir === "UPTREND" ? 65 : longDir === "DOWNTREND" ? 35 : 50;
  return { action, urgency, conviction: clamp(longScore), reasons, watchFor, trigger };
}

// ─── 8. SUMMARY ───────────────────────────────────────────────────────────────

function buildSummary(timeframes, health, conviction, pnlPct) {
  const primary = timeframes.short.action;
  const urgency = timeframes.short.urgency;

  let headline;
  if      (health.grade === "A" && conviction.score >= 60)
    headline = `Vị thế xuất sắc — tiếp tục ${primary}`;
  else if (health.grade === "B")
    headline = `Vị thế tốt — ${primary}`;
  else if (health.grade === "C")
    headline = `Vị thế cần thận trọng — ${primary}`;
  else
    headline = `⚠ Vị thế yếu — ${primary} ngay để bảo vệ vốn`;

  const topBull = conviction.bullSignals.slice(0, 2);
  const topBear = conviction.bearSignals.slice(0, 2);

  return {
    primaryAction: primary,
    urgency,
    headline,
    topBullSignals: topBull,
    topBearSignals: topBear,
    updatedAt: new Date().toISOString(),
  };
}

// ─── 9. PUBLIC API ────────────────────────────────────────────────────────────

/**
 * assessPositionPro — Tư vấn vị thế cổ phiếu đang nắm giữ.
 *
 * @param {object} analysisResult  Kết quả từ analyzeDetail()
 * @param {{ avgPrice: number, qty: number }} position  Thông tin vị thế
 * @param {object} customConfig  Override cấu hình mặc định
 * @returns {PositionAdvice}
 */
export function assessPositionPro(analysisResult, position, customConfig = {}) {
  const d = analysisResult;

  if (!d?.latestPrice)          return { error: "Thiếu dữ liệu phân tích" };
  if (!position?.avgPrice || !position?.qty)
    return { error: "Thiếu thông tin vị thế (avgPrice, qty)" };

  const cfg = deepMerge(DEFAULT_POSITION_CONFIG, customConfig);

  // ── Tính toán cơ bản ──
  const curPrice   = d.latestPrice;
  const avgPrice   = position.avgPrice;
  const qty        = position.qty;
  const cost       = avgPrice * qty;
  const marketValue = curPrice * qty;
  const pnl        = marketValue - cost;
  const pnlPct     = (pnl / cost) * 100;

  // ── Sub-analyses ──
  const stopLoss   = calcStopLoss(d, avgPrice, curPrice, pnlPct, cfg);
  const takeProfits = calcTakeProfits(
    curPrice,
    stopLoss.price,
    d.supportResistance?.resistances ?? [],
    cfg
  );
  const health     = calcPositionHealth(pnlPct, d, cfg);
  const conviction = calcConviction(d, pnlPct, cfg);

  const timeframes = {
    short: adviseShortTerm(pnlPct, d, stopLoss, conviction, cfg),
    mid:   adviseMidTerm(pnlPct, d, stopLoss, cfg),
    long:  adviseLongTerm(pnlPct, d, cfg),
  };

  const summary = buildSummary(timeframes, health, conviction, pnlPct);

  // ── Risk metrics ──
  const riskAmt = r2((curPrice - stopLoss.price) * qty);
  const currentRR = takeProfits[0]
    ? r2((takeProfits[0].price - curPrice) / Math.max(curPrice - stopLoss.price, 0.01))
    : null;

  return {
    positionMetrics: {
      avgPrice,
      currentPrice: curPrice,
      qty,
      cost:        r2(cost),
      marketValue: r2(marketValue),
      pnl:         r2(pnl),
      pnlPct:      r2(pnlPct),
    },
    health,
    risk: {
      stopLoss,
      takeProfits,
      riskAmount: riskAmt,
      currentRR,
    },
    conviction,
    timeframes,
    summary,
  };
}
