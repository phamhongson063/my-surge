const SERVER = `http://${location.hostname}:3000`;
let analysisData = null,
  mainChartInstance = null,
  rsiChartInstance = null,
  macdChartInstance = null,
  miniChartInstance = null,
  chartRange = 66,
  chartType = "line",
  realtimePriceData = null,
  mshEventSource = null;

// ── Collapse / Expand ──
function toggleCard(headerEl) {
  const body = headerEl.nextElementSibling;
  const icon = headerEl.querySelector(".toggle-icon");
  const isCollapsed = body.classList.contains("collapsed");
  if (isCollapsed) {
    // Expand: remove collapsed, measure, animate
    body.classList.remove("collapsed");
    if (icon) icon.classList.remove("collapsed");
    body.style.maxHeight = "0px";
    body.style.paddingBottom = "0px";
    body.style.opacity = "0";
    requestAnimationFrame(() => {
      body.style.maxHeight = body.scrollHeight + "px";
      body.style.paddingBottom = "28px";
      body.style.opacity = "1";
      // After transition, set auto so content can grow
      setTimeout(() => {
        body.style.maxHeight = "none";
      }, 350);
    });
  } else {
    // Collapse: set explicit height first, then animate to 0
    body.style.maxHeight = body.scrollHeight + "px";
    body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      body.style.maxHeight = "0px";
      body.style.paddingBottom = "0px";
      body.style.opacity = "0";
      body.classList.add("collapsed");
      if (icon) icon.classList.add("collapsed");
    });
  }
}
function _toggleAllCards(expand) {
  document.querySelectorAll(".card-body").forEach((b) => {
    if (!expand) b.style.maxHeight = b.scrollHeight + "px";
    else b.classList.remove("collapsed");
    requestAnimationFrame(() => {
      b.style.maxHeight = expand ? b.scrollHeight + "px" : "0px";
      b.style.paddingBottom = expand ? "28px" : "0px";
      b.style.opacity = expand ? "1" : "0";
      b.classList[expand ? "remove" : "add"]("collapsed");
      const ic = b.previousElementSibling?.querySelector(".toggle-icon");
      if (ic) ic.classList[expand ? "remove" : "add"]("collapsed");
      if (expand) setTimeout(() => { b.style.maxHeight = "none"; }, 350);
    });
  });
}
function collapseAll() { _toggleAllCards(false); }
function expandAll()   { _toggleAllCards(true);  }
const fp = (v) => {
  if (v == null) return "—";
  return parseFloat(v).toLocaleString("vi-VN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
const fv = (n) => (n ? Number(n).toLocaleString("en-US") : "—");
function parseChange(r) {
  if (!r) return { val: null, pct: null, dir: 0 };
  const m = String(r).match(/^([+-]?[\d,\.]+)\(([+-]?[\d,\.]+)\s*%\)/);
  if (!m) return { val: null, pct: null, dir: 0 };
  const v = parseFloat(m[1].replace(",", ".")),
    p = parseFloat(m[2].replace(",", "."));
  return { val: v, pct: p, dir: v > 0 ? 1 : v < 0 ? -1 : 0 };
}
const bc = (d) =>
  d === "UPTREND" ? "b-up" : d === "DOWNTREND" ? "b-dn" : "b-sd";
const ta = (d) => (d === "UPTREND" ? "▲" : d === "DOWNTREND" ? "▼" : "➡");
const tl = (d) =>
  d === "UPTREND" ? "Tăng" : d === "DOWNTREND" ? "Giảm" : "Sideway";

// ── Shared utility helpers ──────────────────────────────────────────────────
// Grade colors (A/B/C/D)
const _gc  = g => g==="A"?"var(--up)":g==="B"?"var(--navy)":g==="C"?"var(--am)":"var(--dn)";
const _gbg = g => g==="A"?"var(--up-bg)":g==="B"?"var(--navy-l)":g==="C"?"var(--am-bg)":"var(--dn-bg)";
const _gbd = g => g==="A"?"var(--up-bd)":g==="B"?"rgba(0,58,107,.2)":g==="C"?"var(--am-bd)":"var(--dn-bd)";
// Direction colors (positive/negative/neutral)
const _dirColor = d => d>0?"var(--up)":d<0?"var(--dn)":"var(--am)";
const _dirBg    = d => d>0?"var(--up-bg)":d<0?"var(--dn-bg)":"var(--am-bg)";
const _dirBd    = d => d>0?"var(--up-bd)":d<0?"var(--dn-bd)":"var(--am-bd)";
// Progress bar HTML
const _bar = (pct, color, h=6) =>
  `<div style="height:${h}px;border-radius:${Math.ceil(h/2)}px;background:var(--gray100);overflow:hidden"><div style="height:100%;width:${pct}%;background:${color};border-radius:${Math.ceil(h/2)}px;transition:width .5s"></div></div>`;
// Pill/badge HTML
const _pill = (txt, bg, tx, bd=bg, px=10, py=3) =>
  `<span style="display:inline-flex;align-items:center;padding:${py}px ${px}px;border-radius:20px;font-size:12px;font-weight:700;background:${bg};color:${tx};border:1px solid ${bd}">${txt}</span>`;

// ── Autocomplete ───────────────────────────────────────────────────────────
let allSymbols = [],
  acIdx = -1;
async function loadSymbols() {
  try {
    const r = await fetch(`${SERVER}/symbols`);
    const d = await r.json();
    allSymbols = d.symbols || [];
  } catch {}
}
function filterAutocomplete(val) {
  val = (val || "").toUpperCase().trim();
  const dd = document.getElementById("acDropdown");
  if (!val) {
    dd.style.display = "none";
    return;
  }
  const matches = allSymbols.filter((s) => s.startsWith(val)).slice(0, 8);
  if (!matches.length) {
    dd.style.display = "none";
    return;
  }
  acIdx = -1;
  dd.innerHTML = matches
    .map(
      (s, i) => `<div data-i="${i}" onmousedown="pickSymbol('${s}')"
style="padding:9px 16px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:var(--navy);cursor:pointer;border-bottom:1px solid var(--gray100)"
onmouseover="this.style.background='var(--navy-l)'" onmouseout="this.style.background=''">${s}</div>`
    )
    .join("");
  dd.style.display = "block";
}
function showAutocomplete() {
  if (document.getElementById("symbolInput").value.trim())
    filterAutocomplete(document.getElementById("symbolInput").value);
}
function hideAutocomplete() {
  const dd = document.getElementById("acDropdown");
  if (dd) dd.style.display = "none";
  acIdx = -1;
}
function pickSymbol(s) {
  document.getElementById("symbolInput").value = s;
  hideAutocomplete();
  loadAnalysis(s);
}
function handleSymbolKey(e) {
  const dd = document.getElementById("acDropdown");
  const items = dd?.querySelectorAll("[data-i]");
  if (dd?.style.display === "block" && items?.length) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIdx = Math.min(acIdx + 1, items.length - 1);
      items.forEach(
        (el, i) =>
          (el.style.background = i === acIdx ? "var(--navy-l)" : "")
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      acIdx = Math.max(acIdx - 1, 0);
      items.forEach(
        (el, i) =>
          (el.style.background = i === acIdx ? "var(--navy-l)" : "")
      );
      return;
    }
    if (e.key === "Enter" && acIdx >= 0 && !e.isComposing) {
      e.preventDefault();
      pickSymbol(items[acIdx].textContent);
      return;
    }
  }
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    loadAnalysis(document.getElementById("symbolInput").value);
  }
}

// ── Watchlist ──────────────────────────────────────────────────────────────
let watchlistSymbols = [];
async function loadWatchlistState() {
  try {
    const r = await fetch(`${SERVER}/watchlist`);
    const d = await r.json();
    watchlistSymbols = d.symbols || [];
    updateWatchlistBtn();
  } catch {}
}
function updateWatchlistBtn() {
  const sym = document
    .getElementById("symbolInput")
    ?.value?.toUpperCase()
    .trim();
  const btn = document.getElementById("watchlistBtn");
  const icon = document.getElementById("watchlistIcon");
  if (!btn || !icon || !sym) return;
  const inList = watchlistSymbols.includes(sym);
  btn.style.background = inList ? "var(--dn-bg)" : "var(--wht)";
  btn.style.borderColor = inList ? "var(--dn-bd)" : "var(--gray200)";
  icon.setAttribute("stroke", inList ? "var(--dn)" : "var(--gray400)");
  icon.setAttribute("fill", inList ? "var(--dn)" : "none");
  btn.title = inList ? "Xóa khỏi Watchlist" : "Thêm vào Watchlist";
}
async function toggleWatchlist() {
  const sym = document
    .getElementById("symbolInput")
    ?.value?.toUpperCase()
    .trim();
  if (!sym) return;
  const inList = watchlistSymbols.includes(sym);
  const endpoint = inList ? "/watchlist/remove" : "/watchlist/add";
  try {
    const r = await fetch(`${SERVER}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym }),
    });
    const d = await r.json();
    if (d.ok) {
      watchlistSymbols = d.symbols || [];
      updateWatchlistBtn();
      // Toast notification nhỏ
      showToast(
        inList
          ? `Đã xóa ${sym} khỏi Watchlist`
          : `Đã thêm ${sym} vào Watchlist`,
        inList ? "var(--gray700)" : "var(--up)"
      );
    }
  } catch (e) {
    console.warn("Watchlist error:", e.message);
  }
}
function showToast(msg, color = "var(--gray700)") {
  let t = document.getElementById("wlToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "wlToast";
    t.style.cssText =
      "position:fixed;bottom:28px;right:28px;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;color:#fff;z-index:9999;transition:opacity .3s;pointer-events:none";
    document.body.appendChild(t);
  }
  t.style.background = color;
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._tm);
  t._tm = setTimeout(() => {
    t.style.opacity = "0";
  }, 2500);
}

// ── Header price pill (hiện khi scroll qua hero) ──────────────────────────
function initFloatingPrice() {
  const hero = document.querySelector("#resultContent .card");
  const pill = document.getElementById("headerPricePill");
  if (!pill) return;
  window.addEventListener(
    "scroll",
    () => {
      if (!analysisData || !hero) {
        pill.style.opacity = "0";
        pill.style.transform = "translateX(-6px)";
        pill.style.pointerEvents = "none";
        return;
      }
      const show = hero.getBoundingClientRect().bottom < 60;
      pill.style.opacity = show ? "1" : "0";
      pill.style.transform = show ? "translateX(0)" : "translateX(-6px)";
      pill.style.pointerEvents = show ? "auto" : "none";
    },
    { passive: true }
  );
}

function updateFloatingPrice(d) {
  const sym = document.getElementById("hp-symbol");
  const price = document.getElementById("hp-price");
  const change = document.getElementById("hp-change");
  const pill = document.getElementById("headerPricePill");
  if (!sym) return;
  sym.textContent = d.symbol || "—";
  price.textContent = fp(d.latestPrice);
  const ch = parseChange(d.latestChange);
  const s = ch.dir > 0 ? "+" : "";
  if (ch.val != null) {
    change.textContent = `${s}${fp(ch.val)} (${s}${ch.pct?.toFixed(2)}%)`;
    change.style.color =
      ch.dir > 0 ? "var(--up)" : ch.dir < 0 ? "var(--dn)" : "var(--am)";
    if (pill) {
      pill.style.borderColor =
        ch.dir > 0
          ? "var(--up-bd)"
          : ch.dir < 0
          ? "var(--dn-bd)"
          : "var(--am-bd)";
      pill.style.background =
        ch.dir > 0
          ? "var(--up-bg)"
          : ch.dir < 0
          ? "var(--dn-bg)"
          : "var(--am-bg)";
    }
  } else {
    change.textContent = "—";
    change.style.color = "var(--gray400)";
  }
}

async function updateData() {
  const sym = document
    .getElementById("symbolInput")
    ?.value?.toUpperCase()
    .trim();
  if (!sym) {
    showToast("Chọn mã trước", "var(--dn)");
    return;
  }
  const btn = document.getElementById("updateDataBtn");
  btn.disabled = true;
  btn.style.opacity = ".5";
  const origHTML = btn.innerHTML;
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="animation:sp .7s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
  try {
    const r = await fetch(
      `${SERVER}/api/history-fetch?symbol=${sym}&days=1100`
    );
    const j = await r.json();
    if (!r.ok || j.error) {
      showToast("Lỗi: " + (j.error || "Không tải được"), "var(--dn)");
    } else {
      showToast(
        `Đã cập nhật ${sym} (${j.count} phiên · SSI)`,
        "var(--up)"
      );
      loadAnalysis(sym, true);
    }
  } catch (e) {
    showToast("Lỗi kết nối", "var(--dn)");
  }
  btn.disabled = false;
  btn.style.opacity = "1";
  btn.innerHTML = origHTML;
}

async function loadAnalysis(sym, forceRefresh = false) {
  sym = (sym || "").toUpperCase().trim();
  if (!sym) return;
  closeMshStream(); // đóng stream mã cũ trước khi load mã mới
  document.getElementById("symbolInput").value = sym;
  document.getElementById("emptyState").style.display = "none";
  document.getElementById("errorState").style.display = "none";
  document.getElementById("resultContent").style.display = "none";
  document.getElementById("loadingState").style.display = "block";
  const u = new URL(location);
  u.searchParams.set("s", sym);
  history.replaceState(null, "", u);
  document.title = sym + " — Phân tích";
  destroyCharts();
  document.getElementById("symbolBadge").textContent = sym;
  [
    "priceDisplay",
    "changeDisplay",
    "refVal",
    "openVal",
    "highVal",
    "lowVal",
    "volumeVal",
    "ceilingVal",
    "floorVal",
  ].forEach((i) => {
    const e = document.getElementById(i);
    if (e) e.textContent = "—";
  });
  ["heroTrendAlign","heroTrendAction","heroVolRatio","heroRsiPill","heroAtrPill"].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.style.display = "none";
  });
  _prevRt = {};
  document.getElementById("dateRange").textContent = "";
  document.getElementById("recBadge").textContent = "";
  [
    "trendContent",
    "trendProContent",
    "alignmentBadge",
    "hero52wBar",
    "heroMaRow",
    "heroSrScoreRow",
    "indicatorsContent",
    "volumeContent",
    "predictionsContent",
    "srContent",
    "patternsContent",
    "rsContent",
    "patternsTabContent",
    "canslimContent",
    "sepaContent",
    "momentumContent",
    "investProfileContent",
  ].forEach((i) => {
    const e = document.getElementById(i);
    if (e) e.innerHTML = "";
  });
  document.querySelectorAll(".an").forEach((e) => {
    e.style.animation = "none";
    e.offsetHeight;
    e.style.animation = "";
  });

  const setLoadingMsg = (msg) => {
    const el = document.querySelector("#loadingState div:last-child");
    if (el) el.textContent = msg;
  };

  try {
    // ── Nếu force refresh: tải lại dữ liệu mới nhất từ SSI trước ──────────
    if (forceRefresh) {
      setLoadingMsg(`Đang tải dữ liệu mới ${sym} từ SSI…`);
      try {
        const dlRes = await fetch(
          `${SERVER}/api/history-fetch?symbol=${sym}&days=1100`
        );
        const dlJson = await dlRes.json();
        if (!dlRes.ok || dlJson.error) {
          console.warn(
            `[History] ${sym}: ${dlJson.error || "HTTP " + dlRes.status}`
          );
          setLoadingMsg(
            `Không tải được dữ liệu mới, dùng dữ liệu hiện có…`
          );
          await new Promise((r) => setTimeout(r, 800));
        } else {
          setLoadingMsg(
            `Đã tải ${dlJson.count} phiên từ SSI · Đang phân tích ${sym}…`
          );
        }
      } catch (dlErr) {
        console.warn(`[History] Lỗi kết nối:`, dlErr.message);
        setLoadingMsg(
          `Không tải được dữ liệu mới, dùng dữ liệu hiện có…`
        );
        await new Promise((r) => setTimeout(r, 800));
      }
    } else {
      setLoadingMsg(`Đang phân tích…`);
    }

    const res = await fetch(
      `${SERVER}/analyze-detail?symbol=${sym}${
        forceRefresh ? "&refresh=1" : ""
      }`
    );
    const j = await res.json();

    // ── Nếu chưa có dữ liệu → tự động tải từ SSI rồi retry ─────────────────
    if (j.error && j.error.includes("Không tìm thấy")) {
      setLoadingMsg(`Chưa có dữ liệu, đang tải ${sym} từ SSI…`);
      const dlRes = await fetch(
        `${SERVER}/api/history-fetch?symbol=${sym}&days=1100`
      );
      const dlJson = await dlRes.json();
      if (!dlRes.ok || dlJson.error)
        throw new Error(dlJson.error || `Không tải được dữ liệu ${sym}`);
      setLoadingMsg(
        `Đã tải ${dlJson.count} phiên · Đang phân tích ${sym}…`
      );
      // Retry analyze sau khi tải xong
      const res2 = await fetch(
        `${SERVER}/analyze-detail?symbol=${sym}&refresh=1`
      );
      const j2 = await res2.json();
      if (!res2.ok || j2.error)
        throw new Error(j2.error ?? `HTTP ${res2.status}`);
      analysisData = j2;
    } else {
      if (!res.ok || j.error)
        throw new Error(j.error ?? `HTTP ${res.status}`);
      analysisData = j;
    }

    document.getElementById("loadingState").style.display = "none";
    document.getElementById("resultContent").style.display = "block";
    document.getElementById("collapseControls").style.display = "flex";
    localStorage.setItem("detail_last_symbol", sym);
    document.getElementById("updateDataBtn").style.display =
      "inline-flex";
    const cb = document.getElementById("cacheBadge");
    if (cb) {
      if (analysisData._fromCache) {
        cb.style.display = "inline-flex";
        cb.title = `Cache ${analysisData._cacheAgeMin ?? 0} phút trước`;
      } else {
        cb.style.display = "none";
      }
    }
    renderAll(analysisData);
    updateWatchlistBtn();
    loadRealtimePrice(sym);
    renderCompanyInfo(analysisData.companyInfo);
  } catch (e) {
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("errorState").style.display = "block";
    document.getElementById("errorMsg").textContent = e.message;
  }
}

function renderAll(d) {
  document.getElementById("symbolBadge").textContent = d.symbol;
  const priceEl = document.getElementById("priceDisplay");
  priceEl.textContent = fp(d.latestPrice);
  priceEl.style.color = "var(--gray900)";
  document.getElementById("openVal").textContent = fp(d.latestOpen);
  document.getElementById("highVal").textContent = fp(d.latestHigh);
  document.getElementById("lowVal").textContent = fp(d.latestLow);
  if (d.latestRef != null) document.getElementById("refVal").textContent = fp(d.latestRef);
  if (d.ceiling != null)   document.getElementById("ceilingVal").textContent = fp(d.ceiling);
  if (d.floor != null)     document.getElementById("floorVal").textContent = fp(d.floor);
  renderHeroExtra(d);
  // Volume từ phiên cuối (chart data)
  const lastVol = d.chart?.volumes?.[d.chart.volumes.length - 1];
  if (lastVol != null) {
    const ve = document.getElementById("volumeVal");
    if (ve) ve.textContent = fvol(lastVol);
  }
  document.getElementById(
    "dateRange"
  ).textContent = `Phiên cuối: ${d.latestDate} · ${d.dateRange.from} → ${d.dateRange.to} (${d.totalSessions} phiên)`;
  const ch = parseChange(d.latestChange),
    ce = document.getElementById("changeDisplay"),
    s = ch.dir > 0 ? "+" : "";
  ce.style.color =
    ch.dir > 0 ? "var(--up)" : ch.dir < 0 ? "var(--dn)" : "var(--am)";
  ce.textContent =
    ch.val != null
      ? `${s}${fp(ch.val)} (${s}${ch.pct?.toFixed(2)}%)`
      : "—";
  const rb = document.getElementById("recBadge");
  rb.textContent = d.predictions.recommendation;
  rb.style.cssText = `display:inline-flex;align-items:center;padding:6px 16px;border-radius:20px;font-size:14px;font-weight:700;background:${d.predictions.recColor}15;color:${d.predictions.recColor};border:1px solid ${d.predictions.recColor}30`;
  renderTrend(d.trend);
  renderTrendPro(d.trendPro);
  renderIndicators(d.indicators);
  renderVolume(d.volume);
  renderPredictions(d.predictions);
  renderSR(d.supportResistance, d.latestPrice);
  renderPatterns(d.candlePatterns);
  renderRS(d.rsVsIndex);
  renderCharts(d);
  renderMTFPatterns(d.multiTimeframePatterns, d.patternVerdict);
  if (d.scoring) renderScoring(d.scoring);
  if (d.investmentProfile) renderInvestProfile(d.investmentProfile);
  renderPortfolio();
  migratePortfolioIfNeeded();
  updateFloatingPrice(d);
  setPipData(d.symbol, d.latestPrice, ch.val, ch.pct, ch.dir >= 0);
}

// ── Hero Card Extra: 52W range, MA status, S/R, Trend badges ──
function renderHeroExtra(d) {
  const price = d.latestPrice;
  const ind   = d.indicators;

  // 1. Trend alignment badge
  const alEl = document.getElementById("heroTrendAlign");
  if (alEl && d.trend?.alignment) {
    const MAP = {
      STRONG_UP:    { bg:"var(--up-bg)",   bd:"var(--up-bd)",           tx:"var(--up)",   lbl:"▲ 3/3 TĂNG" },
      MODERATE_UP:  { bg:"var(--navy-l)",  bd:"rgba(0,58,107,.2)",      tx:"var(--navy)", lbl:"▲ 2/3 TĂNG" },
      MIXED:        { bg:"var(--am-bg)",   bd:"var(--am-bd)",           tx:"var(--am)",   lbl:"↔ MIXED" },
      MODERATE_DOWN:{ bg:"var(--dn-bg)",   bd:"var(--dn-bd)",           tx:"var(--dn)",   lbl:"▼ 2/3 GIẢM" },
      STRONG_DOWN:  { bg:"var(--dn-bg)",   bd:"var(--dn-bd)",           tx:"var(--dn)",   lbl:"▼ 3/3 GIẢM" },
    };
    const c = MAP[d.trend.alignment] || MAP.MIXED;
    alEl.style.cssText = `display:inline-flex;align-items:center;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:${c.bg};color:${c.tx};border:1px solid ${c.bd}`;
    alEl.textContent = c.lbl;
  }

  // 2. TrendPro action badge
  const tpEl = document.getElementById("heroTrendAction");
  if (tpEl && d.trendPro?.summary?.marketState) {
    const STATE_MAP = {
      "FTD Confirmed":  { bg:"var(--up-bg)",   bd:"var(--up-bd)",   tx:"var(--up)"  },
      "Strong Bullish": { bg:"var(--up-bg)",   bd:"var(--up-bd)",   tx:"var(--up)"  },
      "Bullish":        { bg:"var(--up-bg)",   bd:"var(--up-bd)",   tx:"var(--up)"  },
      "Mild Bullish":   { bg:"var(--navy-l)",  bd:"rgba(0,58,107,.2)", tx:"var(--navy)" },
      "Sideways":       { bg:"var(--am-bg)",   bd:"var(--am-bd)",   tx:"var(--am)"  },
      "Mild Bearish":   { bg:"var(--am-bg)",   bd:"var(--am-bd)",   tx:"var(--am)"  },
      "Bearish":        { bg:"var(--dn-bg)",   bd:"var(--dn-bd)",   tx:"var(--dn)"  },
      "Strong Bearish": { bg:"var(--dn-bg)",   bd:"var(--dn-bd)",   tx:"var(--dn)"  },
    };
    const c = STATE_MAP[d.trendPro.summary.marketState] || STATE_MAP["Sideways"];
    tpEl.style.cssText = `display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:${c.bg};color:${c.tx};border:1px solid ${c.bd};cursor:help`;
    tpEl.innerHTML = `${d.trendPro.summary.action} <span style="opacity:.6;font-size:11px">ⓘ</span>`;
    tpEl.dataset.tooltip = buildTrendProTooltip(d.trendPro.summary.action, d);
  }

  // 3. Volume ratio pill
  const vrEl = document.getElementById("heroVolRatio");
  if (vrEl && d.volume?.ratio != null) {
    const r = d.volume.ratio;
    const c = r > 2 ? "var(--up)" : r > 1.4 ? "var(--am)" : "var(--gray500)";
    const bg = r > 2 ? "var(--up-bg)" : r > 1.4 ? "var(--am-bg)" : "var(--gray100)";
    vrEl.style.cssText = `display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;background:${bg};color:${c}`;
    vrEl.textContent = `${r.toFixed(1)}x TB20${d.volume.isSurge ? " 🔥" : ""}`;
  }

  // 4. RSI pill
  const rsiEl = document.getElementById("heroRsiPill");
  if (rsiEl && ind?.rsi != null) {
    const rsi = ind.rsi;
    const c  = rsi > 70 ? "var(--dn)" : rsi < 30 ? "var(--up)" : "var(--gray700)";
    const bg = rsi > 70 ? "var(--dn-bg)" : rsi < 30 ? "var(--up-bg)" : "var(--gray100)";
    const lbl = rsi > 70 ? " · Quá mua" : rsi < 30 ? " · Quá bán" : "";
    rsiEl.style.cssText = `display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;background:${bg};color:${c}`;
    rsiEl.textContent = `RSI ${rsi.toFixed(0)}${lbl}`;
  }

  // 5. ATR pill
  const atrEl = document.getElementById("heroAtrPill");
  if (atrEl && ind?.atrPct != null) {
    atrEl.style.cssText = `display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;background:var(--am-bg);color:var(--am)`;
    atrEl.textContent = `ATR ${ind.atrPct}%/ngày`;
  }

  // 6. 52W range bar
  const barEl = document.getElementById("hero52wBar");
  if (barEl && d.high52w && d.low52w) {
    const range = d.high52w - d.low52w || 1;
    const pos = Math.min(100, Math.max(0, ((price - d.low52w) / range) * 100));
    const dotPos = Math.min(96, Math.max(2, pos));
    const barC = pos >= 80 ? "var(--up)" : pos >= 50 ? "var(--navy)" : pos >= 20 ? "var(--am)" : "var(--dn)";
    const pFH = d.pctFromHigh52w;
    const pFHColor = pFH >= -5 ? "var(--up)" : pFH >= -15 ? "var(--am)" : "var(--dn)";
    barEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.6px;white-space:nowrap;min-width:56px">52 TUẦN</span>
        <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;color:var(--dn);white-space:nowrap">${fp(d.low52w)}</span>
        <div style="flex:1;height:6px;background:var(--gray200);border-radius:3px;position:relative;min-width:60px">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pos}%;background:${barC};border-radius:3px"></div>
          <div style="position:absolute;top:50%;left:${dotPos}%;width:11px;height:11px;background:#f59e0b;border:2px solid #fff;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 1px 5px rgba(0,0,0,.3)"></div>
        </div>
        <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;color:var(--up);white-space:nowrap">${fp(d.high52w)}</span>
        <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:${pFHColor};white-space:nowrap">${pFH > 0 ? "+" : ""}${pFH}% từ đỉnh</span>
      </div>`;
  }

  // 7. MA status row
  const maEl = document.getElementById("heroMaRow");
  if (maEl && ind) {
    const maItem = (lbl, val) => {
      if (!val) return "";
      const d_ = ((price - val) / val * 100);
      const isUp = d_ >= 0;
      const c  = isUp ? "var(--up)" : "var(--dn)";
      const bg = isUp ? "var(--up-bg)" : "var(--dn-bg)";
      const bd = isUp ? "var(--up-bd)" : "var(--dn-bd)";
      return `<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${bg};color:${c};border:1px solid ${bd}">
        ${lbl}<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:11px">${isUp?"+":""}${d_.toFixed(1)}%</span>
      </span>`;
    };
    // 8. S/R + Scoring — gộp cùng dòng MA
    const sr  = d.supportResistance;
    const sc  = d.scoring;
    const nearSup = sr?.supports?.[0];
    const nearRes = sr?.resistances?.[0];
    let srH = "";
    if (nearSup?.price) {
      const diff = ((price - nearSup.price) / price * 100).toFixed(1);
      srH += `<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:var(--up-bg);color:var(--up);border:1px solid var(--up-bd)">▲ HT ${fp(nearSup.price)} <span style="font-size:10px;opacity:.8">−${diff}%</span></span>`;
    }
    if (nearRes?.price) {
      const diff = ((nearRes.price - price) / price * 100).toFixed(1);
      srH += `<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:var(--dn-bg);color:var(--dn);border:1px solid var(--dn-bd)">▼ KC ${fp(nearRes.price)} <span style="font-size:10px;opacity:.8">+${diff}%</span></span>`;
    }
    if (sc) {
      const badge = (lbl, g, tip) => g ? `<span title="${tip}" style="cursor:default;padding:3px 9px;border-radius:8px;font-size:11px;font-weight:700;background:${_gbg(g)};color:${_gc(g)};border:1px solid ${_gbd(g)}">${lbl}:${g}</span>` : "";
      if (srH) srH += `<span style="color:var(--gray300);flex-shrink:0">·</span>`;
      srH += badge("C", sc.canslim?.grade, "CANSLIM — Hệ thống chọn cổ phiếu tăng trưởng của William O'Neil") + badge("S", sc.sepa?.grade, "SEPA — Phương pháp phân tích kỹ thuật của Mark Minervini") + badge("M", sc.momentum?.grade, "Momentum — Đánh giá động lực tăng giá");
    }
    const sep = srH ? `<span style="color:var(--gray300);flex-shrink:0">·</span>` : "";
    maEl.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow:hidden";
    maEl.innerHTML = `<span style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.5px;flex-shrink:0">MA</span>`
      + maItem("MA20", ind.ma20)
      + maItem("MA50", ind.ma50)
      + maItem("MA200", ind.ma200)
      + sep + srH;

    const srEl = document.getElementById("heroSrScoreRow");
    if (srEl) srEl.style.display = "none";
  }
}

// ── Investment Profile ──
function renderInvestProfile(ip) {
  const el = document.getElementById("investProfileContent");
  if (!ip) {
    el.innerHTML =
      '<div style="color:var(--gray400);font-size:14px">Không đủ dữ liệu</div>';
    return;
  }

  const periods = [ip.shortTerm, ip.midTerm, ip.longTerm];

  const icons = { 0: "⚡", 1: "📊", 2: "🏦" };

  // Best fit banner
  let h = `<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:12px;background:${_gbg(
    periods.reduce((a, b) => (a.score > b.score ? a : b)).grade
  )};border:2px solid ${_gbd(
    periods.reduce((a, b) => (a.score > b.score ? a : b)).grade
  )};margin-bottom:20px">
<span style="font-size:24px">🏆</span>
<div>
<div style="font-size:15px;font-weight:700;color:var(--gray900)">Phù hợp nhất: <span style="color:${_gc(
  periods.reduce((a, b) => (a.score > b.score ? a : b)).grade
)}">${ip.bestFit}</span></div>
<div style="font-size:13px;color:var(--gray500)">${
  periods.reduce((a, b) => (a.score > b.score ? a : b)).desc
}</div>
</div>
  </div>`;

  // 3 columns
  h += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">`;
  periods.forEach((p, i) => {
    const isBest = p.label === ip.bestFit;
    const border = isBest
      ? `3px solid ${_gc(p.grade)}`
      : `1px solid var(--gray200)`;
    const pct = Math.round((p.score / p.max) * 100);

    h += `<div style="border-radius:14px;border:${border};overflow:hidden;${
      isBest ? "box-shadow:0 4px 20px rgba(0,0,0,.08)" : ""
    }">
<!-- Header -->
<div style="padding:16px 18px;background:${_gbg(p.grade)}">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:20px">${icons[i]}</span>
      <span style="font-size:15px;font-weight:700;color:var(--gray900)">${
        p.label
      }</span>
    </div>
    <div style="width:40px;height:40px;border-radius:12px;background:${_gc(
      p.grade
    )};color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:800;font-size:18px">${
      p.grade
    }</div>
  </div>
  <div style="font-size:12px;color:var(--gray500);margin-bottom:8px">${
    p.desc
  }</div>
  <div style="display:flex;align-items:center;gap:10px">
    <div style="flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.5);overflow:hidden"><div style="height:100%;width:${pct}%;background:${_gc(
      p.grade
    )};border-radius:4px"></div></div>
    <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;color:${_gc(
      p.grade
    )}">${p.score}</span>
  </div>
  <div style="font-size:12px;font-weight:600;color:${_gc(
    p.grade
  )};margin-top:4px">${p.suitability} · ${p.bullCount}🟢 ${
      p.bearCount
    }🔴</div>
</div>
<!-- Factors -->
<div style="padding:14px 18px">`;

    p.factors.forEach((f) => {
      const fc =
        f.signal === "bullish"
          ? "var(--up)"
          : f.signal === "bearish"
          ? "var(--dn)"
          : "var(--am)";
      const fpct = Math.round((f.score / f.max) * 100);
      h += `<div style="margin-bottom:10px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
    <span style="font-size:12px;font-weight:600;color:var(--gray700)">${f.name}</span>
    <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:${fc}">${f.score}/${f.max}</span>
  </div>
  <div style="height:4px;border-radius:2px;background:var(--gray100);margin-bottom:3px"><div style="height:100%;width:${fpct}%;background:${fc};border-radius:2px"></div></div>
  <div style="font-size:11px;color:var(--gray400)">${f.detail}</div>
</div>`;
    });

    h += `</div>
<!-- Verdict -->
<div style="padding:0 18px 16px">
  <div style="padding:10px 14px;border-radius:10px;background:${_gbg(
    p.grade
  )};border:1px solid ${_gbd(p.grade)}">
    <div style="font-size:12px;font-weight:600;color:${_gc(
      p.grade
    )};margin-bottom:4px">${p.verdict}</div>
    <div style="font-size:11px;color:var(--gray500)">💡 ${
      p.suggestion
    }</div>
  </div>
</div>
</div>`;
  });
  h += `</div>`;
  el.innerHTML = h;
}

// ── Scoring Methods ──
function renderScoring(sc) {
  renderOneScore("canslimContent", sc.canslim);
  renderOneScore("sepaContent", sc.sepa);
  renderOneScore("momentumContent", sc.momentum);
}
function renderOneScore(elId, s) {
  const el = document.getElementById(elId);
  if (!el || !s) {
    if (el)
      el.innerHTML =
        '<div style="color:var(--gray400);font-size:14px">Không đủ dữ liệu</div>';
    return;
  }
  const gc = _gc(s.grade);
  const gbg = _gbg(s.grade);
  const pct = Math.round((s.total / s.maxTotal) * 100);
  let h = `<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
<div style="width:56px;height:56px;border-radius:14px;background:${gbg};display:flex;align-items:center;justify-content:center;flex-shrink:0">
<span style="font-family:'Syne',sans-serif;font-weight:800;font-size:24px;color:${gc}">${s.grade}</span>
</div>
<div>
<div style="font-size:15px;font-weight:700;color:var(--gray900)">${s.total}/${s.maxTotal} điểm (${pct}%)</div>
<div style="font-size:12px;color:var(--gray500);margin-top:2px">${s.passCount}/${s.totalCriteria} tiêu chí đạt</div>
</div>
  </div>
  <div style="height:8px;border-radius:4px;background:var(--gray100);margin-bottom:12px;overflow:hidden">
<div style="height:100%;width:${pct}%;background:${gc};border-radius:4px;transition:width .5s"></div>
  </div>
  <div style="padding:10px 14px;border-radius:10px;background:${gbg};margin-bottom:16px;font-size:13px;font-weight:600;color:${gc};line-height:1.5">${s.verdict}</div>`;

  s.criteria.forEach((c) => {
    const pass = c.pass;
    const ic = pass ? "✅" : "❌";
    const sc2 = c.score != null ? c.score : 0;
    const mx = c.max || 10;
    const barPct = Math.round((sc2 / mx) * 100);
    const bc2 = pass
      ? "var(--up)"
      : sc2 >= mx * 0.4
      ? "var(--am)"
      : "var(--dn)";
    h += `<div style="padding:10px 0;border-bottom:1px solid var(--gray100)">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
  <span style="font-size:13px;font-weight:600;color:var(--gray900)">${ic} ${
      c.key || ""
    } ${c.name}</span>
  <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${bc2}">${sc2}/${mx}</span>
</div>
<div style="font-size:12px;color:var(--gray500);margin-bottom:6px">${
  c.detail || ""
}</div>
${_bar(barPct, bc2, 4)}
</div>`;
  });
  el.innerHTML = h;
}

// ── Generic tab switcher ──
function _setTabGroup(tabs, selected, btnPrefix, contentSuffix) {
  tabs.forEach(t => {
    const active = t === selected;
    const b = document.getElementById(btnPrefix + t);
    const c = contentSuffix != null ? document.getElementById(t + contentSuffix) : null;
    if (b) {
      b.style.background   = active ? "var(--navy)" : "var(--wht)";
      b.style.color        = active ? "#fff"        : "var(--gray500)";
      b.style.borderColor  = active ? "var(--navy)" : "var(--gray200)";
    }
    if (c) c.style.display = active ? "" : "none";
  });
}

let currentPatternTab = "short";
function setPatternTab(tab) {
  currentPatternTab = tab;
  _setTabGroup(["short", "mid", "long"], tab, "ptab-", null);
  if (analysisData?.multiTimeframePatterns)
    renderMTFPatterns(analysisData.multiTimeframePatterns, analysisData.patternVerdict);
}

let currentScoreTab = "canslim";
function setScoreTab(tab) {
  currentScoreTab = tab;
  _setTabGroup(["canslim", "sepa", "momentum"], tab, "stab-", "Content");
}

function renderMTFPatterns(mtf, verdict) {
  const el = document.getElementById("patternsTabContent");
  const summaryEl = document.getElementById("patternOverallSummary");
  const verdictEl = document.getElementById("patternTabVerdict");
  if (!mtf) {
    el.innerHTML =
      '<div style="font-size:14px;color:var(--gray400);grid-column:1/-1">Không có dữ liệu</div>';
    summaryEl.innerHTML = "";
    verdictEl.innerHTML = "";
    return;
  }

  // ── Overall Summary (always visible above tabs) ──
  if (verdict?.overall && summaryEl) {
    const ov = verdict.overall;
    const al = verdict.alignment;
    const gradeColors = {
      A: "var(--up)",
      B: "#4ade80",
      C: "var(--am)",
      D: "#f97316",
      F: "var(--dn)",
    };
    const gc = gradeColors[ov.grade] || "var(--gray400)";
    const short = verdict.perTimeframe.shortTerm;
    const mid = verdict.perTimeframe.midTerm;
    const long = verdict.perTimeframe.longTerm;
    const mkMini = (label, tf) => {
      if (!tf) return "";
      const c =
        tf.score >= 60
          ? "var(--up)"
          : tf.score <= 40
          ? "var(--dn)"
          : "var(--am)";
      return `<div style="text-align:center;flex:1">
  <div style="font-size:11px;color:var(--gray400);margin-bottom:4px">${label}</div>
  <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:${c}">${tf.score}</div>
  <div style="font-size:11px;font-weight:600;color:${c}">${tf.grade}</div>
</div>`;
    };
    summaryEl.innerHTML = `<div style="display:flex;align-items:center;gap:20px;padding:20px;border-radius:12px;background:linear-gradient(135deg,var(--gray50),#fff);border:2px solid ${gc}20">
<div style="flex-shrink:0;width:72px;height:72px;border-radius:50%;background:${gc}15;display:flex;align-items:center;justify-content:center;border:3px solid ${gc}">
  <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:32px;font-weight:900;color:${gc}">${
      ov.grade
    }</span>
</div>
<div style="flex:1;min-width:0">
  <div style="font-size:18px;font-weight:800;color:var(--gray900);margin-bottom:4px">${
    ov.label
  }</div>
  <div style="font-size:13px;color:var(--gray500);margin-bottom:8px">Điểm tổng hợp: <b style="color:${gc}">${
      ov.score
    }/100</b> · ${al.label}</div>
  <div style="font-size:12px;color:var(--gray500);line-height:1.6">${
    al.desc
  }</div>
  ${(() => {
    if (ov.grade !== "A" && ov.grade !== "B") return "";
    const bb = analysisData?.predictions?.bestBuy;
    const curPrice = analysisData?.latestPrice;
    const bbLower = analysisData?.indicators?.bbLower;
    const s1 = analysisData?.supportResistance?.supports?.[0]?.price;
    if (!bb && !s1) return "";
    const buyP = bb?.price ?? s1;
    const lo = bbLower && bbLower < buyP ? bbLower : null;
    const fmt = (v) => (v >= 1000 ? v.toLocaleString("vi-VN") : v);
    const diffPct = curPrice
      ? (((buyP - curPrice) / curPrice) * 100).toFixed(1)
      : null;
    const diffLabel = diffPct
      ? diffPct > 0
        ? `+${diffPct}%`
        : `${diffPct}%`
      : "";
    let rangeHtml = lo
      ? `<span style="color:var(--up);font-weight:800">${fmt(lo)} – ${fmt(
          buyP
        )}</span>`
      : `<span style="color:var(--up);font-weight:800">${fmt(
          buyP
        )}</span>`;
    return `<div style="margin-top:8px;padding:8px 12px;border-radius:8px;background:var(--up)08;border:1px solid var(--up)20;display:flex;align-items:center;gap:6px">
      <span style="font-size:12px">💰</span>
      <span style="font-size:12px;color:var(--gray600)">Giá mua chấp nhận được:</span>
      <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px">${rangeHtml}</span>
      ${
        diffLabel
          ? `<span style="font-size:11px;color:var(--gray400)">(${diffLabel} so với giá hiện tại)</span>`
          : ""
      }
    </div>`;
  })()}
</div>
<div style="display:flex;gap:12px;flex-shrink:0;padding-left:16px;border-left:1px solid var(--gray100)">
  ${mkMini("Ngắn", short)}${mkMini("Trung", mid)}${mkMini("Dài", long)}
</div>
</div>`;
  }

  // ── Per-tab data ──
  const tfKey =
    currentPatternTab === "short"
      ? "shortTerm"
      : currentPatternTab === "mid"
      ? "midTerm"
      : "longTerm";
  const d = mtf[tfKey];
  if (!d) {
    el.innerHTML =
      '<div style="font-size:14px;color:var(--gray400);grid-column:1/-1">Không có dữ liệu</div>';
    verdictEl.innerHTML = "";
    return;
  }

  // ── Tab verdict box ──
  const tv = verdict?.perTimeframe?.[tfKey];
  if (tv && verdictEl) {
    const vc =
      tv.verdictColor === "up"
        ? "var(--up)"
        : tv.verdictColor === "dn"
        ? "var(--dn)"
        : "var(--am)";
    const riskColors = ["", "#22c55e", "#f59e0b", "#f97316", "#ef4444"];
    const rc = riskColors[tv.risk.level] || "var(--gray400)";
    // Confluence dots
    const catIcons = {
      candle: "🕯",
      ma: "📈",
      rsi: "📊",
      macd: "📉",
      bb: "📐",
      structure: "🏗",
      volume: "📦",
    };
    let confHtml = "";
    tv.confluence.details.forEach((c) => {
      const dc =
        c.dir === "bull"
          ? "var(--up)"
          : c.dir === "bear"
          ? "var(--dn)"
          : "var(--am)";
      confHtml += `<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:6px;background:${dc}12;border:1px solid ${dc}30;font-size:11px;font-weight:600;color:${dc}">
  <span>${catIcons[c.cat] || "•"}</span>${c.label}
</span>`;
    });
    let reasonsHtml = tv.reasons
      .map(
        (r) =>
          `<div style="font-size:12px;color:var(--gray600);line-height:1.5;padding-left:12px;border-left:2px solid ${vc}40">• ${r}</div>`
      )
      .join("");
    verdictEl.innerHTML = `<div style="padding:16px 20px;border-radius:12px;background:${vc}08;border:1px solid ${vc}25">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
  <div style="display:flex;align-items:center;gap:10px">
    <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:24px;font-weight:900;color:${vc}">${
      tv.grade
    }</span>
    <div>
      <div style="font-size:14px;font-weight:700;color:${vc}">${
      tv.verdict
    }</div>
      <div style="font-size:12px;color:var(--gray400)">Score: ${
        tv.score
      }/100 · Bullish ${tv.bullCount} vs Bearish ${tv.bearCount}</div>
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <span style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;background:${rc}15;color:${rc};border:1px solid ${rc}30">Rủi ro: ${
      tv.risk.label
    }</span>
    <span style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;background:var(--navy)10;color:var(--navy);border:1px solid var(--navy)20">${
      tv.confluence.label
    }</span>
  </div>
</div>
${
  confHtml
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${confHtml}</div>`
    : ""
}
${
  reasonsHtml
    ? `<div style="display:flex;flex-direction:column;gap:6px">${reasonsHtml}</div>`
    : ""
}
</div>`;
  } else if (verdictEl) {
    verdictEl.innerHTML = "";
  }

  // ── Pattern lists ──
  const catIcons = {
    candle: "🕯",
    ma: "📈",
    rsi: "📊",
    macd: "📉",
    bb: "📐",
    structure: "🏗",
    volume: "📦",
  };
  const catLabels = {
    candle: "Nến",
    ma: "MA",
    rsi: "RSI",
    macd: "MACD",
    bb: "BB",
    structure: "Cấu trúc",
    volume: "KL",
  };

  const renderList = (items, type) => {
    const color = type === "bull" ? "var(--up)" : "var(--dn)";
    const bg = type === "bull" ? "var(--up-bg)" : "var(--dn-bg)";
    const bd = type === "bull" ? "var(--up-bd)" : "var(--dn-bd)";
    const icon = type === "bull" ? "🐂" : "🐻";
    const title = type === "bull" ? "BULLISH (Tăng)" : "BEARISH (Giảm)";

    let h = `<div>
<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
  <span style="font-size:20px">${icon}</span>
  <div>
    <div style="font-size:14px;font-weight:700;color:${color}">${title}</div>
    <div style="font-size:12px;color:var(--gray400)">${items.length} tín hiệu · ${d.label}</div>
  </div>
</div>`;

    if (items.length === 0) {
      h += `<div style="padding:20px;text-align:center;background:var(--gray50);border-radius:10px;color:var(--gray400);font-size:14px">Không phát hiện tín hiệu</div>`;
    } else {
      items.forEach((p) => {
        const barW = Math.min(p.strength, 100);
        const barColor =
          p.strength >= 80
            ? color
            : p.strength >= 65
            ? "var(--am)"
            : "var(--gray400)";
        const catIcon = catIcons[p.cat] || "•";
        const catLabel = catLabels[p.cat] || "";
        h += `<div style="padding:14px 16px;margin-bottom:8px;border-radius:10px;background:${bg};border:1px solid ${bd}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="padding:2px 6px;border-radius:4px;background:var(--gray100);font-size:11px" title="${catLabel}">${catIcon}</span>
        <span style="font-size:14px;font-weight:700;color:${color}">${p.name}</span>
      </div>
      <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:${barColor}">${p.strength}%</span>
    </div>
    <div style="font-size:13px;color:var(--gray700);line-height:1.5;margin-bottom:8px">${p.desc}</div>
    <div style="height:4px;border-radius:2px;background:rgba(0,0,0,.06)"><div style="height:100%;width:${barW}%;background:${barColor};border-radius:2px"></div></div>
  </div>`;
      });
    }
    h += "</div>";
    return h;
  };

  el.innerHTML =
    renderList(d.bullish, "bull") + renderList(d.bearish, "bear");
}

function renderTrend(t) {
  const el = document.getElementById("trendContent");
  const r = (
    f
  ) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--gray100)">
<div><div style="font-size:15px;font-weight:600;color:var(--gray900)">${
f.label
}</div><div style="font-size:13px;color:var(--gray500);margin-top:3px">${
    f.signal
  }</div></div>
<div style="display:flex;align-items:center;gap:8px"><span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:15px;color:${
f.pctChange > 0
  ? "var(--up)"
  : f.pctChange < 0
  ? "var(--dn)"
  : "var(--am)"
}">${f.pctChange > 0 ? "+" : ""}${f.pctChange}%</span>
<span class="badge ${bc(f.direction)}">${ta(f.direction)}</span></div></div>`;
  el.innerHTML = r(t.shortTerm) + r(t.midTerm) + r(t.longTerm);
  const a = document.getElementById("alignmentBadge"),
    u = t.alignment.includes("UP"),
    dn = t.alignment.includes("DOWN");
  a.style.background = u
    ? "var(--up-bg)"
    : dn
    ? "var(--dn-bg)"
    : "var(--am-bg)";
  a.style.border = `2px solid ${
    u ? "var(--up-bd)" : dn ? "var(--dn-bd)" : "var(--am-bd)"
  }`;
  a.style.color = u ? "var(--up)" : dn ? "var(--dn)" : "var(--am)";
  a.textContent = t.alignmentDesc;
}

function renderTrendPro(t) {
  const el = document.getElementById("trendProContent");
  if (!el) return;
  if (!t || t.error) { el.innerHTML = ""; return; }

  const { shortTerm: st, midTerm: mt, ftd, summary } = t;

  // Score bar helper
  const scorePct = (s) => Math.round(Math.min(100, Math.max(0, s)));
  const scoreColor = (s) =>
    s >= 70 ? "var(--up)" : s >= 50 ? "var(--am)" : "var(--dn)";
  const scoreBar = (label, s, div) => {
    const pct = scorePct(s);
    const clr = scoreColor(s);
    const divHtml = div
      ? `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:6px;background:${div.type === "BULLISH" ? "var(--up-bg)" : "var(--dn-bg)"};color:${div.type === "BULLISH" ? "var(--up)" : "var(--dn)"};border:1px solid ${div.type === "BULLISH" ? "var(--up-bd)" : "var(--dn-bd)"}">⚡ ${div.desc}</span>`
      : "";
    return `<div style="margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:13px;color:var(--gray500);font-weight:600">${label}${divHtml}</span>
        <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${clr}">${s}/100</span>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--gray100);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${clr};border-radius:3px;transition:width 0.5s ease"></div>
      </div>
    </div>`;
  };

  // Action badge
  const stateColors = {
    "FTD Confirmed":   { bg: "var(--up-bg)",  bd: "var(--up-bd)",  tx: "var(--up)" },
    "Strong Bullish":  { bg: "var(--up-bg)",  bd: "var(--up-bd)",  tx: "var(--up)" },
    "Bullish":         { bg: "var(--up-bg)",  bd: "var(--up-bd)",  tx: "var(--up)" },
    "Mild Bullish":    { bg: "var(--navy-l)", bd: "rgba(0,58,107,.2)", tx: "var(--navy)" },
    "Mild Bearish":    { bg: "var(--am-bg)",  bd: "var(--am-bd)",  tx: "var(--am)" },
    "Bearish":         { bg: "var(--dn-bg)",  bd: "var(--dn-bd)",  tx: "var(--dn)" },
    "Strong Bearish":  { bg: "var(--dn-bg)",  bd: "var(--dn-bd)",  tx: "var(--dn)" },
    "Sideways":        { bg: "var(--am-bg)",  bd: "var(--am-bd)",  tx: "var(--am)" },
  };
  const sc = stateColors[summary.marketState] || stateColors["Sideways"];

  // FTD block
  const ftdHtml = ftd.isFTD
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;background:var(--up-bg);border:1px solid var(--up-bd);margin-bottom:10px">
        <span style="font-size:16px">🚀</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--up)">Follow-Through Day xác nhận</div>
          <div style="font-size:11px;color:var(--gray500);margin-top:1px">Ngày ${ftd.daysSinceBottom} kể từ đáy · Giá +${ftd.priceChange}% · Vol ${ftd.relVol}x TB</div>
        </div>
      </div>`
    : `<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:8px;background:var(--gray50);border:1px solid var(--gray100);margin-bottom:10px">
        <span style="font-size:13px;color:var(--gray400)">FTD: Chưa kích hoạt</span>
        <span style="font-size:11px;color:var(--gray400)">· ${ftd.daysSinceBottom} ngày từ đáy gần nhất</span>
      </div>`;

  el.innerHTML = `<div style="border-top:2px solid var(--gray100);padding-top:14px">
    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--gray400);margin-bottom:10px">Trend Pro · IBD/FTD Analysis</div>
    ${scoreBar("Ngắn hạn (30 phiên)", st.score, st.divergence)}
    ${scoreBar("Trung hạn (60 phiên)", mt.score, mt.divergence)}
    ${ftdHtml}
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:10px;background:${sc.bg};border:1px solid ${sc.bd};cursor:help"
      data-tooltip="${buildTrendProTooltip(summary.action, analysisData)}">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;font-weight:700;color:${sc.tx};letter-spacing:.3px">${summary.action}</span>
          <span style="font-size:11px;opacity:.5;color:${sc.tx}">ⓘ</span>
        </div>
        <div style="font-size:11px;color:var(--gray500);margin-top:2px">${summary.warning !== "Ổn định" ? "⚠ " + summary.warning : "✓ " + summary.warning}</div>
      </div>
    </div>
  </div>`;
}

function renderIndicators(ind) {
  const el = document.getElementById("indicatorsContent");
  const price = analysisData?.latestPrice;
  if (!ind || !price) return;

  // ── 1. ĐƯỜNG TRUNG BÌNH ──────────────────────────────────────────────────
  const mas = [
    { label: "MA 5",   val: ind.ma5 },
    { label: "MA 20",  val: ind.ma20 },
    { label: "MA 50",  val: ind.ma50 },
    { label: "MA 200", val: ind.ma200 },
  ];
  const aboveCount = mas.filter(m => m.val != null && price > m.val).length;
  const validMAs   = mas.filter(m => m.val != null).length;
  const maSig = aboveCount === validMAs ? { txt: `Giá trên cả ${validMAs} MA — xu hướng tăng`, c: "var(--up)", bg: "var(--up-bg)" }
    : aboveCount === 0 ? { txt: `Giá dưới cả ${validMAs} MA — xu hướng giảm`, c: "var(--dn)", bg: "var(--dn-bg)" }
    : { txt: `Giá trên ${aboveCount}/${validMAs} MA — xu hướng hỗn hợp`, c: "var(--am)", bg: "var(--am-bg)" };

  const maGrid = mas.map(m => {
    if (m.val == null) return `<div></div>`;
    const diff = ((price - m.val) / m.val * 100);
    const above = price > m.val;
    const c = above ? "var(--up)" : price < m.val ? "var(--dn)" : "var(--gray500)";
    return `<div style="text-align:center;padding:10px 6px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:10px;font-weight:700;color:var(--gray400);margin-bottom:4px">${m.label}</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:var(--gray900)">${fp(m.val)}</div>
<div style="font-size:11px;font-weight:600;margin-top:3px;color:${c}">${above ? "▲" : "▼"} ${Math.abs(diff).toFixed(1)}%</div>
</div>`;
  }).join("");

  // ── 2. RSI ────────────────────────────────────────────────────────────────
  const rsi = ind.rsi;
  const rsiPct = Math.round(Math.min(100, Math.max(0, rsi)));
  const rsiC = rsi > 70 ? "var(--dn)" : rsi < 30 ? "var(--up)" : rsi > 50 ? "var(--navy)" : "var(--gray600)";
  const rsiZone = rsi > 70 ? "Quá mua — cẩn thận điều chỉnh"
    : rsi > 60 ? "Mạnh — còn room nhưng chú ý"
    : rsi > 50 ? "Trên trung tính — xu hướng tăng nhẹ"
    : rsi > 40 ? "Dưới trung tính — xu hướng yếu"
    : rsi > 30 ? "Yếu — gần vùng quá bán"
    : "Quá bán — có thể phản hồi kỹ thuật";

  // ── 3. MACD ───────────────────────────────────────────────────────────────
  const hist = ind.macdHistogram;
  const macdAboveZero = ind.macd > 0;
  const histPositive = hist > 0;
  let macdSig, macdSigC;
  if (macdAboveZero && histPositive)      { macdSig = "Động lực tăng mạnh"; macdSigC = "var(--up)"; }
  else if (!macdAboveZero && histPositive) { macdSig = "MACD cắt lên tín hiệu — phục hồi"; macdSigC = "var(--up)"; }
  else if (macdAboveZero && !histPositive) { macdSig = "Đang suy yếu — cắt xuống tín hiệu"; macdSigC = "var(--am)"; }
  else                                     { macdSig = "Động lực giảm tiếp tục"; macdSigC = "var(--dn)"; }

  // ── 4. BOLLINGER BANDS ───────────────────────────────────────────────────
  const bbPct = ind.bbUpper !== ind.bbLower
    ? Math.round((price - ind.bbLower) / (ind.bbUpper - ind.bbLower) * 100)
    : 50;
  const bbWidth = ind.bbMid > 0
    ? ((ind.bbUpper - ind.bbLower) / ind.bbMid * 100).toFixed(1)
    : null;
  const bbPos = bbPct > 80 ? { txt: "Gần dải trên — cẩn thận đảo chiều", c: "var(--dn)" }
    : bbPct < 20 ? { txt: "Gần dải dưới — có thể phản hồi", c: "var(--up)" }
    : { txt: `Trong dải (${bbPct}% từ đáy)`, c: "var(--gray600)" };
  const squeeze = bbWidth != null && parseFloat(bbWidth) < 6;

  let h = ``;

  // ─ Block MA ─
  h += `<div style="margin-bottom:12px">
<div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.8px;margin-bottom:8px">ĐƯỜNG TRUNG BÌNH</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">${maGrid}</div>
<div style="padding:7px 12px;border-radius:8px;background:${maSig.bg};font-size:12px;font-weight:600;color:${maSig.c}">${maSig.txt}</div>
</div>`;

  // ─ Block RSI + MACD ─
  h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">`;

  // RSI
  h += `<div style="padding:12px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.8px;margin-bottom:8px">RSI (14)</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:22px;color:${rsiC};margin-bottom:6px">${rsi != null ? rsi.toFixed(1) : "—"}</div>
<div style="position:relative;height:6px;border-radius:3px;background:var(--gray200);margin-bottom:6px;overflow:visible">
  <div style="position:absolute;left:30%;width:1px;height:100%;background:var(--gray400);opacity:.4"></div>
  <div style="position:absolute;left:70%;width:1px;height:100%;background:var(--gray400);opacity:.4"></div>
  <div style="height:100%;width:${rsiPct}%;background:${rsiC};border-radius:3px;transition:width .5s"></div>
</div>
<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--gray400);margin-bottom:6px"><span>0</span><span>30</span><span>70</span><span>100</span></div>
<div style="font-size:11px;color:${rsiC};font-weight:600">${rsiZone}</div>
</div>`;

  // MACD
  h += `<div style="padding:12px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.8px;margin-bottom:8px">MACD</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:22px;color:${ind.macd > 0 ? "var(--up)" : "var(--dn)"};margin-bottom:6px">${ind.macd != null ? ind.macd.toFixed(2) : "—"}</div>
<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px">
  <div style="display:flex;justify-content:space-between;font-size:11px">
    <span style="color:var(--gray500)">Histogram</span>
    <span style="font-weight:700;color:${histPositive ? "var(--up)" : "var(--dn)"}">${histPositive ? "▲" : "▼"} ${hist != null ? Math.abs(hist).toFixed(3) : "—"}</span>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:11px">
    <span style="color:var(--gray500)">Signal</span>
    <span style="font-weight:600;color:var(--gray700)">${ind.macdSignal != null ? ind.macdSignal.toFixed(2) : "—"}</span>
  </div>
</div>
<div style="font-size:11px;font-weight:600;color:${macdSigC}">${macdSig}</div>
</div>`;

  h += `</div>`;

  // ─ Block BB ─
  const bbBarPos = Math.min(96, Math.max(4, bbPct));
  h += `<div style="padding:12px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
  <div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.8px">BOLLINGER BANDS</div>
  ${squeeze ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:var(--am-bg);color:var(--am);border:1px solid var(--am-bd)">⚡ SQUEEZE</span>` : bbWidth != null ? `<span style="font-size:11px;color:var(--gray500)">Độ rộng ${bbWidth}%</span>` : ""}
</div>
<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--gray500);margin-bottom:4px">
  <span>${fp(ind.bbLower)}</span><span style="color:var(--gray400)">mid ${fp(ind.bbMid)}</span><span>${fp(ind.bbUpper)}</span>
</div>
<div style="position:relative;height:8px;border-radius:4px;background:linear-gradient(to right,var(--up-bg),var(--gray100),var(--dn-bg));border:1px solid var(--gray200);margin-bottom:4px">
  <div style="position:absolute;left:50%;transform:translateX(-50%);top:50%;height:60%;width:1px;background:var(--gray400);opacity:.5"></div>
  <div style="position:absolute;left:${bbBarPos}%;transform:translateX(-50%);top:-3px;width:14px;height:14px;border-radius:50%;background:var(--navy);border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div>
</div>
<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--gray400);margin-bottom:8px"><span>Dải dưới</span><span>Giữa</span><span>Dải trên</span></div>
<div style="font-size:11px;font-weight:600;color:${bbPos.c}">${bbPos.txt}${squeeze ? " · Sắp có biến động lớn" : ""}</div>
${ind.atrPct != null ? `<div style="margin-top:6px;font-size:11px;color:var(--gray500)">ATR: <b style="color:var(--am)">${ind.atr}</b> · biên độ ngày ~<b style="color:var(--am)">${ind.atrPct}%</b></div>` : ""}
</div>`;

  el.innerHTML = h;
}

function renderVolume(vol) {
  const el = document.getElementById("volumeContent");
  if (!vol) return;

  const ratio = vol.ratio;
  const rc = ratio >= 2 ? "var(--dn)" : ratio >= 1.5 ? "var(--am)" : ratio >= 1 ? "var(--up)" : "var(--gray500)";
  const bar = Math.min((ratio / 3) * 100, 100);

  const volSig = ratio >= 2 && vol.isSurge ? "Đột biến khối lượng — xác nhận tín hiệu mạnh"
    : ratio >= 1.5 ? "Khối lượng cao — thị trường quan tâm"
    : ratio >= 0.8 ? "Khối lượng bình thường"
    : "Khối lượng thấp — thiếu xác nhận";

  el.innerHTML = `<div style="padding:12px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200);margin-top:12px">
<div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.8px;margin-bottom:10px">KHỐI LƯỢNG</div>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
  <div>
    <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:22px;color:${rc}">${ratio}x</span>
    <span style="font-size:12px;color:var(--gray500);margin-left:4px">TB 20</span>
    ${vol.isSurge ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--dn-bg);color:var(--dn);border:1px solid var(--dn-bd);margin-left:6px">ĐỘT BIẾN</span>` : ""}
  </div>
</div>
<div style="height:6px;border-radius:3px;background:var(--gray200);margin-bottom:10px;overflow:hidden">
  <div style="height:100%;width:${bar}%;background:${rc};border-radius:3px;transition:width .5s"></div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center;margin-bottom:8px">
  <div style="padding:7px;border-radius:8px;background:var(--gray100)">
    <div style="font-size:9px;color:var(--gray400);font-weight:600;margin-bottom:2px">PHIÊN CUỐI</div>
    <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:12px">${fv(vol.latest)}</div>
  </div>
  <div style="padding:7px;border-radius:8px;background:var(--gray100)">
    <div style="font-size:9px;color:var(--gray400);font-weight:600;margin-bottom:2px">TB 20</div>
    <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:12px">${fv(vol.ma20)}</div>
  </div>
  <div style="padding:7px;border-radius:8px;background:var(--gray100)">
    <div style="font-size:9px;color:var(--gray400);font-weight:600;margin-bottom:2px">TB 50</div>
    <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:12px">${fv(vol.ma50)}</div>
  </div>
</div>
<div style="font-size:11px;font-weight:600;color:${rc}">${volSig}</div>
</div>`;
}

function renderPredictions(pred) {
  const el = document.getElementById("predictionsContent");

  // ── Formatters ─────────────────────────────────────────────────────
  const fvMoney = (v) => {
    if (!v) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + " tỷ";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + " tr";
    return v.toLocaleString("vi-VN") + "đ";
  };
  const fLots = (v) => (v ? Number(v).toLocaleString("vi-VN") + " CP" : "—");
  const fVolK = (v) => {
    if (!v) return "—";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return Math.round(v / 1e3) + "K";
    return String(v);
  };
  const dChip = (de) => {
    if (!de) return '<span style="color:var(--gray300)">—</span>';
    if (de.immediate) return `<span style="font-size:12px;font-weight:700;color:var(--up)">Vào ngay</span>`;
    return `<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:var(--navy)">~${de.days}p</span><br><span style="font-size:11px;color:var(--gray400)">${de.minDays}–${de.maxDays}</span>`;
  };

  // ── Grade colors ───────────────────────────────────────────────────
  const gradeColor = (g) => g === "A+" ? "var(--up)" : g === "A" ? "#22c55e" : g === "B" ? "var(--navy)" : g === "C" ? "var(--am)" : "var(--dn)";
  const gradeBg    = (g) => g === "A+" ? "var(--up-bg)" : g === "A" ? "#f0fdf4" : g === "B" ? "var(--navy-l)" : g === "C" ? "var(--am-bg)" : "var(--dn-bg)";
  const gradeBd    = (g) => g === "A+" ? "var(--up-bd)" : g === "A" ? "#bbf7d0" : g === "B" ? "rgba(0,58,107,.2)" : g === "C" ? "var(--am-bd)" : "var(--dn-bd)";

  if (!pred.bestBuy && !pred.checklist) {
    el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--gray400)">Không đủ dữ liệu</div>`;
    return;
  }

  const b  = pred.bestBuy || {};
  const sv = b.sellStrategy;
  const ss = b.splitStrategy;

  // ════════════════════════════════════════════════════════════════════
  // SECTION 1 — Signal Header (Setup Grade + Market Phase + Trigger)
  // ════════════════════════════════════════════════════════════════════
  const grade      = pred.setupGrade || b.setupGrade || "—";
  const gradeC     = gradeColor(grade);
  const gradeBgC   = gradeBg(grade);
  const gradeBdC   = gradeBd(grade);
  const chkPct     = pred.checklistPct ?? 0;
  const trigger    = pred.entryTrigger || b.entryTrigger;
  const mPhaseLabel= pred.marketPhaseLabel || b.marketPhaseLabel || "—";
  const mPhaseC    = pred.marketPhaseColor || b.marketPhaseColor || "var(--gray500)";
  const vPhaseLabel= pred.volumePhaseLabel || b.volumePhaseLabel || "—";
  const adRatio    = pred.adRatio ?? b.adRatio ?? 0.5;

  // Checklist bar segments
  const checklist  = pred.checklist || b.checklist || [];
  const chkMet     = pred.checklistMet ?? 0;
  const chkTotal   = pred.checklistTotal ?? 1;

  let headerHtml = `
<div style="display:grid;grid-template-columns:auto 1fr auto;gap:20px;align-items:center;padding:20px 24px;border-radius:14px;background:${gradeBgC};border:2px solid ${gradeBdC};margin-bottom:20px">
  <!-- Grade circle -->
  <div style="width:72px;height:72px;border-radius:50%;background:${gradeC};display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 16px ${gradeC}40">
<span style="font-family:'Syne',sans-serif;font-weight:800;font-size:28px;color:#fff">${grade}</span>
  </div>
  <!-- Center info -->
  <div>
<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
<span style="font-size:17px;font-weight:800;color:var(--gray900)">Setup ${grade} — ${chkPct}% điều kiện đạt</span>
${trigger ? `<span style="padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${trigger.color}">${trigger.label}</span>` : ""}
</div>
<!-- Progress bar -->
<div style="height:8px;border-radius:4px;background:rgba(0,0,0,.08);margin-bottom:8px;overflow:hidden">
<div style="height:100%;width:${chkPct}%;background:${gradeC};border-radius:4px;transition:width .5s"></div>
</div>
<div style="display:flex;gap:16px;flex-wrap:wrap">
<span style="font-size:12px;color:${mPhaseC};font-weight:600">${mPhaseLabel}</span>
<span style="font-size:12px;color:${adRatio > 0.55 ? "var(--up)" : adRatio < 0.45 ? "var(--dn)" : "var(--gray500)"};font-weight:600">● ${vPhaseLabel} (${(adRatio * 100).toFixed(0)}%)</span>
${trigger ? `<span style="font-size:12px;color:var(--gray500)">${trigger.desc}</span>` : ""}
</div>
  </div>
  <!-- Confidence score -->
  ${b.confidenceScore != null ? `
  <div style="text-align:center;flex-shrink:0;padding-left:16px;border-left:1px solid ${gradeBdC}">
<div style="font-size:11px;color:var(--gray400);margin-bottom:4px;font-weight:600;letter-spacing:.5px">TIN CẬY</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:28px;font-weight:800;color:${gradeC};line-height:1">${b.confidenceScore}</div>
<div style="font-size:11px;color:var(--gray400)">/100</div>
  </div>` : ""}
</div>`;

  // ════════════════════════════════════════════════════════════════════
  // SECTION 2 — Pre-entry Checklist
  // ════════════════════════════════════════════════════════════════════
  let checklistHtml = "";
  if (checklist.length > 0) {
    checklistHtml = `
<div style="margin-bottom:20px">
  <div style="font-size:12px;font-weight:700;color:var(--gray500);letter-spacing:.8px;text-transform:uppercase;margin-bottom:12px">⚡ Điều kiện vào lệnh — ${chkMet}/${chkTotal} điểm đạt</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;
    checklist.forEach(c => {
      const cc = c.met ? "var(--up)" : "var(--dn)";
      const cbg = c.met ? "var(--up-bg)" : "var(--dn-bg)";
      const cbd = c.met ? "var(--up-bd)" : "var(--dn-bd)";
      checklistHtml += `
<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;background:${cbg};border:1px solid ${cbd}">
<span style="font-size:16px;flex-shrink:0;margin-top:1px">${c.met ? "✅" : "❌"}</span>
<div>
  <div style="font-size:12px;font-weight:700;color:var(--gray900);margin-bottom:2px">${c.label}</div>
  <div style="font-size:11px;color:var(--gray500);line-height:1.4">${c.desc}</div>
</div>
</div>`;
    });
    checklistHtml += `</div></div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // SECTION 3 — Entry Zone (multi-factor) + Trade metrics (2 columns)
  // ════════════════════════════════════════════════════════════════════
  const ez = pred.entryZone || b.entryZone;
  const curPrice = analysisData?.latestPrice;

  let entryZoneHtml = "";
  if (ez) {
    const distSign = ez.distFromCurrent > 0 ? "+" : "";
    entryZoneHtml = `
<div style="padding:16px 18px;border-radius:12px;background:var(--navy-l);border:1.5px solid rgba(0,58,107,.2);margin-bottom:16px">
  <div style="font-size:11px;font-weight:700;color:var(--navy);letter-spacing:.8px;margin-bottom:12px">🎯 VÙNG MUA TỐI ƯU (Multi-factor)</div>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap">
<div>
<div style="font-size:11px;color:var(--gray400);margin-bottom:3px">Giá tối ưu</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:28px;color:var(--navy);line-height:1">${fp(ez.optimal)}</div>
<div style="font-size:12px;color:${ez.distFromCurrent > 0 ? "var(--up)" : "var(--navy)"};margin-top:3px">${distSign}${ez.distFromCurrent}% so với giá hiện tại</div>
</div>
<div style="height:48px;width:1px;background:rgba(0,58,107,.15)"></div>
<div>
<div style="font-size:11px;color:var(--gray400);margin-bottom:3px">Vùng chấp nhận</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;color:var(--navy)">${fp(ez.floor)} – ${fp(ez.ceiling)}</div>
</div>
<div style="height:48px;width:1px;background:rgba(0,58,107,.15)"></div>
<div style="flex:1">
<div style="font-size:11px;color:var(--gray400);margin-bottom:6px">Confluence factors</div>
<div style="display:flex;flex-wrap:wrap;gap:6px">
  ${ez.factors.map(f => `<span style="padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;background:rgba(0,58,107,.1);color:var(--navy);border:1px solid rgba(0,58,107,.15)">${f.label} · ${fp(f.price)}</span>`).join("")}
</div>
</div>
  </div>
</div>`;
  }

  // ── Main buy price + SL + metrics ──────────────────────────────────
  let buyMetricsHtml = "";
  if (pred.bestBuy) {
    const qualC = gradeColor(b.quality || "B");
    buyMetricsHtml = `
<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
  <span style="font-size:11px;font-weight:700;color:var(--up);letter-spacing:.8px">📥 GIÁ VÀO LỆNH (từ S1)</span>
  ${b.quality ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:${gradeBg(b.quality)};color:${qualC};border:1px solid ${gradeBd(b.quality)}">${b.quality}</span>` : ""}
</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:38px;color:var(--navy);line-height:1;margin-bottom:4px">${fp(b.price)}</div>
<div style="font-size:13px;color:var(--gray500);margin-bottom:16px;line-height:1.5">${b.reason || ""}</div>

<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
  <div style="padding:10px 12px;border-radius:10px;background:var(--dn-bg);border:1px solid var(--dn-bd)">
<div style="font-size:10px;font-weight:700;color:var(--dn);letter-spacing:.6px;margin-bottom:4px">STOPLOSS</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:18px;color:var(--dn)">${fp(b.stoploss)}</div>
<div style="font-size:11px;color:var(--gray500);margin-top:3px">${b.stoplossPct}% · ${b.stoplossMethod || "ATR×1.5"}</div>
  </div>
  <div style="padding:10px 12px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:4px">RỦI RO/CP</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:18px;color:var(--gray900)">${fp(b.riskPerShare)}</div>
<div style="font-size:11px;color:var(--gray500);margin-top:3px">Biến động ${b.volatility}%/ngày</div>
  </div>
  <div style="padding:10px 12px;border-radius:10px;background:var(--ind-bg);border:1px solid rgba(99,102,241,.2)">
<div style="font-size:10px;font-weight:700;color:var(--ind);letter-spacing:.6px;margin-bottom:4px">ATR(14)</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:18px;color:var(--ind)">${b.atrPct ?? "—"}%</div>
<div style="font-size:11px;color:var(--gray500);margin-top:3px">Biến động bình quân</div>
  </div>
</div>`;

    // Confidence breakdown
    if (b.confidenceDetails) {
      const cd = b.confidenceDetails;
      buyMetricsHtml += `
<div style="padding:12px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200);margin-bottom:16px">
  <div style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.6px;margin-bottom:10px">PHÂN TÍCH ĐỘ TIN CẬY</div>
  ${Object.entries(cd).map(([k, v]) => {
const labels = { trend: "Xu hướng", rsi: "RSI", support: "Hỗ trợ", riskReward: "R:R" };
const pct = Math.round((v.score / v.max) * 100);
const bc = pct >= 70 ? "var(--up)" : pct >= 40 ? "var(--am)" : "var(--dn)";
return `<div style="margin-bottom:8px">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
  <span style="font-size:12px;font-weight:600;color:var(--gray700)">${labels[k] || k}</span>
  <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:${bc}">${v.score}/${v.max} · ${v.reason}</span>
</div>
<div style="height:4px;border-radius:2px;background:var(--gray100)"><div style="height:100%;width:${pct}%;background:${bc};border-radius:2px"></div></div>
</div>`;
  }).join("")}
</div>`;
    }
  }

  // ── Split strategy table ──────────────────────────────────────────
  let splitHtml = "";
  if (ss) {
    const lc = ss.liquidityLevel === "high" ? "var(--up)" : ss.liquidityLevel === "medium" ? "var(--navy)" : ss.liquidityLevel === "low" ? "var(--am)" : "var(--dn)";
    splitHtml = `
<div style="border-top:2px solid var(--gray100);padding-top:16px;margin-top:4px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
<span style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.6px">KẾ HOẠCH VÀO LỆNH</span>
<div style="display:flex;align-items:center;gap:8px">
<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:var(--navy)">${fvMoney(ss.budget)}</span>
<span style="font-size:12px;font-weight:700;color:${lc}">● ${ss.liquidityLabel || ""}</span>
<span style="font-size:11px;color:var(--gray400)">TB20: ${fVolK(ss.avgVol20)} CP</span>
</div>
  </div>
  ${ss.liquidityWarning ? `<div style="font-size:12px;color:var(--am);font-weight:600;padding:8px 12px;background:var(--am-bg);border-radius:8px;margin-bottom:10px;border:1px solid var(--am-bd)">${ss.liquidityWarning}</div>` : ""}
  <div style="font-size:11px;color:var(--gray400);margin-bottom:10px">${ss.desc}</div>
  <div style="display:grid;grid-template-columns:90px 70px 1fr 100px 68px;font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.5px;padding:7px 0;border-top:1px solid var(--gray200);border-bottom:2px solid var(--gray200)">
<span>LỆNH</span><span>GIÁ</span><span>GHI CHÚ</span><span style="text-align:right">SỐ CP</span><span style="text-align:right">DỰ KIẾN</span>
  </div>`;
    ss.orders.forEach(o => {
      const isDummy = o.action === "Dự phòng";
      const clr = o.action === "Mua" ? "var(--up)" : o.action === "Mua thêm" ? "var(--navy)" : "var(--gray400)";
      const note = o.note.replace(/^Lệnh \d+:\s*/, "");
      splitHtml += `
  <div style="display:grid;grid-template-columns:90px 70px 1fr 100px 68px;padding:10px 0;border-bottom:1px solid var(--gray100);align-items:center">
<div><div style="font-size:13px;font-weight:700;color:${clr}">${isDummy ? "Dự phòng" : o.action}</div><div style="font-size:11px;color:var(--gray400)">${o.pct}%</div></div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:13px">${o.price ? fp(o.price) : "—"}</div>
<div style="font-size:12px;color:var(--gray500);padding-right:6px;line-height:1.4">${note}</div>
<div style="text-align:right">${!isDummy && o.lots ? `<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${clr}">${fLots(o.lots)}</div><div style="font-size:11px;color:var(--gray400)">${fvMoney(o.amount)}</div>` : isDummy && o.amount ? `<div style="font-size:12px;color:var(--gray400)">${fvMoney(o.amount)}</div>` : "—"}</div>
<div style="text-align:right">${dChip(o.daysEstimate)}</div>
  </div>`;
    });
    const actOrders = ss.orders.filter(o => o.lots > 0);
    const totLots = actOrders.reduce((s, o) => s + (o.lots || 0), 0);
    const totAmt  = actOrders.reduce((s, o) => s + (o.amount || 0), 0);
    if (totLots > 0) {
      splitHtml += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:10px 0 0;border-top:2px solid var(--gray200)">
<span style="font-size:12px;color:var(--gray500)">Tổng mua</span>
<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:var(--navy)">${fLots(totLots)}</span>
<span style="color:var(--gray200)">·</span>
<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:var(--navy)">${fvMoney(totAmt)}</span>
  </div>`;
    }
    splitHtml += `</div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // RIGHT COLUMN — Exit Strategy + Scenarios + Fib
  // ════════════════════════════════════════════════════════════════════

  // ── Sell strategy ──────────────────────────────────────────────────
  let exitHtml = `<div style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.8px;margin-bottom:12px">📤 CHIẾN LƯỢC THOÁT LỆNH</div>`;
  if (sv) {
    const isTrend = sv.tradeType === "TREND";
    exitHtml += `
<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
  <span style="padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${isTrend ? "var(--up)" : "#e8590c"}">${sv.tradeType}</span>
  <span style="font-size:12px;color:var(--gray500)">${sv.desc}</span>
</div>`;

    sv.targets.forEach((t, i) => {
      const tColors = ["var(--up)", "#22c55e", "#4ade80"];
      const tc = tColors[i] || "var(--up)";
      const pct = parseFloat(t.pct);
      exitHtml += `
<div style="display:flex;align-items:center;gap:0;margin-bottom:8px">
  <!-- Timeline dot -->
  <div style="display:flex;flex-direction:column;align-items:center;margin-right:12px;flex-shrink:0">
<div style="width:10px;height:10px;border-radius:50%;background:${tc};box-shadow:0 0 0 3px ${tc}25"></div>
${i < sv.targets.length - 1 ? `<div style="width:2px;height:28px;background:var(--gray200);margin-top:3px"></div>` : ""}
  </div>
  <div style="flex:1;padding:10px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
<span style="font-size:13px;font-weight:700;color:var(--gray900)">${t.name.replace(/ — .*/, "")}</span>
<div style="display:flex;align-items:center;gap:8px">
  <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:${tc}">${fp(t.price)}</span>
  <span style="font-size:12px;color:${tc};font-weight:600">+${pct}%</span>
  <span style="padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:var(--navy-l);color:var(--navy)">R:R ${t.rr}:1</span>
  <span style="font-size:12px;font-weight:700;color:var(--dn)">Bán ${t.sellPct}%</span>
</div>
</div>
<div style="font-size:11px;color:var(--gray400)">${t.note}</div>
  </div>
</div>`;
    });

    if (sv.trailingStop) {
      exitHtml += `
<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;background:var(--am-bg);border:1px solid var(--am-bd);margin-top:8px">
  <span style="font-size:16px">🔔</span>
  <div>
<span style="font-size:13px;font-weight:700;color:var(--am)">Trailing Stop ${sv.trailingStop.pct}%</span>
<span style="font-size:12px;color:var(--gray500);margin-left:8px">${sv.trailingStop.desc}</span>
  </div>
</div>`;
    }
  } else {
    exitHtml += `<div style="padding:20px 0;color:var(--gray400);font-size:13px">Không đủ dữ liệu</div>`;
  }

  // ── Invalidation level ────────────────────────────────────────────
  exitHtml += `<div style="margin-top:16px;padding:12px 16px;border-radius:10px;background:var(--dn-bg);border:1px solid var(--dn-bd)">
  <div style="font-size:11px;font-weight:700;color:var(--dn);letter-spacing:.6px;margin-bottom:6px">⛔ ĐIỂM VÔ HIỆU HOÁ SETUP</div>
  <div style="font-size:13px;color:var(--dn);font-weight:600">${pred.bestBuy ? `Giá đóng cửa dưới ${fp(b.stoploss)} với khối lượng cao → Cắt lỗ, setup hủy bỏ` : `Phá vỡ vùng hỗ trợ chính với volume tăng mạnh`}</div>
  <div style="font-size:11px;color:var(--gray500);margin-top:4px">Kỷ luật: Chấp nhận lỗ nhỏ để tránh lỗ lớn. Không trung bình giá khi đã cắt lỗ.</div>
</div>`;

  // ── Scenario Analysis ─────────────────────────────────────────────
  const scenarios = pred.scenarios || b.scenarios;
  let scenarioHtml = "";
  if (scenarios) {
    scenarioHtml = `
<div style="margin-top:16px">
  <div style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.8px;margin-bottom:12px">🔮 PHÂN TÍCH KỊCH BẢN</div>
  <div style="display:flex;flex-direction:column;gap:8px">`;
    const sData = [
      { key: "bull",  icon: "🟢", c: "var(--up)", bg: "var(--up-bg)", bd: "var(--up-bd)" },
      { key: "base",  icon: "🔵", c: "var(--navy)", bg: "var(--navy-l)", bd: "rgba(0,58,107,.2)" },
      { key: "bear",  icon: "🔴", c: "var(--dn)", bg: "var(--dn-bg)", bd: "var(--dn-bd)" },
    ];
    sData.forEach(({ key, icon, c, bg, bd }) => {
      const s = scenarios[key];
      if (!s) return;
      const pctNum = parseFloat(s.targetPct);
      const pctSign = pctNum >= 0 ? "+" : "";
      scenarioHtml += `
  <div style="padding:12px 14px;border-radius:10px;background:${bg};border:1px solid ${bd}">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
<div style="display:flex;align-items:center;gap:6px">
  <span style="font-size:14px">${icon}</span>
  <span style="font-size:13px;font-weight:700;color:${c}">${s.label}</span>
</div>
<div style="display:flex;align-items:center;gap:8px">
  <span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${c}">${fp(s.target)}</span>
  <span style="font-size:12px;font-weight:600;color:${c}">${pctSign}${s.targetPct}%</span>
  <span style="padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:rgba(0,0,0,.06);color:var(--gray600)">${s.probability}%</span>
</div>
</div>
<div style="font-size:11px;color:var(--gray500)">${s.trigger}</div>
  </div>`;
    });
    scenarioHtml += `</div></div>`;
  }

  // ── Fibonacci levels (compact) ─────────────────────────────────────
  const fibs = pred.fibLevels || b.fibLevels;
  let fibHtml = "";
  if (fibs) {
    const fibData = [
      { label: "Fib 23.6%", val: fibs.fib236, key: "fib236" },
      { label: "Fib 38.2%", val: fibs.fib382, key: "fib382" },
      { label: "Fib 50.0%", val: fibs.fib500, key: "fib500" },
      { label: "Fib 61.8%", val: fibs.fib618, key: "fib618" },
      { label: "Fib 78.6%", val: fibs.fib786, key: "fib786" },
    ];
    const priceRef = curPrice || b.price;
    fibHtml = `
<div style="margin-top:16px">
  <div style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.8px;margin-bottom:10px">📐 FIBONACCI RETRACEMENT (${fibs.swingLow} → ${fibs.swingHigh})</div>
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px">
${fibData.map(f => {
const isNear = priceRef && Math.abs(priceRef - f.val) / priceRef < 0.03;
const isBelow = priceRef && priceRef < f.val;
const fc = isNear ? "var(--am)" : isBelow ? "var(--dn)" : "var(--up)";
const fbg = isNear ? "var(--am-bg)" : "var(--gray50)";
const fbd = isNear ? "var(--am-bd)" : "var(--gray200)";
return `<div style="padding:8px 6px;border-radius:8px;background:${fbg};border:1px solid ${fbd};text-align:center${isNear ? ";box-shadow:0 0 0 2px var(--am)40" : ""}">
  <div style="font-size:10px;font-weight:700;color:var(--gray400);margin-bottom:3px">${f.label}</div>
  <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:${fc}">${fp(f.val)}</div>
  ${isNear ? `<div style="font-size:10px;color:var(--am);margin-top:2px">◆ Giá hiện tại</div>` : ""}
</div>`;
}).join("")}
  </div>
</div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // ASSEMBLE — 2-column layout
  // ════════════════════════════════════════════════════════════════════
  el.innerHTML = `
${headerHtml}
${checklistHtml}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;align-items:start">
  <!-- LEFT: Entry + Split -->
  <div style="padding-right:28px;border-right:2px solid var(--gray100)">
${entryZoneHtml}
${buyMetricsHtml}
${splitHtml}
  </div>
  <!-- RIGHT: Exit + Scenarios + Fib -->
  <div style="padding-left:28px">
${exitHtml}
${scenarioHtml}
${fibHtml}
  </div>
</div>
${(pred.worstBuy || pred.worstSell) ? `
<div style="margin-top:16px;padding:12px 16px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200);display:flex;gap:24px;flex-wrap:wrap">
  <span style="font-size:11px;font-weight:700;color:var(--gray500)">⚠️ TRÁNH MUA</span>
  ${pred.worstBuy ? `<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--gray500)">Mua tệ nhất:</span><span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:13px;color:var(--dn)">${fp(pred.worstBuy.price)}</span><span style="font-size:11px;color:var(--gray400)">${(pred.worstBuy.reason || pred.worstBuy.risk || "").slice(0, 70)}</span></div>` : ""}
  ${pred.worstSell ? `<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--gray500)">Bán tệ nhất:</span><span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:13px;color:var(--dn)">${fp(pred.worstSell.price)}</span><span style="font-size:11px;color:var(--gray400)">${(pred.worstSell.reason || pred.worstSell.risk || "").slice(0, 70)}</span></div>` : ""}
</div>` : ""}`;
}


// ═══ QUẢN LÝ VỊ THẾ (Portfolio) ═══════════════════════════════════════════
async function getPortfolio() {
  try {
    const r = await fetch(`${SERVER}/portfolio`);
    return await r.json();
  } catch (e) {
    return {};
  }
}

async function addPosition(sym) {
  const qtyEl = document.getElementById("pfQty");
  const priceEl = document.getElementById("pfPrice");
  const dateEl = document.getElementById("pfDate");
  const qty = parseInt(qtyEl.value);
  const price = parseFloat(priceEl.value);
  const date = dateEl.value || new Date().toISOString().slice(0, 10);
  if (!qty || qty <= 0 || !price || price <= 0) {
    alert("Vui lòng nhập khối lượng và giá hợp lệ");
    return;
  }
  try {
    await fetch(`${SERVER}/portfolio/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, qty, price, date }),
    });
  } catch (e) {
    console.error("Add failed:", e);
  }
  qtyEl.value = "";
  priceEl.value = "";
  dateEl.value = "";
  renderPortfolio();
}

async function removePosition(sym, id) {
  try {
    await fetch(`${SERVER}/portfolio/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, id }),
    });
  } catch (e) {
    console.error("Remove failed:", e);
  }
  renderPortfolio();
}

let editingPositionId = null;
function editPosition(sym, id, qty, price, date) {
  const qtyEl = document.getElementById("pfQty");
  const priceEl = document.getElementById("pfPrice");
  const dateEl = document.getElementById("pfDate");
  const btn = document.getElementById("pfSubmitBtn");
  qtyEl.value = qty;
  priceEl.value = price;
  dateEl.value = date;
  editingPositionId = { sym, id };
  btn.textContent = "✓ Cập nhật";
  btn.style.background = "var(--up)";
  // show cancel button
  document.getElementById("pfCancelBtn").style.display = "inline-flex";
  qtyEl.focus();
}

function cancelEdit() {
  const qtyEl = document.getElementById("pfQty");
  const priceEl = document.getElementById("pfPrice");
  const dateEl = document.getElementById("pfDate");
  const btn = document.getElementById("pfSubmitBtn");
  qtyEl.value = "";
  priceEl.value = "";
  dateEl.value = "";
  editingPositionId = null;
  btn.textContent = "+ Thêm lệnh";
  btn.style.background = "var(--navy)";
  document.getElementById("pfCancelBtn").style.display = "none";
}

async function submitPosition(sym) {
  if (editingPositionId) {
    const qtyEl = document.getElementById("pfQty");
    const priceEl = document.getElementById("pfPrice");
    const dateEl = document.getElementById("pfDate");
    const qty = parseInt(qtyEl.value);
    const price = parseFloat(priceEl.value);
    const date = dateEl.value || new Date().toISOString().slice(0, 10);
    if (!qty || qty <= 0 || !price || price <= 0) {
      alert("Vui lòng nhập khối lượng và giá hợp lệ");
      return;
    }
    try {
      await fetch(`${SERVER}/portfolio/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: editingPositionId.sym,
          id: editingPositionId.id,
          qty,
          price,
          date,
        }),
      });
    } catch (e) {
      console.error("Edit failed:", e);
    }
    cancelEdit();
    renderPortfolio();
  } else {
    addPosition(sym);
  }
}

// ── One-time migration from localStorage ──
async function migratePortfolioIfNeeded() {
  const local = localStorage.getItem("portfolio");
  if (!local) return;
  try {
    const localPf = JSON.parse(local);
    const serverPf = await getPortfolio();
    if (Object.keys(serverPf).length > 0) {
      localStorage.removeItem("portfolio");
      return;
    }
    for (const [sym, positions] of Object.entries(localPf)) {
      for (const p of positions) {
        await fetch(`${SERVER}/portfolio/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            qty: p.qty,
            price: p.price,
            date: p.date,
          }),
        });
      }
    }
    localStorage.removeItem("portfolio");
  } catch (e) {
    console.warn("Portfolio migration failed:", e);
  }
}

// ── Health Score ──
function calcHealthScore(pnlPct, d) {
  let s = 50;
  // P&L
  if (pnlPct > 20) s += 15;
  else if (pnlPct > 10) s += 10;
  else if (pnlPct > 0) s += 5;
  else if (pnlPct > -5) s -= 5;
  else if (pnlPct > -10) s -= 10;
  else if (pnlPct > -20) s -= 15;
  else s -= 20;
  // Trend
  const al = d?.trend?.alignment;
  if (al === "STRONG_UP") s += 15;
  else if (al === "MODERATE_UP") s += 8;
  else if (al === "MODERATE_DOWN") s -= 8;
  else if (al === "STRONG_DOWN") s -= 15;
  // Scoring
  [
    d?.scoring?.canslim?.grade,
    d?.scoring?.sepa?.grade,
    d?.scoring?.momentum?.grade,
  ].forEach((g) => {
    if (g === "A") s += 5;
    else if (g === "D") s -= 5;
  });
  // Pattern verdict
  const vs = d?.patternVerdict?.overall?.score;
  if (vs != null) s += Math.round((vs - 50) / 10);
  // Volume confirmation
  if (d?.volume?.isSurge && d?.trend?.shortTerm?.direction === "UPTREND")
    s += 5;
  // RSI extremes
  const rsi = d?.indicators?.rsi14;
  if (rsi > 80) s -= 5;
  if (rsi < 20) s -= 5;
  return Math.max(0, Math.min(100, s));
}


function generateAdvisory(avgPrice, curPrice, pnlPct, positions, d) {
  const pred = d?.predictions;
  const trend = d?.trend;
  const ind = d?.indicators;
  const sr = d?.supportResistance;
  const vol = d?.volume;
  const scoring = d?.scoring;
  const profile = d?.investmentProfile;
  const verdict = d?.patternVerdict;

  const rsi = ind?.rsi14;
  const macd = ind?.macdHistogram;
  const ma20 = ind?.ma20,
    ma50 = ind?.ma50,
    ma200 = ind?.ma200;
  const bestBuy = pred?.bestBuy;
  const sellTargets = bestBuy?.sellStrategy?.targets || [];
  const stoploss = bestBuy?.stoploss;
  const slFromAvg = stoploss
    ? (((stoploss - avgPrice) / avgPrice) * 100).toFixed(1)
    : null;
  const nearSup = sr?.supports?.[0]?.price;
  const nearRes = sr?.resistances?.[0]?.price;
  const trendShort = trend?.shortTerm?.direction;
  const trendMid = trend?.midTerm?.direction;
  const trendLong = trend?.longTerm?.direction;
  const alignment = trend?.alignment;
  const aboveMa50 = ma50 && curPrice > ma50;
  const aboveMa200 = ma200 && curPrice > ma200;
  const volRatio = vol?.ratio;
  const health = calcHealthScore(pnlPct, d);

  // helpers
  const tag = (label, color) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:${color}15;color:${color};border:1px solid ${color}30;margin-right:4px">${label}</span>`;
  const gc = (g) =>
    g === "A"
      ? "var(--up)"
      : g === "B"
      ? "var(--navy)"
      : g === "C"
      ? "var(--am)"
      : "var(--dn)";
  const hc =
    health >= 70 ? "var(--up)" : health >= 45 ? "var(--am)" : "var(--dn)";
  const hLabel =
    health >= 70 ? "MẠNH" : health >= 45 ? "TRUNG BÌNH" : "YẾU";
  const pSign = pnlPct >= 0 ? "+" : "";

  // scoring tags HTML
  const canG = scoring?.canslim?.grade,
    sepaG = scoring?.sepa?.grade,
    momG = scoring?.momentum?.grade;
  const scoreTags = [
    canG ? tag(`CANSLIM ${canG}`, gc(canG)) : "",
    sepaG ? tag(`SEPA ${sepaG}`, gc(sepaG)) : "",
    momG ? tag(`Mom. ${momG}`, gc(momG)) : "",
  ]
    .filter(Boolean)
    .join("");

  // health bar HTML
  const healthHtml = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    <div style="font-size:11px;font-weight:700;color:var(--gray400)">HEALTH</div>
    <div style="flex:1;height:6px;border-radius:3px;background:var(--gray200);overflow:hidden"><div style="height:100%;width:${health}%;background:${hc};border-radius:3px;transition:width .5s"></div></div>
    <div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;color:${hc}">${health}<span style="font-size:11px;font-weight:600;color:var(--gray400)">/100</span></div>
    <div style="font-size:11px;font-weight:700;color:${hc}">${hLabel}</div>
  </div>`;

  // volume line
  const volLine = volRatio
    ? `<div style="font-size:12px;color:var(--gray500);margin-top:4px">Volume ${volRatio.toFixed(
        1
      )}x TB20 ${
        vol?.isSurge
          ? '<span style="color:var(--up);font-weight:700">SURGE</span>'
          : vol?.trend === "increasing"
          ? '<span style="color:var(--up)">tang</span>'
          : '<span style="color:var(--gray400)">' +
            vol?.trendDesc +
            "</span>"
      }</div>`
    : "";

  // S/R levels compact
  const srLine = (() => {
    const sups = (sr?.supports || [])
      .slice(0, 3)
      .map(
        (s) =>
          `<span style="color:var(--up)">${fp(
            s.price
          )}</span> <span style="font-size:10px;color:var(--gray400)">(${
            s.touches
          }t)</span>`
      );
    const ress = (sr?.resistances || [])
      .slice(0, 3)
      .map(
        (r) =>
          `<span style="color:var(--dn)">${fp(
            r.price
          )}</span> <span style="font-size:10px;color:var(--gray400)">(${
            r.touches
          }t)</span>`
      );
    if (!sups.length && !ress.length) return "";
    return `<div style="font-size:12px;margin-top:6px"><span style="color:var(--gray400)">S:</span> ${
      sups.join(" · ") || "—"
    } &nbsp; <span style="color:var(--gray400)">R:</span> ${
      ress.join(" · ") || "—"
    }</div>`;
  })();

  // sell targets compact
  const tpLine = (() => {
    if (!sellTargets.length) return "";
    const ts = sellTargets.map(
      (t, i) =>
        `TP${i + 1} <span style="font-weight:700;color:var(--up)">${fp(
          t.price
        )}</span> <span style="color:var(--gray400)">(+${parseFloat(
          t.pct
        ).toFixed(1)}% R:R ${t.rr})</span>`
    );
    return `<div style="font-size:12px;margin-top:4px">${ts.join(
      " &nbsp;·&nbsp; "
    )}</div>`;
  })();

  // stoploss from avg
  const slLine = stoploss
    ? `<div style="font-size:12px;margin-top:4px"><span style="color:var(--gray400)">SL</span> <span style="font-weight:700;color:var(--dn)">${fp(
        stoploss
      )}</span> <span style="color:var(--gray400)">(${slFromAvg}% từ giá vốn)</span></div>`
    : "";

  // ═══ SHORT TERM (1-2 weeks) ═══
  let shortAdv = "",
    shortColor = "var(--gray700)",
    shortActions = [];
  const verdictShort = verdict?.perTimeframe?.shortTerm;
  const profileShort = profile?.shortTerm;

  if (pnlPct <= -7) {
    shortColor = "var(--dn)";
    if (stoploss && curPrice <= stoploss) {
      shortAdv = `<b>Giá phá stoploss ${fp(
        stoploss
      )}</b> — vị thế lỗ nặng ${pnlPct.toFixed(1)}%.`;
      shortActions = [
        "Cắt lỗ ngay để bảo toàn vốn",
        "Không DCA khi trend đang giảm",
        "Chờ tín hiệu đảo chiều rõ ràng mới vào lại",
      ];
    } else if (nearSup && curPrice > nearSup) {
      shortAdv = `Lỗ nặng ${pnlPct.toFixed(1)}%. Hỗ trợ gần nhất <b>${fp(
        nearSup
      )}</b> (${(((nearSup - curPrice) / curPrice) * 100).toFixed(1)}%).`;
      shortActions = [
        `Nếu mất ${fp(nearSup)} → cắt lỗ ngay`,
        `Nếu giữ hỗ trợ → chờ phản ứng, volume phải tăng`,
        rsi && rsi < 30
          ? `RSI ${rsi.toFixed(
              0
            )} quá bán — có thể phản hồi kỹ thuật ngắn hạn`
          : `RSI ${
              rsi ? rsi.toFixed(0) : "—"
            } — chưa oversold, áp lực bán vẫn còn`,
      ];
    } else {
      shortAdv = `Lỗ nặng ${pnlPct.toFixed(1)}%. Xu hướng ngắn hạn yếu.`;
      shortActions = [
        "Cắt lỗ hoặc giảm 50%+ vị thế",
        "Đặt SL chặt tại " +
          (stoploss ? fp(stoploss) : "dưới hỗ trợ gần nhất"),
        "Chỉ giữ nếu có catalyst đặc biệt",
      ];
    }
  } else if (pnlPct <= -3) {
    shortColor = "var(--am)";
    shortAdv = `Lỗ nhẹ ${pnlPct.toFixed(1)}%.`;
    if (rsi && rsi < 30) {
      shortAdv += ` RSI <b>${rsi.toFixed(0)}</b> quá bán.`;
      shortActions = [
        "Có thể phản hồi kỹ thuật ngắn hạn",
        "Đặt SL tại " + (stoploss ? fp(stoploss) : "hỗ trợ"),
        "Nếu phục hồi, bán 30% để giảm rủi ro",
      ];
    } else if (trendShort === "UPTREND") {
      shortAdv += ` Xu hướng ngắn hạn vẫn tăng.`;
      shortActions = [
        "Giữ vị thế, chờ phục hồi về giá vốn",
        "SL tại " + (stoploss ? fp(stoploss) : "hỗ trợ gần nhất"),
        "Theo dõi volume — cần tăng để xác nhận",
      ];
    } else {
      shortActions = [
        "Đặt SL chặt tại " +
          (stoploss
            ? `${fp(stoploss)} (${slFromAvg}% từ vốn)`
            : "dưới hỗ trợ"),
        "Theo dõi volume và RSI",
        "Không thêm vị thế khi xu hướng chưa rõ",
      ];
    }
  } else if (pnlPct <= 3) {
    shortColor = "var(--navy)";
    shortAdv = `Hòa vốn (${pSign}${pnlPct.toFixed(1)}%).`;
    if (trendShort === "UPTREND" && rsi && rsi < 70) {
      shortActions = [
        "Giữ vị thế — trend tốt, RSI " + rsi.toFixed(0) + " chưa quá mua",
        "Đặt SL tại " + (stoploss ? fp(stoploss) : fp(avgPrice * 0.95)),
        "Theo dõi breakout qua " + (nearRes ? fp(nearRes) : "kháng cự"),
      ];
    } else if (rsi && rsi > 70) {
      shortActions = [
        "RSI " + rsi.toFixed(0) + " quá mua — cân nhắc chốt 30%",
        "Dời SL lên sát giá vốn " + fp(avgPrice),
        "Chờ RSI hạ nhiệt rồi đánh giá lại",
      ];
    } else {
      shortActions = [
        "Giữ, theo dõi tín hiệu breakout/breakdown",
        "SL tại " + (stoploss ? fp(stoploss) : fp(avgPrice * 0.95)),
        "Volume cần xác nhận hướng đi",
      ];
    }
  } else if (pnlPct <= 10) {
    shortColor = "var(--up)";
    shortAdv = `Lãi <b>+${pnlPct.toFixed(1)}%</b>.`;
    const tp1 = sellTargets[0];
    if (tp1 && curPrice >= tp1.price) {
      shortActions = [
        `TP1 đạt ${fp(tp1.price)} → bán ${tp1.sellPct}% chốt lời`,
        `Dời SL lên giá vốn ${fp(avgPrice)}`,
        `Target tiếp: ${
          sellTargets[1] ? fp(sellTargets[1].price) : "theo trailing stop"
        }`,
      ];
    } else if (rsi && rsi > 75) {
      shortActions = [
        `RSI ${rsi.toFixed(0)} quá mua → chốt 30-50%`,
        `Bảo vệ lợi nhuận, dời SL lên ${fp(avgPrice)}`,
        tp1
          ? `TP1 tại ${fp(tp1.price)} (+${parseFloat(tp1.pct).toFixed(
              1
            )}%)`
          : "Trailing stop 5%",
      ];
    } else {
      shortActions = [
        `Dời SL lên giá vốn ${fp(avgPrice)}`,
        `Để lợi nhuận chạy — RSI ${rsi ? rsi.toFixed(0) : "—"} còn room`,
        tp1
          ? `TP1: ${fp(tp1.price)} (R:R ${tp1.rr})`
          : "Trailing stop 5%",
      ];
    }
  } else {
    shortColor = "var(--up)";
    shortAdv = `Lãi mạnh <b>+${pnlPct.toFixed(1)}%</b>!`;
    const tp2 = sellTargets[1],
      tp3 = sellTargets[2];
    if (tp3 && curPrice >= tp3.price) {
      shortActions = [
        "Vượt TP3! Chốt 70-80% bảo vệ siêu lợi nhuận",
        "Giữ 20% với trailing stop " +
          (bestBuy?.sellStrategy?.trailingStop?.pct || 5) +
          "%",
        "Tái đầu tư phần chốt vào cơ hội khác",
      ];
    } else if (tp2 && curPrice >= tp2.price) {
      shortActions = [
        `TP2 đạt ${fp(tp2.price)} → bán thêm 30%`,
        `Giữ 30-40% với trailing stop`,
        tp3 ? `Target cuối TP3: ${fp(tp3.price)}` : "Trailing stop chặt",
      ];
    } else {
      shortActions = [
        `Chốt 30-50% bảo vệ lãi`,
        `Dời SL lên ${fp(avgPrice * 1.03)} (+3% vốn)`,
        `Để phần còn lại chạy theo trend`,
      ];
    }
  }

  const shortHtml =
    healthHtml +
    `<div style="font-size:13px;color:${shortColor};line-height:1.6;margin-bottom:8px">${shortAdv}</div>` +
    `<div style="margin:8px 0">${shortActions
      .map(
        (a, i) =>
          `<div style="font-size:12px;color:var(--gray700);padding:3px 0;display:flex;gap:6px"><span style="color:var(--gray400);font-weight:700;min-width:16px">${
            i + 1
          }.</span><span>${a}</span></div>`
      )
      .join("")}</div>` +
    volLine +
    slLine +
    tpLine +
    (verdictShort
      ? `<div style="font-size:11px;color:var(--gray400);margin-top:6px">Pattern: ${
          verdictShort.grade
        } (${verdictShort.score}/100) · Confluence: ${
          verdictShort.confluenceLevel || "—"
        }</div>`
      : "") +
    `<div style="margin-top:8px">${scoreTags}</div>` +
    (profileShort
      ? `<div style="margin-top:4px">${tag(
          profileShort.grade + " " + profileShort.suitability,
          gc(profileShort.grade)
        )}</div>`
      : "");

  // ═══ MID TERM (1-3 months) ═══
  let midAdv = "",
    midColor = "var(--gray700)",
    midActions = [];
  const profileMid = profile?.midTerm;
  const verdictMid = verdict?.perTimeframe?.midTerm;

  // MA structure
  const maStruct = `<div style="font-size:12px;margin-top:6px;color:var(--gray500)">MA50 <b style="color:${
    aboveMa50 ? "var(--up)" : "var(--dn)"
  }"">${ma50 ? fp(ma50) : "—"}</b> ${
    aboveMa50 ? "(trên)" : "(dưới)"
  } · MA200 <b style="color:${aboveMa200 ? "var(--up)" : "var(--dn)"}">${
    ma200 ? fp(ma200) : "—"
  }</b> ${aboveMa200 ? "(trên)" : "(dưới)"}</div>`;

  if (pnlPct <= -15) {
    midColor = "var(--dn)";
    midAdv = `Lỗ sâu <b>${pnlPct.toFixed(1)}%</b>.`;
    if (!aboveMa50 && !aboveMa200) {
      midActions = [
        "Cấu trúc trung hạn hỏng — giá dưới MA50 và MA200",
        "Cắt hoặc giảm 50%+ vị thế",
        "Chỉ mua lại khi giá lấy lại MA50 với volume tăng",
        "Xem xét chuyển vốn sang mã có xu hướng tốt hơn",
      ];
    } else {
      midActions = [
        "Tìm vùng tích lũy nếu fundamentals vẫn tốt",
        aboveMa200
          ? "Giá vẫn trên MA200 — cấu trúc dài hạn chưa hỏng"
          : "Giá dưới MA200 — cẩn trọng",
        "DCA nhỏ nếu giá về hỗ trợ mạnh " + (nearSup ? fp(nearSup) : ""),
      ];
    }
  } else if (pnlPct < 0) {
    midColor = aboveMa50 ? "var(--am)" : "var(--dn)";
    midAdv = `Đang lỗ <b>${pnlPct.toFixed(1)}%</b>.`;
    if (aboveMa50) {
      midActions = [
        `Giá trên MA50 ${fp(ma50)} — cấu trúc trung hạn chưa hỏng`,
        `DCA nếu giá về hỗ trợ ${nearSup ? fp(nearSup) : "mạnh"}`,
        `Theo dõi MA50 làm hỗ trợ động`,
      ];
    } else if (aboveMa200) {
      midActions = [
        "Giá dưới MA50 nhưng trên MA200 — đang điều chỉnh",
        "Chờ giá lấy lại MA50 trước khi thêm",
        "Không DCA thêm ở vùng này",
      ];
    } else {
      midActions = [
        "Giá dưới MA200 — xu hướng giảm trung hạn",
        "Không DCA thêm, xem xét cắt giảm",
        "Chờ tín hiệu đảo chiều rõ ràng: golden cross, volume surge",
      ];
    }
  } else if (pnlPct <= 15) {
    midColor = "var(--up)";
    midAdv = `Lãi <b>+${pnlPct.toFixed(1)}%</b>.`;
    if (trendMid === "UPTREND" && aboveMa50) {
      midActions = [
        "Xu hướng trung hạn tăng, giá trên MA50 → giữ",
        "Trailing stop 8-10% từ đỉnh gần nhất",
        nearRes
          ? `Kháng cự tiếp ${fp(nearRes)} — breakout sẽ mở rộng target`
          : "Theo dõi kháng cự mới",
      ];
    } else {
      midActions = [
        `MA50 ${ma50 ? fp(ma50) : "—"} làm hỗ trợ động`,
        `Nếu phá MA50 → giảm 30-50% vị thế`,
        `Volume trend: ${vol?.trendDesc || "—"}`,
      ];
    }
  } else {
    midColor = "var(--up)";
    midAdv = `Lãi tốt <b>+${pnlPct.toFixed(1)}%</b>!`;
    midActions = [
      "Trailing stop 10-12% từ đỉnh",
      nearRes
        ? `Kháng cự ${fp(nearRes)} — vượt sẽ mở rộng target`
        : "Để profit chạy",
      "Chỉ thoát khi phá MA50 với volume lớn",
    ];
  }

  const midHtml =
    `<div style="font-size:13px;color:${midColor};line-height:1.6;margin-bottom:8px">${midAdv}</div>` +
    `<div style="margin:8px 0">${midActions
      .map(
        (a, i) =>
          `<div style="font-size:12px;color:var(--gray700);padding:3px 0;display:flex;gap:6px"><span style="color:var(--gray400);font-weight:700;min-width:16px">${
            i + 1
          }.</span><span>${a}</span></div>`
      )
      .join("")}</div>` +
    maStruct +
    srLine +
    (vol
      ? `<div style="font-size:12px;color:var(--gray500);margin-top:4px">Volume: ${volRatio?.toFixed(
          1
        )}x TB · Trend: ${vol.trendDesc || "—"}</div>`
      : "") +
    (verdictMid
      ? `<div style="font-size:11px;color:var(--gray400);margin-top:6px">Pattern trung hạn: ${verdictMid.grade} (${verdictMid.score}/100)</div>`
      : "") +
    (profileMid
      ? `<div style="margin-top:8px">${tag(
          profileMid.grade + " — " + profileMid.suitability,
          gc(profileMid.grade)
        )}</div><div style="font-size:11px;color:var(--gray500);margin-top:2px">${
          profileMid.suggestion || ""
        }</div>`
      : "");

  // ═══ LONG TERM (6-12 months) ═══
  let longAdv = "",
    longColor = "var(--gray700)",
    longActions = [];
  const profileLong = profile?.longTerm;
  const overallVerdict = verdict?.overall;

  if (pnlPct <= -20) {
    longColor = "var(--dn)";
    longAdv = `Lỗ nặng dài hạn <b>${pnlPct.toFixed(1)}%</b>.`;
    longActions = [
      "Đánh giá lại fundamentals: doanh thu, lợi nhuận, triển vọng ngành",
      aboveMa200
        ? "Giá trên MA200 — có thể phục hồi nếu cơ bản tốt"
        : "Giá dưới MA200 — cân nhắc thoát, phân bổ vốn tốt hơn",
      "Nếu giữ: đặt SL rộng, chấp nhận recovery dài",
      "Xem xét tax-loss harvesting nếu phù hợp",
    ];
  } else if (pnlPct < 0) {
    longColor = "var(--am)";
    longAdv = `Đang lỗ <b>${pnlPct.toFixed(1)}%</b>.`;
    if (trendLong === "UPTREND") {
      longActions = [
        "Xu hướng dài hạn tăng — kiên nhẫn giữ",
        "DCA dần vào vùng hỗ trợ mạnh khi có cơ hội",
        "MA200 là mốc quan trọng: " + (ma200 ? fp(ma200) : "—"),
      ];
    } else {
      longActions = [
        "Xu hướng dài hạn chưa rõ",
        "Giữ vị thế nhỏ, không DCA thêm",
        "Chờ giá lấy lại MA200 " + (ma200 ? fp(ma200) : ""),
        "Đa dạng hóa sang mã có trend tốt hơn",
      ];
    }
  } else if (pnlPct <= 30) {
    longColor = "var(--up)";
    longAdv = `Lãi <b>+${pnlPct.toFixed(1)}%</b>.`;
    if (trendLong === "UPTREND") {
      longActions = [
        "Xu hướng dài hạn tốt → giữ core 70-80%",
        "Chốt 20-30% khi lãi >25% để tái phân bổ",
        "Trailing stop 15% từ đỉnh",
        "Theo dõi quarterly earnings",
      ];
    } else {
      longActions = [
        "Trend dài hạn không rõ → chốt 40-50%",
        "Giữ phần còn lại với SL rộng 15-20%",
        "Tái đánh giá khi có tín hiệu trend mới",
      ];
    }
  } else {
    longColor = "var(--up)";
    longAdv = `Lãi xuất sắc <b>+${pnlPct.toFixed(1)}%</b>!`;
    longActions = [
      "Chốt 30-40% tái cân bằng danh mục",
      "Giữ 60-70% core với trailing stop 15-20%",
      "Vị thế lớn → xem xét hedge hoặc diversify",
      "Tái đầu tư lợi nhuận chốt được",
    ];
  }

  // scoring detail
  const scoreDetail =
    `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px">` +
    (scoring?.canslim
      ? `<div style="padding:8px;border-radius:8px;background:${gc(
          canG
        )}10;border:1px solid ${gc(
          canG
        )}25;text-align:center"><div style="font-size:10px;font-weight:700;color:var(--gray400)">CANSLIM</div><div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:16px;color:${gc(
          canG
        )}">${scoring.canslim.total}/${
          scoring.canslim.maxTotal || 70
        }</div><div style="font-size:11px;color:${gc(canG)}">${
          scoring.canslim.verdict || canG
        }</div></div>`
      : "") +
    (scoring?.sepa
      ? `<div style="padding:8px;border-radius:8px;background:${gc(
          sepaG
        )}10;border:1px solid ${gc(
          sepaG
        )}25;text-align:center"><div style="font-size:10px;font-weight:700;color:var(--gray400)">SEPA</div><div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:16px;color:${gc(
          sepaG
        )}">${scoring.sepa.total}/${
          scoring.sepa.maxTotal || 80
        }</div><div style="font-size:11px;color:${gc(sepaG)}">${
          scoring.sepa.verdict || sepaG
        }</div></div>`
      : "") +
    (scoring?.momentum
      ? `<div style="padding:8px;border-radius:8px;background:${gc(
          momG
        )}10;border:1px solid ${gc(
          momG
        )}25;text-align:center"><div style="font-size:10px;font-weight:700;color:var(--gray400)">MOMENTUM</div><div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:16px;color:${gc(
          momG
        )}">${scoring.momentum.total}/${
          scoring.momentum.maxTotal || 70
        }</div><div style="font-size:11px;color:${gc(momG)}">${
          scoring.momentum.verdict || momG
        }</div></div>`
      : "") +
    `</div>`;

  const longHtml =
    `<div style="font-size:13px;color:${longColor};line-height:1.6;margin-bottom:8px">${longAdv}</div>` +
    `<div style="margin:8px 0">${longActions
      .map(
        (a, i) =>
          `<div style="font-size:12px;color:var(--gray700);padding:3px 0;display:flex;gap:6px"><span style="color:var(--gray400);font-weight:700;min-width:16px">${
            i + 1
          }.</span><span>${a}</span></div>`
      )
      .join("")}</div>` +
    (overallVerdict
      ? `<div style="font-size:12px;margin-top:6px"><span style="color:var(--gray400)">Technical Grade:</span> <b style="color:${
          overallVerdict.color === "up"
            ? "var(--up)"
            : overallVerdict.color === "dn"
            ? "var(--dn)"
            : "var(--am)"
        }">${overallVerdict.grade}</b> — ${overallVerdict.label} (${
          overallVerdict.score
        }/100)</div>`
      : "") +
    scoreDetail +
    (profileLong
      ? `<div style="margin-top:8px">${tag(
          profileLong.grade + " — " + profileLong.suitability,
          gc(profileLong.grade)
        )}</div><div style="font-size:11px;color:var(--gray500);margin-top:2px">${
          profileLong.suggestion || ""
        }</div>`
      : "") +
    (profile?.bestFit
      ? `<div style="font-size:11px;color:var(--navy);font-weight:600;margin-top:4px">Best fit: ${
          profile.bestFit.label || profile.bestFit
        }</div>`
      : "");

  // ═══ DCA CHIẾN LƯỢC ═══
  let dcaColor = "var(--gray700)";
  const dcaTotalQty = positions.reduce((s, p) => s + p.qty, 0);
  const dcaTotalCost = positions.reduce((s, p) => s + p.qty * p.price, 0);

  const belowSL = stoploss && curPrice <= stoploss;
  const structBroken = !aboveMa200 && pnlPct < -15;
  const tooDeepLoss = pnlPct < -25;

  // Build DCA candidate levels below current price
  const rawDcaLevels = [
    ...(sr?.supports || []).filter(s => s.price < curPrice * 0.99).slice(0, 3)
      .map(s => ({ price: s.price, label: `Hỗ trợ (${s.touches}t)` })),
    ...(ma50 && ma50 < curPrice * 0.99 ? [{ price: ma50, label: "MA50" }] : []),
    ...(ma200 && ma200 < curPrice * 0.99 ? [{ price: ma200, label: "MA200" }] : []),
  ].sort((a, b) => b.price - a.price);

  // Deduplicate levels within 2%
  const dcaLevels = [];
  for (const lv of rawDcaLevels) {
    if (!dcaLevels.some(x => Math.abs(x.price - lv.price) / lv.price < 0.02)) {
      dcaLevels.push(lv);
      if (dcaLevels.length >= 3) break;
    }
  }

  // Tỷ lệ 1:2:3 — base = 1/4 vị thế, tổng 3 bước ≈ 150% vị thế gốc
  const dcaBase = Math.max(100, Math.round(dcaTotalQty / 4 / 100) * 100);
  const dcaMultipliers = [1, 2, 3];

  // Cumulative DCA projections
  let cumQtyAcc = dcaTotalQty;
  let cumCostAcc = dcaTotalCost;
  const dcaProjections = dcaLevels.map((lv, i) => {
    const dcaStep = Math.round(dcaBase * dcaMultipliers[i] / 100) * 100;
    cumQtyAcc += dcaStep;
    cumCostAcc += dcaStep * lv.price;
    const newAvg = cumCostAcc / cumQtyAcc;
    const pctFromCur = ((lv.price - curPrice) / curPrice * 100).toFixed(1);
    const avgChangePct = ((newAvg - avgPrice) / avgPrice * 100).toFixed(1);
    return { ...lv, dcaStep, pctFromCur, newAvg, avgChangePct, cumQty: cumQtyAcc };
  });

  let dcaHtml = "";

  if (belowSL || structBroken || tooDeepLoss) {
    dcaColor = "var(--dn)";
    const reason = belowSL
      ? `Giá phá stoploss ${stoploss ? fp(stoploss) : ""} — <b>tuyệt đối không DCA</b>.`
      : structBroken
      ? `Giá dưới MA200, lỗ <b>${pnlPct.toFixed(1)}%</b> — cấu trúc hỏng, không DCA.`
      : `Lỗ quá sâu <b>${pnlPct.toFixed(1)}%</b> — DCA chỉ tăng rủi ro.`;
    const notRecommended = [
      "Ưu tiên cắt lỗ, bảo toàn vốn",
      "DCA khi trend giảm mạnh = bắt dao đang rơi",
      belowSL
        ? "Chỉ đánh giá lại khi giá lấy lại trên stoploss"
        : `Chờ giá lấy lại MA200 (${ma200 ? fp(ma200) : "—"}) rồi mới xem xét`,
    ];
    dcaHtml = `<div style="padding:10px 14px;border-radius:8px;background:var(--dn-bg);border:1px solid var(--dn-bd);margin-bottom:10px">
  <div style="font-size:13px;color:var(--dn);font-weight:700">${reason}</div>
</div>
<div style="margin:6px 0">${notRecommended.map((a, i) =>
      `<div style="font-size:12px;color:var(--gray700);padding:3px 0;display:flex;gap:6px"><span style="color:var(--dn);font-weight:700;min-width:16px">${i + 1}.</span><span>${a}</span></div>`
    ).join("")}</div>`;

  } else if (pnlPct > 10) {
    dcaColor = "var(--up)";
    dcaHtml = `<div style="padding:10px 14px;border-radius:8px;background:var(--up-bg);border:1px solid var(--up-bd);margin-bottom:10px">
  <div style="font-size:13px;color:var(--up);font-weight:700">Lãi <b>+${pnlPct.toFixed(1)}%</b> — không cần DCA, tập trung bảo vệ lãi.</div>
</div>
<div style="margin:6px 0">${[
      "Chỉ thêm vị thế khi có breakout xác nhận với volume lớn",
      nearSup ? `Nếu pullback về hỗ trợ ${fp(nearSup)} có thể cân nhắc mua thêm nhỏ` : "Không thêm khi chưa có pullback rõ ràng",
      "Ưu tiên dời SL lên bảo vệ lãi hiện có",
    ].map((a, i) =>
      `<div style="font-size:12px;color:var(--gray700);padding:3px 0;display:flex;gap:6px"><span style="color:var(--up);font-weight:700;min-width:16px">${i + 1}.</span><span>${a}</span></div>`
    ).join("")}</div>`;

  } else {
    dcaColor = pnlPct < -5 ? "var(--am)" : "var(--navy)";
    const intro = pnlPct < 0
      ? `Lỗ <b>${pnlPct.toFixed(1)}%</b> — có thể DCA có kế hoạch nếu thesis còn nguyên.`
      : `Gần hòa vốn — có thể tích lũy thêm khi giá về vùng tốt.`;

    dcaHtml = `<div style="font-size:13px;color:${dcaColor};margin-bottom:10px">${intro}</div>`;

    // Conditions checklist
    const conds = [];
    if (rsi != null) conds.push({ label: `RSI ${rsi.toFixed(0)}`, ok: rsi < 45, note: rsi < 30 ? "quá bán ✓" : rsi < 45 ? "OK ✓" : "chưa đủ giảm" });
    if (aboveMa50 != null) conds.push({ label: `MA50 ${ma50 ? fp(ma50) : "—"}`, ok: aboveMa50, note: aboveMa50 ? "giá trên ✓" : "giá dưới ✗" });
    if (aboveMa200 != null) conds.push({ label: `MA200 ${ma200 ? fp(ma200) : "—"}`, ok: aboveMa200, note: aboveMa200 ? "cấu trúc dài hạn OK ✓" : "cẩn thận ✗" });
    if (conds.length) {
      dcaHtml += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${conds.map(c =>
        `<span style="font-size:11px;padding:3px 8px;border-radius:5px;background:${c.ok ? "var(--up-bg)" : "var(--dn-bg)"};color:${c.ok ? "var(--up)" : "var(--dn)"};border:1px solid ${c.ok ? "var(--up-bd)" : "var(--dn-bd)"}">${c.label} — ${c.note}</span>`
      ).join("")}</div>`;
    }

    if (dcaProjections.length > 0) {
      dcaHtml += `<div style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:6px">KẾ HOẠCH DCA — mua nhiều hơn ở giá thấp hơn</div>`;
      dcaHtml += `<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px">`;
      dcaProjections.forEach((step, i) => {
        const pctColor = parseFloat(step.pctFromCur) >= 0 ? "var(--up)" : "var(--dn)";
        const avgColor = parseFloat(step.avgChangePct) <= 0 ? "var(--up)" : "var(--dn)";
        dcaHtml += `<div style="display:grid;grid-template-columns:22px 1fr 110px 90px;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:var(--gray50);border:1px solid var(--gray100)">
  <span style="font-size:11px;font-weight:800;color:var(--gray400);text-align:center">#${i + 1}</span>
  <div>
    <span style="font-size:13px;font-weight:700;color:var(--navy)">${fp(step.price)}</span>
    <span style="font-size:11px;color:var(--gray400);margin-left:4px">${step.label}</span>
    <span style="font-size:11px;color:${pctColor};margin-left:4px">(${step.pctFromCur}%)</span>
  </div>
  <div style="text-align:right">
    <div style="font-size:10px;color:var(--gray400)">Vốn TB mới</div>
    <div style="font-size:13px;font-weight:700;color:var(--gray800)">${fp(step.newAvg)}</div>
    <div style="font-size:10px;color:${avgColor};font-weight:700">${step.avgChangePct}% vs cũ</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:10px;color:var(--gray400)">Mua thêm</div>
    <div style="font-size:13px;font-weight:700;color:var(--navy)">+${step.dcaStep.toLocaleString("vi-VN")} CP</div>
    <div style="font-size:10px;color:var(--gray400)">Tổng: ${step.cumQty.toLocaleString("vi-VN")}</div>
  </div>
</div>`;
      });
      dcaHtml += `</div>`;

      // DCA rules
      const dcaRules = [
        "Chỉ DCA khi giá đóng cửa xác nhận tại vùng hỗ trợ — không mua trước",
        "Volume phải tăng khi giá giữ vùng hỗ trợ (xác nhận lực cầu)",
        aboveMa50
          ? `MA50 (${ma50 ? fp(ma50) : "—"}) là stoploss của toàn bộ kế hoạch DCA`
          : `Dừng DCA nếu giá không lấy lại MA50 (${ma50 ? fp(ma50) : "—"})`,
        "Không DCA quá 3 lần — nếu vỡ cả 3 vùng, thoát toàn bộ vị thế",
      ];
      dcaHtml += `<div style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:4px">NGUYÊN TẮC</div>`;
      dcaHtml += dcaRules.map((r, i) =>
        `<div style="font-size:11px;color:var(--gray600);padding:2px 0;display:flex;gap:5px"><span style="color:var(--gray400);min-width:14px">${i + 1}.</span><span>${r}</span></div>`
      ).join("");

    } else {
      dcaHtml += `<div style="font-size:12px;color:var(--gray500);margin-top:6px">Chưa xác định được vùng DCA rõ ràng. Chờ giá test hỗ trợ cụ thể.</div>`;
      if (nearSup) {
        dcaHtml += `<div style="font-size:12px;color:var(--gray700);margin-top:6px">Hỗ trợ gần nhất: <b style="color:var(--up)">${fp(nearSup)}</b> — theo dõi phản ứng tại đây.</div>`;
      }
    }
  }

  return {
    short: { text: shortHtml, color: shortColor },
    mid: { text: midHtml, color: midColor },
    long: { text: longHtml, color: longColor },
    dca: { text: dcaHtml, color: dcaColor },
  };
}

async function submitSell(sym) {
  const qty = parseInt(document.getElementById("pfSellQty").value);
  const price = parseFloat(document.getElementById("pfSellPrice").value);
  const date = document.getElementById("pfSellDate").value;
  if (!qty || qty <= 0 || !price || price <= 0) {
    showToast("Nhập KL và giá bán hợp lệ", "var(--dn)");
    return;
  }
  try {
    const r = await fetch(`${SERVER}/portfolio/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, qty, price, date }),
    });
    const j = await r.json();
    if (!r.ok || j.error) {
      showToast("Lỗi: " + (j.error || "Không bán được"), "var(--dn)");
      return;
    }
    const pnl = j.entry?.pnl;
    const pnlPct = j.entry?.pnlPct;
    const sign = pnl >= 0 ? "+" : "";
    showToast(
      `Đã bán ${qty} ${sym} @ ${price} | ${sign}${(pnl / 1e3).toFixed(
        1
      )} tr (${sign}${pnlPct?.toFixed(1)}%)`,
      pnl >= 0 ? "var(--up)" : "var(--dn)"
    );
    document.getElementById("pfSellFormWrap").style.display = "none";
    renderPortfolio();
  } catch (e) {
    showToast("Lỗi kết nối", "var(--dn)");
  }
}

async function renderPortfolio() {
  const el = document.getElementById("portfolioContent");
  if (!el) return;
  const sym = document.getElementById("symbolBadge")?.textContent;
  if (!sym) {
    el.innerHTML =
      '<div style="padding:20px;color:var(--gray400)">Chọn mã cổ phiếu trước</div>';
    return;
  }

  const pf = await getPortfolio();
  const positions = pf[sym] || [];
  const curPrice = analysisData?.latestPrice;

  // ── Form nhập ──
  let html = `
  <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:20px;border-bottom:2px solid var(--gray100)">
    <div style="flex:1;min-width:120px">
<label style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">KHỐI LƯỢNG (CP)</label>
<input id="pfQty" type="number" min="100" step="100" placeholder="VD: 500" style="width:100%;padding:10px 14px;border:1px solid var(--gray200);border-radius:10px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;outline:none;transition:border .2s" onfocus="this.style.borderColor='var(--navy)'" onblur="this.style.borderColor='var(--gray200)'"/>
    </div>
    <div style="flex:1;min-width:120px">
<label style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">GIÁ MUA (nghìn đ)</label>
<input id="pfPrice" type="number" min="0" step="0.1" placeholder="VD: 85.0" style="width:100%;padding:10px 14px;border:1px solid var(--gray200);border-radius:10px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;outline:none;transition:border .2s" onfocus="this.style.borderColor='var(--navy)'" onblur="this.style.borderColor='var(--gray200)'"/>
    </div>
    <div style="flex:1;min-width:130px">
<label style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">NGÀY MUA</label>
<input id="pfDate" type="date" value="${new Date()
  .toISOString()
  .slice(
    0,
    10
  )}" style="width:100%;padding:10px 14px;border:1px solid var(--gray200);border-radius:10px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;outline:none;transition:border .2s" onfocus="this.style.borderColor='var(--navy)'" onblur="this.style.borderColor='var(--gray200)'"/>
    </div>
    <button id="pfSubmitBtn" onclick="submitPosition('${sym}')" style="padding:10px 24px;background:var(--navy);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">+ Thêm lệnh</button>
    <button id="pfCancelBtn" onclick="cancelEdit()" style="display:none;padding:10px 16px;background:var(--gray100);color:var(--gray700);border:1px solid var(--gray200);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap" onmouseover="this.style.background='var(--gray200)'" onmouseout="this.style.background='var(--gray100)'">Hủy</button>
  </div>`;

  if (!positions.length) {
    html += `<div style="padding:32px;text-align:center;color:var(--gray400);font-size:14px">Chưa có vị thế nào. Nhập khối lượng và giá mua để bắt đầu theo dõi.</div>`;
    el.innerHTML = html;
    return;
  }

  // ── Tính toán tổng hợp ──
  const totalQty = positions.reduce((s, p) => s + p.qty, 0);
  const totalCost = positions.reduce((s, p) => s + p.qty * p.price, 0);
  const avgPrice = totalCost / totalQty;
  const marketValue = curPrice ? totalQty * curPrice : 0;
  const pnl = curPrice ? marketValue - totalCost : 0;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const pnlColor =
    pnl > 0 ? "var(--up)" : pnl < 0 ? "var(--dn)" : "var(--gray700)";
  const pnlSign = pnl > 0 ? "+" : "";

  // ── Tổng quan vị thế ──
  html += `
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
    <div style="padding:14px 18px;border-radius:12px;background:var(--navy-l);border:1px solid var(--gray200)">
<div style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:6px">TỔNG CP</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;color:var(--navy)">${totalQty.toLocaleString(
  "vi-VN"
)}</div>
    </div>
    <div style="padding:14px 18px;border-radius:12px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:6px">GIÁ VỐN TB</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;color:var(--gray900)">${fp(
  avgPrice
)}</div>
    </div>
    <div style="padding:14px 18px;border-radius:12px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:11px;font-weight:700;color:var(--gray400);letter-spacing:.6px;margin-bottom:6px">GIÁ TRỊ</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;color:var(--gray900)">${
  curPrice ? (marketValue / 1e3).toFixed(1) + " tr" : "—"
}</div>
<div style="font-size:11px;color:var(--gray400);margin-top:2px">Vốn: ${(
  totalCost / 1e3
).toFixed(1)} tr</div>
    </div>
    <div style="padding:14px 18px;border-radius:12px;background:${
pnl > 0 ? "var(--up-bg)" : pnl < 0 ? "var(--dn-bg)" : "var(--gray50)"
    };border:1px solid ${
    pnl > 0 ? "var(--up-bd)" : pnl < 0 ? "var(--dn-bd)" : "var(--gray200)"
  }">
<div style="font-size:11px;font-weight:700;color:${pnlColor};letter-spacing:.6px;margin-bottom:6px">LÃI / LỖ</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;color:${pnlColor}">${pnlSign}${(
    pnl / 1e3
  ).toFixed(2)} tr</div>
<div style="font-size:12px;font-weight:700;color:${pnlColor};margin-top:2px">${pnlSign}${pnlPct.toFixed(
    2
  )}%</div>
    </div>
  </div>`;

  // ── Form bán ──
  html += `
  <div id="pfSellFormWrap" style="display:none;margin-bottom:20px;padding:16px 20px;background:var(--dn-bg);border:1.5px solid var(--dn-bd);border-radius:12px">
    <div style="font-size:12px;font-weight:700;color:var(--dn);letter-spacing:.6px;margin-bottom:12px">BÁN CỔ PHIẾU — ${sym}</div>
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
<div>
  <label style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">KL BÁN (CP)</label>
  <input id="pfSellQty" type="number" min="100" step="100" placeholder="VD: 500" style="width:110px;padding:8px 12px;border:1px solid var(--dn-bd);border-radius:8px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;outline:none;background:var(--wht)"/>
</div>
<div>
  <label style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">GIÁ BÁN (nghìn đ)</label>
  <input id="pfSellPrice" type="number" min="0" step="0.05" placeholder="VD: 92.5" style="width:120px;padding:8px 12px;border:1px solid var(--dn-bd);border-radius:8px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;outline:none;background:var(--wht)"/>
</div>
<div>
  <label style="font-size:10px;font-weight:700;color:var(--gray400);letter-spacing:.6px;display:block;margin-bottom:4px">NGÀY BÁN</label>
  <input id="pfSellDate" type="date" value="${new Date()
    .toISOString()
    .slice(
      0,
      10
    )}" style="width:145px;padding:8px 12px;border:1px solid var(--dn-bd);border-radius:8px;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;outline:none;background:var(--wht)"/>
</div>
<button onclick="submitSell('${sym}')" style="padding:8px 20px;background:var(--dn);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">Xác nhận bán</button>
<button onclick="document.getElementById('pfSellFormWrap').style.display='none'" style="padding:8px 14px;background:var(--gray100);color:var(--gray700);border:1px solid var(--gray200);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Hủy</button>
    </div>
    <div id="pfSellPreview" style="margin-top:10px;font-size:13px;color:var(--gray500)"></div>
  </div>`;

  // ── Bảng chi tiết từng lệnh ──
  html += `<div style="margin-bottom:20px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
<div style="display:grid;grid-template-columns:28px 90px 70px 80px 90px 90px 130px 64px;flex:1;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:normal;color:var(--gray400);letter-spacing:0.4px;padding:5px 12px;background:var(--gray50);border-radius:10px;border-bottom:1px solid var(--gray200)">
  <span>#</span><span>Ngày</span><span style="text-align:right">KL</span><span style="text-align:right">Giá mua</span><span style="text-align:right">GT mua</span><span style="text-align:right">GT hiện tại</span><span style="text-align:right">Lãi / Lỗ</span><span></span>
</div>
<button onclick="document.getElementById('pfSellFormWrap').style.display=document.getElementById('pfSellFormWrap').style.display==='none'?'block':'none'" style="margin-left:10px;padding:8px 16px;background:var(--dn-bg);color:var(--dn);border:1.5px solid var(--dn-bd);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:5px" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="7 8 3 12 7 16"/><line x1="21" y1="12" x2="3" y2="12"/></svg>
  Bán
</button>
    </div>
    <div>`;
  positions.forEach((p, i) => {
    const pl = curPrice ? (curPrice - p.price) * p.qty : 0;
    const plPct =
      p.price > 0 ? ((curPrice - p.price) / p.price) * 100 : 0;
    const pc =
      pl > 0 ? "var(--up)" : pl < 0 ? "var(--dn)" : "var(--gray400)";
    const ps = pl > 0 ? "+" : "";
    const plBg =
      pl > 0 ? "#f0faf4" : pl < 0 ? "#fff5f5" : "var(--gray50)";
    html += `
    <div style="display:grid;grid-template-columns:28px 90px 70px 80px 90px 90px 130px 64px;padding:4px 12px;align-items:center;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;border-bottom:1px solid var(--gray100);transition:background .08s;cursor:default" onmouseover="this.style.background='#1e2a3a14'" onmouseout="this.style.background='transparent'">
<span style="color:var(--gray400)">${i + 1}</span>
<span style="color:var(--gray500)">${p.date}</span>
<span style="text-align:right;color:var(--navy);font-weight:700">${p.qty.toLocaleString("en-US")}</span>
<span style="text-align:right;color:var(--gray700)">${parseFloat(p.price.toFixed(2))}</span>
<span style="text-align:right;color:var(--gray500)">${parseFloat((p.qty * p.price / 1e3).toFixed(2))}<span style="color:var(--gray400)">tr</span></span>
<span style="text-align:right;color:var(--gray700)">${curPrice ? parseFloat((p.qty * curPrice / 1e3).toFixed(2)) : '—'}<span style="color:var(--gray400)">${curPrice ? 'tr' : ''}</span></span>
<span style="text-align:right">
  <span style="display:inline-flex;align-items:center;background:${plBg};padding:2px 7px;border-radius:5px;gap:4px">
    <span style="font-weight:700;color:${pc};white-space:nowrap">${ps}${parseFloat((pl / 1e3).toFixed(2))}tr</span>
    <span style="color:${pc};white-space:nowrap">(${ps}${parseFloat(plPct.toFixed(2))}%)</span>
  </span>
</span>
<span style="display:flex;gap:4px;justify-content:flex-end;opacity:0.4;transition:opacity .15s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.4'">
  <button onclick="editPosition('${sym}',${p.id},${p.qty},${p.price},'${
      p.date
    }')" style="width:26px;height:26px;border:1px solid var(--gray200);border-radius:7px;background:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s" onmouseover="this.style.background='#e8f4fd';this.style.borderColor='#90caf9'" onmouseout="this.style.background='white';this.style.borderColor='var(--gray200)'" title="Sửa">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1976d2" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
  </button>
  <button onclick="removePosition('${sym}',${
      p.id
    })" style="width:26px;height:26px;border:1px solid var(--gray200);border-radius:7px;background:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s" onmouseover="this.style.background='var(--dn-bg)';this.style.borderColor='var(--dn-bd)'" onmouseout="this.style.background='white';this.style.borderColor='var(--gray200)'" title="Xóa">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--dn)" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button>
</span>
    </div>`;
  });
  html += `</div></div>`;

  // ── Tư vấn chi tiết ──
  if (curPrice && analysisData) {
    const adv = generateAdvisory(
      avgPrice,
      curPrice,
      pnlPct,
      positions,
      analysisData
    );
    const tabs = [
      { id: "short", label: "NGẮN HẠN", icon: "⚡", period: "1-2 tuần",       adv: adv.short },
      { id: "mid",   label: "TRUNG HẠN", icon: "📈", period: "1-3 tháng",     adv: adv.mid },
      { id: "long",  label: "DÀI HẠN",   icon: "🏦", period: "6-12 tháng",   adv: adv.long },
      { id: "dca",   label: "DCA",        icon: "📊", period: "Chiến lược",    adv: adv.dca },
    ];
    const advTabFn = `switchAdvTab_${sym}`.replace(/[^a-zA-Z0-9_]/g, "_");

    // Đăng ký function trên window (script trong innerHTML không được execute)
    window[advTabFn] = function(id) {
      tabs.forEach(t => {
        const btn = document.getElementById(`advTab_${t.id}`);
        const pane = document.getElementById(`advPane_${t.id}`);
        if (btn) {
          btn.style.borderBottomColor = id === t.id ? "var(--navy)" : "transparent";
          btn.style.color = id === t.id ? "var(--navy)" : "var(--gray400)";
        }
        if (pane) pane.style.display = id === t.id ? "block" : "none";
      });
    };

    html += `
    <div style="border-top:2px solid var(--gray200);padding-top:16px">
      <div style="font-size:12px;font-weight:700;color:var(--gray500);letter-spacing:.8px;margin-bottom:10px">TƯ VẤN VỊ THẾ</div>
      <div style="display:flex;gap:4px;margin-bottom:12px;border-bottom:2px solid var(--gray100);padding-bottom:0">
        ${tabs.map((t, i) => `
        <button id="advTab_${t.id}" onclick="${advTabFn}('${t.id}')" style="display:flex;align-items:center;gap:5px;padding:8px 14px;border:none;border-bottom:2px solid ${i === 0 ? "var(--navy)" : "transparent"};margin-bottom:-2px;background:none;cursor:pointer;font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:${i === 0 ? "var(--navy)" : "var(--gray400)"};letter-spacing:.5px;transition:all .15s;white-space:nowrap">
          <span style="font-size:13px">${t.icon}</span>${t.label}
          <span style="font-size:10px;font-weight:400;color:var(--gray400)">${t.period}</span>
        </button>`).join("")}
      </div>
      <div>
        ${tabs.map((t, i) => `
        <div id="advPane_${t.id}" style="display:${i === 0 ? "block" : "none"};line-height:1.5">${t.adv.text}</div>`).join("")}
      </div>
    </div>`;
  }

  el.innerHTML = html;
}

function renderSR(sr, price) {
  const el = document.getElementById("srContent");
  if (!sr) {
    el.innerHTML =
      '<div style="font-size:14px;color:var(--gray400)">Không đủ dữ liệu</div>';
    return;
  }
  const lv = (l, t) => {
    const c = t === "resistance" ? "var(--dn)" : "var(--up)",
      d = (((l.price - price) / price) * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--gray100)">
<div style="display:flex;align-items:center;gap:8px"><div style="width:10px;height:10px;border-radius:50%;background:${c}"></div><span class="row-val" style="font-size:16px">${fp(
      l.price
    )}</span></div>
<div style="display:flex;gap:10px;align-items:center"><span style="font-size:13px;color:var(--gray400)">${
  l.touches
} lần test</span><span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${c}">${
      d > 0 ? "+" : ""
    }${d}%</span></div></div>`;
  };
  let h =
    '<div style="font-size:12px;font-weight:700;color:var(--dn);letter-spacing:1px;margin-bottom:6px">KHÁNG CỰ</div>';
  sr.resistances.forEach((r) => (h += lv(r, "resistance")));
  h +=
    '<div style="font-size:12px;font-weight:700;color:var(--up);letter-spacing:1px;margin-top:14px;margin-bottom:6px">HỖ TRỢ</div>';
  sr.supports.forEach((s) => (h += lv(s, "support")));
  if (!sr.resistances.length && !sr.supports.length)
    h =
      '<div style="font-size:14px;color:var(--gray400)">Chưa xác định</div>';
  el.innerHTML = h;
}

function renderPatterns(p) {
  const el = document.getElementById("patternsContent");
  if (!p?.length) {
    el.innerHTML =
      '<div style="font-size:14px;color:var(--gray400)">Không có mẫu hình</div>';
    return;
  }
  el.innerHTML = p
    .map((x) => {
      const c =
        x.signal === "bullish"
          ? "var(--up)"
          : x.signal === "bearish"
          ? "var(--dn)"
          : "var(--am)";
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--gray100)">
<div style="width:10px;height:10px;border-radius:50%;background:${c};flex-shrink:0"></div>
<div><div style="font-size:14px;font-weight:600;color:${c}">${x.name}</div><div style="font-size:13px;color:var(--gray500)">${x.desc}</div></div></div>`;
    })
    .join("");
}

function renderRS(rs) {
  const el = document.getElementById("rsContent");
  if (!rs) {
    el.innerHTML =
      '<div style="font-size:14px;color:var(--gray400)">Chưa có dữ liệu VNINDEX — chạy fetch VNINDEX trước</div>';
    return;
  }

  // ── Verdict config ────────────────────────────────────────────────────────
  const verdictCfg = {
    leader:      { bg: "var(--up-bg)",   color: "var(--up)",   icon: "★" },
    strong:      { bg: "var(--up-bg)",   color: "var(--up)",   icon: "↑" },
    mixed:       { bg: "var(--am-bg)",   color: "var(--am)",   icon: "~" },
    weak:        { bg: "var(--dn-bg)",   color: "var(--dn)",   icon: "↓" },
    laggard:     { bg: "var(--dn-bg)",   color: "var(--dn)",   icon: "▼" },
    unknown:     { bg: "var(--gray100)", color: "var(--gray500)", icon: "?" },
  };
  const vc = verdictCfg[rs.verdict] || verdictCfg.unknown;

  // RS Trend label
  const trendLabel = rs.rsTrend === "improving"
    ? `<span style="color:var(--up);font-weight:700;font-size:12px">↑ Đang tăng tốc</span>`
    : rs.rsTrend === "deteriorating"
    ? `<span style="color:var(--dn);font-weight:700;font-size:12px">↓ Đang chậm lại</span>`
    : rs.rsTrend === "stable"
    ? `<span style="color:var(--gray500);font-size:12px">→ Ổn định</span>`
    : "";

  // ── Summary header ────────────────────────────────────────────────────────
  let h = `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:${vc.bg};border:1px solid ${vc.color}20;margin-bottom:14px">
  <div style="font-size:22px;font-weight:900;color:${vc.color};min-width:28px;text-align:center">${vc.icon}</div>
  <div style="flex:1">
    <div style="font-size:14px;font-weight:700;color:${vc.color}">${rs.verdictDesc ?? "—"}</div>
    <div style="font-size:12px;color:var(--gray500);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap">
      ${rs.rsScore != null ? `<span>Mạnh hơn VNI <b>${rs.rsScore}%</b> số kỳ</span>` : ""}
      ${rs.beta != null ? `<span>Beta <b>${rs.beta}</b></span>` : ""}
      ${trendLabel}
    </div>
  </div>
</div>`;

  // ── Period grid ───────────────────────────────────────────────────────────
  h += `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px">`;
  rs.periods.forEach((p) => {
    const oc = p.outperform === true ? "var(--up)" : p.outperform === false ? "var(--dn)" : "var(--gray400)";
    const obg = p.outperform === true ? "var(--up-bg)" : p.outperform === false ? "var(--dn-bg)" : "var(--gray100)";
    const alphaSign = p.alpha != null ? (p.alpha > 0 ? "+" : "") : "";
    const alphaColor = p.alpha > 0 ? "var(--up)" : p.alpha < 0 ? "var(--dn)" : "var(--gray400)";
    h += `<div style="text-align:center;padding:12px 6px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:11px;color:var(--gray500);font-weight:600;margin-bottom:5px">${p.label}</div>
<div style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;color:${p.stockPct > 0 ? "var(--up)" : "var(--dn)"}">${p.stockPct > 0 ? "+" : ""}${p.stockPct}%</div>
<div style="font-size:11px;color:var(--gray400);margin-top:3px">VNI: ${p.indexPct != null ? (p.indexPct > 0 ? "+" : "") + p.indexPct + "%" : "—"}</div>
${p.alpha != null ? `<div style="font-size:11px;font-weight:700;color:${alphaColor};margin-top:2px">α ${alphaSign}${p.alpha}%</div>` : ""}
<div style="margin-top:5px;display:inline-block;padding:2px 7px;border-radius:20px;background:${obg};font-size:10px;font-weight:700;color:${oc}">${
      p.outperform === true ? "Mạnh hơn" : p.outperform === false ? "Yếu hơn" : "—"
    }</div></div>`;
  });
  h += `</div>`;

  // ── Stats row: correlation + beta ─────────────────────────────────────────
  const corrLabel = rs.correlation != null
    ? (rs.correlation > 0.6 ? "Tương quan chặt" : rs.correlation > 0.3 ? "Tương quan TB" : "Tương quan yếu")
    : null;
  const betaDesc = rs.beta != null
    ? `VNI ±10% → cổ phiếu thường ±${Math.round(Math.abs(rs.beta) * 10)}%`
    : null;

  if (corrLabel || betaDesc) {
    h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">`;
    if (corrLabel) {
      h += `<div style="padding:10px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200);display:flex;justify-content:space-between;align-items:center">
<div><div style="font-size:11px;color:var(--gray500);font-weight:600">TƯƠNG QUAN VỚI VNI</div><div style="font-size:12px;color:var(--gray600);margin-top:1px">${corrLabel}</div></div>
<span style="font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;color:var(--navy)">${rs.correlation}</span></div>`;
    }
    if (betaDesc) {
      const betaColor = rs.beta > 1.3 ? "var(--am)" : rs.beta < 0.7 ? "var(--up)" : "var(--navy)";
      h += `<div style="padding:10px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:11px;color:var(--gray500);font-weight:600;margin-bottom:4px">ĐỘ BIẾN ĐỘNG SO VỚI THỊ TRƯỜNG</div>
<div style="font-size:12px;color:var(--gray700)">${betaDesc}</div></div>`;
    }
    h += `</div>`;
  }

  // ── Đánh giá chi tiết ─────────────────────────────────────────────────────
  const outCount = rs.periods.filter(p => p.outperform === true).length;
  const totalValid = rs.periods.filter(p => p.outperform !== null).length;
  const bestPeriod = [...rs.periods].filter(p => p.alpha != null).sort((a, b) => b.alpha - a.alpha)[0];
  const worstPeriod = [...rs.periods].filter(p => p.alpha != null).sort((a, b) => a.alpha - b.alpha)[0];

  const insights = [];
  if (outCount === totalValid) insights.push("Mạnh hơn VNINDEX ở <b>tất cả các kỳ</b> — cổ phiếu dẫn đầu thị trường.");
  else if (outCount === 0) insights.push("Yếu hơn VNINDEX ở <b>tất cả các kỳ</b> — tránh hoặc chờ tín hiệu phục hồi.");
  else insights.push(`Mạnh hơn VNINDEX trong <b>${outCount}/${totalValid} kỳ</b> đo lường.`);

  if (bestPeriod) insights.push(`Kỳ tốt nhất: <b>${bestPeriod.label}</b> với alpha <b>${bestPeriod.alpha > 0 ? "+" : ""}${bestPeriod.alpha}%</b>.`);
  if (worstPeriod && worstPeriod.label !== bestPeriod?.label) insights.push(`Kỳ yếu nhất: <b>${worstPeriod.label}</b> với alpha <b>${worstPeriod.alpha > 0 ? "+" : ""}${worstPeriod.alpha}%</b>.`);

  if (rs.rsTrend === "improving") insights.push("Hiệu suất ngắn hạn <b>tốt hơn</b> dài hạn — cổ phiếu đang tăng tốc so với thị trường.");
  else if (rs.rsTrend === "deteriorating") insights.push("Hiệu suất ngắn hạn <b>kém hơn</b> dài hạn — cổ phiếu đang chậm lại so với thị trường, cần thận trọng.");

  if (rs.beta != null) {
    if (rs.beta > 1.3) insights.push(`VNI giảm 10% thì cổ phiếu thường giảm ~<b>${Math.round(rs.beta * 10)}%</b> — biến động mạnh, rủi ro cao hơn thị trường.`);
    else if (rs.beta < 0.7) insights.push(`VNI giảm 10% thì cổ phiếu thường chỉ giảm ~<b>${Math.round(rs.beta * 10)}%</b> — ít biến động, tương đối an toàn hơn.`);
  }

  if (insights.length > 0) {
    h += `<div style="padding:12px 14px;border-radius:10px;background:var(--gray50);border:1px solid var(--gray200)">
<div style="font-size:11px;font-weight:700;color:var(--gray500);letter-spacing:.6px;margin-bottom:8px">NHẬN XÉT</div>
<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:5px">
${insights.map(i => `<li style="font-size:13px;color:var(--gray700);line-height:1.4">${i}</li>`).join("")}
</ul></div>`;
  }

  el.innerHTML = h;
}

function destroyCharts() {
  [
    mainChartInstance,
    rsiChartInstance,
    macdChartInstance,
    miniChartInstance,
  ].forEach((c) => c?.destroy());
  mainChartInstance =
    rsiChartInstance =
    macdChartInstance =
    miniChartInstance =
      null;
}

let _prevRt = {};
function flashEl(el, up) {
  if (!el) return;
  el.classList.remove("rt-flash-up", "rt-flash-dn");
  void el.offsetWidth;
  el.classList.add(up ? "rt-flash-up" : "rt-flash-dn");
}
function fvol(v) {
  if (v == null) return "—";
  return Math.round(v).toLocaleString("vi-VN");
}

// Picture-in-Picture ticker
let _pipWin = null;
let _pipState = {
  sym: "—",
  price: null,
  change: null,
  changePct: null,
  isUp: true,
};

function _pipUpColor(isUp, change) {
  return change == null || change === 0
    ? "#f08c00"
    : isUp
    ? "#2f9e44"
    : "#e03131";
}
function _pipBgColor(isUp, change) {
  return change == null || change === 0
    ? "#fff9db"
    : isUp
    ? "#ebfbee"
    : "#fff5f5";
}
function _pipHtml(s) {
  const col = _pipUpColor(s.isUp, s.change);
  const bg = _pipBgColor(s.isUp, s.change);
  const sign = s.change > 0 ? "+" : "";
  const chTxt =
    s.change != null && s.changePct != null
      ? `${sign}${fp(s.change)} (${sign}${s.changePct.toFixed(2)}%)`
      : "—";
  return `<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%}
body{background:${bg};display:flex;align-items:center;padding:0 14px;gap:10px;overflow:hidden}
.sym{font-family:system-ui,sans-serif;font-weight:800;font-size:11px;color:#1a1f5e;flex-shrink:0}
.price{font-family:Tahoma,Helvetica,Arial,sans-serif;font-weight:800;font-size:22px;letter-spacing:-1px;color:${col};flex-shrink:0;white-space:nowrap}
.change{font-family:Tahoma,Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;color:${col};white-space:nowrap;flex-shrink:0}
  </style>
  <div class="sym">${s.sym}</div>
  <div class="price">${s.price != null ? fp(s.price) : "—"}</div>
  <div class="change">${chTxt}</div>`;
}

function _pipUpdate() {
  if (!_pipWin || _pipWin.closed) return;
  _pipWin.document.body.innerHTML = _pipHtml(_pipState);
}

async function openPip() {
  if (_pipWin && !_pipWin.closed) {
    _pipWin.close();
    _pipWin = null;
    return;
  }
  try {
    if ("documentPictureInPicture" in window) {
      const pip = await window.documentPictureInPicture.requestWindow({
        width: 130,
        height: 77,
      });
      _pipWin = pip;
      pip.document.body.innerHTML = _pipHtml(_pipState);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@600;700;800&display=swap";
      pip.document.head.appendChild(link);
      pip.addEventListener("pagehide", () => {
        _pipWin = null;
      });
    } else {
      // Fallback: popup window
      const w = window.open(
        "",
        "_pipStock",
        "width=220,height=110,alwaysOnTop=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no"
      );
      if (!w) return;
      _pipWin = w;
      w.document.write(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${
          _pipState.sym
        }</title></head><body>${_pipHtml(_pipState)}</body></html>`
      );
      w.document.close();
      w.addEventListener("beforeunload", () => {
        _pipWin = null;
      });
    }
  } catch (e) {
    console.error("PiP error", e);
  }
}

function setPipData(sym, price, change, changePct, isUp) {
  _pipState = { sym, price, change, changePct, isUp };
  _pipUpdate();
}

function updateChartsWithRealtime(rt) {
  if (!mainChartInstance || !rt?.price) return;
  // Xóa dataset live cũ nếu có
  mainChartInstance.data.datasets =
    mainChartInstance.data.datasets.filter((d) => !d._isRealtime);
  const n = mainChartInstance.data.labels.length;
  const isUp = rt.change == null || rt.change >= 0;
  const color = isUp ? "rgba(47,158,68,0.9)" : "rgba(224,49,49,0.9)";
  mainChartInstance.data.datasets.push({
    type: "line",
    _isRealtime: true,
    label: `Live ${fp(rt.price)}`,
    data: Array(n).fill(rt.price),
    borderColor: color,
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    pointHitRadius: 0,
    fill: false,
    tension: 0,
    yAxisID: "yP",
    order: 0,
  });
  mainChartInstance.update("none");
}
function setChartRange(n) {
  chartRange = n;
  document.querySelectorAll(".cb").forEach((b) => {
    b.style.background = "var(--wht)";
    b.style.color = "var(--gray500)";
    b.style.borderColor = "var(--gray200)";
  });
  const a = document.getElementById("cr" + n);
  if (a) {
    a.style.background = "var(--navy)";
    a.style.color = "#fff";
    a.style.borderColor = "var(--navy)";
  }
  if (analysisData) renderCharts(analysisData);
}
function setChartType(t) {
  chartType = t;
  const btnLine = document.getElementById("ctLine"),
    btnCandle = document.getElementById("ctCandle");
  if (t === "candle") {
    btnCandle.style.background = "var(--navy)";
    btnCandle.style.color = "#fff";
    btnLine.style.background = "var(--wht)";
    btnLine.style.color = "var(--gray500)";
  } else {
    btnLine.style.background = "var(--navy)";
    btnLine.style.color = "#fff";
    btnCandle.style.background = "var(--wht)";
    btnCandle.style.color = "var(--gray500)";
  }
  if (analysisData) renderCharts(analysisData);
}
// ── Trendlines ────────────────────────────────────────────────────────────
let showTrendlines = true;
function toggleTrendlines() {
  showTrendlines = !showTrendlines;
  const btn = document.getElementById("ctTrendline");
  if (btn) {
    btn.style.background = showTrendlines ? "var(--navy)" : "var(--wht)";
    btn.style.color = showTrendlines ? "#fff" : "var(--gray500)";
    btn.style.borderColor = showTrendlines ? "var(--navy)" : "var(--gray200)";
  }
  if (mainChartInstance) mainChartInstance.update("none");
}

// Tìm swing highs/lows có prominence đủ lớn
// win: số phiên tối thiểu mỗi bên để coi là swing
// minProminencePct: đỉnh phải nổi hơn vùng xung quanh ít nhất X%
function findSwings(highs, lows, win) {
  const n = highs.length;
  const swingHighs = [], swingLows = [];

  for (let i = win; i < n - win; i++) {
    // Swing High: highs[i] cao hơn TẤT CẢ điểm trong cửa sổ
    const h = highs[i];
    if (h == null) continue;
    let isHigh = true;
    for (let j = i - win; j <= i + win; j++) {
      if (j !== i && highs[j] != null && highs[j] >= h) { isHigh = false; break; }
    }
    if (isHigh) {
      // Tính prominence: khoảng cách từ đỉnh xuống đáy gần nhất trong cửa sổ rộng hơn
      const localMin = Math.min(...lows.slice(Math.max(0, i - win * 2), i + win * 2 + 1).filter(v => v != null));
      const prominence = (h - localMin) / h;
      swingHighs.push({ i, v: h, prominence });
    }

    // Swing Low: lows[i] thấp hơn TẤT CẢ điểm trong cửa sổ
    const l = lows[i];
    if (l == null) continue;
    let isLow = true;
    for (let j = i - win; j <= i + win; j++) {
      if (j !== i && lows[j] != null && lows[j] <= l) { isLow = false; break; }
    }
    if (isLow) {
      const localMax = Math.max(...highs.slice(Math.max(0, i - win * 2), i + win * 2 + 1).filter(v => v != null));
      const prominence = (localMax - l) / localMax;
      swingLows.push({ i, v: l, prominence });
    }
  }
  return { swingHighs, swingLows };
}

// Chọn 2 đỉnh/đáy nổi bật nhất để vẽ trendline
// Ưu tiên: prominence cao + gần cuối chart
function pickBestPair(swings, n) {
  if (swings.length < 2) return null;
  // Lọc chỉ lấy swings có prominence >= 1.5% để tránh nhiễu
  const significant = swings.filter(s => s.prominence >= 0.015);
  if (significant.length < 2) return swings.slice(-2); // fallback
  // Lấy 2 swing gần nhất
  return significant.slice(-2);
}

function computeTrendlines(highs, lows) {
  const n = highs.length;
  // Window thích nghi: ~8% của chiều dài, tối thiểu 5 phiên
  const win = Math.max(5, Math.round(n * 0.08));
  const { swingHighs, swingLows } = findSwings(highs, lows, win);
  const lines = [];

  const resPair = pickBestPair(swingHighs, n);
  if (resPair && resPair.length === 2) {
    lines.push({ type: "resistance", x1: resPair[0].i, y1: resPair[0].v, x2: resPair[1].i, y2: resPair[1].v });
  }

  const supPair = pickBestPair(swingLows, n);
  if (supPair && supPair.length === 2) {
    lines.push({ type: "support", x1: supPair[0].i, y1: supPair[0].v, x2: supPair[1].i, y2: supPair[1].v });
  }

  return lines;
}

function renderCharts(d) {
  destroyCharts();
  const c = d.chart,
    len = Math.min(chartRange, c.labels.length),
    sl = (a) => (a ? a.slice(-len) : []);
  const labels = sl(c.labels),
    prices = sl(c.prices),
    opens = sl(c.opens),
    highs = sl(c.highs),
    lows = sl(c.lows);
  const vol = sl(c.volumes),
    m20 = sl(c.ma20),
    m50 = sl(c.ma50);
  const bU = sl(c.bbUpper),
    bM = sl(c.bbMid),
    bL = sl(c.bbLower),
    rD = sl(c.rsi),
    mD = sl(c.macdHist);
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#fff",
        titleColor: "#1a1a2e",
        bodyColor: "#4a5568",
        borderColor: "#e5e7eb",
        borderWidth: 1,
        padding: 12,
        bodyFont: { family: "Tahoma", size: 12 },
        titleFont: { family: "'Noto Sans'", weight: "bold", size: 13 },
      },
    },
  };

  // ── Mini chart (line, always) ────────────────────────────────────────────
  miniChartInstance = new Chart(document.getElementById("miniChart"), {
    type: "line",
    data: {
      labels: c.labels.slice(-66),
      datasets: [
        {
          data: c.prices.slice(-66),
          borderColor: "#003a6b",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: { target: "origin", above: "rgba(0,58,107,.06)" },
        },
      ],
    },
    options: {
      ...base,
      scales: { x: { display: false }, y: { display: false } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
    },
  });

  // ── Volume colors ────────────────────────────────────────────────────────
  // Candle mode: xanh dương / xám — tách biệt hẳn với màu nến xanh lá / đỏ
  // Line mode: xanh lá / đỏ nhạt theo chiều giá
  const vc =
    chartType === "candle"
      ? vol.map((v, i) => {
          const o = opens[i],
            cl = prices[i];
          return o == null || cl == null || cl >= o
            ? "rgba(59,130,246,.45)"
            : "rgba(148,163,184,.4)";
        })
      : vol.map((v, i) =>
          i === 0
            ? "rgba(0,0,0,.06)"
            : prices[i] >= prices[i - 1]
            ? "rgba(47,158,68,.25)"
            : "rgba(224,49,49,.25)"
        );

  if (chartType === "candle") {
    // ── Candlestick mode — dùng line dataset + custom plugin (giống surge.html) ──
    const candleData = labels.map((lbl, i) => ({
      x: i,
      y: prices[i],
      o: opens[i] ?? prices[i],
      h: highs[i] ?? prices[i],
      l: lows[i] ?? prices[i],
      c: prices[i],
    }));
    const allPV = [
      ...highs,
      ...lows,
      ...bU,
      ...bL,
      ...m20,
      ...m50,
    ].filter((v) => v != null);
    const pMin = Math.min(...allPV),
      pMax = Math.max(...allPV),
      pPad = (pMax - pMin) * 0.05;

    // Giới hạn trục volume: max = maxVol * 8 → volume chỉ chiếm ~12% dưới cùng
    const maxVol = Math.max(...vol.filter((v) => v != null), 1);
    const volAxisMax = maxVol * 8;

    // Thêm padding bottom cho trục giá: đẩy nến lên cao hơn vùng volume
    // pMin thực tế + 15% khoảng giá làm vùng đệm dưới cùng
    const priceRange = pMax - pMin;
    const pMinPadded = pMin - priceRange * 0.18;

    const candleTooltip = {
      ...base.plugins.tooltip,
      callbacks: {
        title: (items) => {
          const i = items[0].dataIndex;
          return labels[i] ?? "";
        },
        label: (item) => {
          if (item.dataset.label === "Nến") {
            const d = candleData[item.dataIndex];
            if (!d) return "";
            return [
              `O: ${fp(d.o)}`,
              `H: ${fp(d.h)}`,
              `L: ${fp(d.l)}`,
              `C: ${fp(d.c)}`,
            ];
          }
          const v = item.parsed?.y;
          if (v == null) return null;
          const lb = item.dataset.label || "";
          return lb ? `${lb}: ${fp(v)}` : `${fp(v)}`;
        },
      },
    };

    mainChartInstance = new Chart(document.getElementById("mainChart"), {
      data: {
        labels,
        datasets: [
          {
            type: "line",
            label: "Nến",
            data: candleData,
            yAxisID: "yP",
            order: 1,
            borderColor: "transparent",
            backgroundColor: "transparent",
            borderWidth: 0,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0,
            spanGaps: true,
          },
          {
            type: "bar",
            data: vol,
            backgroundColor: vc,
            yAxisID: "y",
            order: 5,
          },
          {
            type: "line",
            label: "BB U",
            data: bU,
            borderColor: "rgba(99,102,241,.3)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            tension: 0.3,
            fill: "+2",
            backgroundColor: "rgba(99,102,241,.04)",
            yAxisID: "yP",
            order: 4,
            spanGaps: true,
          },
          {
            type: "line",
            label: "BB M",
            data: bM,
            borderColor: "rgba(99,102,241,.5)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: "yP",
            order: 3,
            spanGaps: true,
          },
          {
            type: "line",
            label: "BB L",
            data: bL,
            borderColor: "rgba(99,102,241,.3)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: "yP",
            order: 4,
            spanGaps: true,
          },
          {
            type: "line",
            label: "MA20",
            data: m20,
            borderColor: "rgba(245,158,11,.8)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: "yP",
            order: 2,
            spanGaps: true,
          },
          {
            type: "line",
            label: "MA50",
            data: m50,
            borderColor: "rgba(236,72,153,.7)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: "yP",
            order: 2,
            spanGaps: true,
          },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...candleTooltip } },
        scales: {
          x: {
            ticks: {
              maxTicksLimit: 10,
              font: { size: 11, family: "Tahoma" },
              color: "#9ca3af",
            },
            grid: { color: "rgba(0,0,0,.04)" },
          },
          y: {
            position: "left",
            max: volAxisMax,
            ticks: {
              maxTicksLimit: 3,
              font: { size: 11, family: "Tahoma" },
              color: "#94a3b8",
              callback: (v) =>
                v >= 1e6
                  ? (v / 1e6).toFixed(1) + "M"
                  : v >= 1e3
                  ? (v / 1e3).toFixed(0) + "K"
                  : v,
            },
            grid: { color: "rgba(0,0,0,.03)" },
          },
          yP: {
            position: "right",
            min: pMinPadded,
            max: pMax + pPad,
            ticks: {
              font: { size: 11, family: "Tahoma" },
              color: "#6b7280",
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
    mainChartInstance._srLevels = d.chart.srLevels || null;
    mainChartInstance._trendlines = computeTrendlines(highs, lows);
  } else {
    // ── Line mode (original) ─────────────────────────────────────────────
    mainChartInstance = new Chart(document.getElementById("mainChart"), {
      data: {
        labels,
        datasets: [
          {
            type: "bar",
            data: vol,
            backgroundColor: vc,
            yAxisID: "y",
            order: 5,
          },
          {
            type: "line",
            data: bU,
            borderColor: "rgba(99,102,241,.3)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            tension: 0.3,
            fill: "+2",
            backgroundColor: "rgba(99,102,241,.03)",
            yAxisID: "yP",
            order: 4,
          },
          {
            type: "line",
            data: bM,
            borderColor: "rgba(99,102,241,.45)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: "yP",
            order: 3,
          },
          {
            type: "line",
            data: bL,
            borderColor: "rgba(99,102,241,.3)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: "yP",
            order: 4,
          },
          {
            type: "line",
            data: m20,
            borderColor: "rgba(245,158,11,.7)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: "yP",
            order: 2,
          },
          {
            type: "line",
            data: m50,
            borderColor: "rgba(236,72,153,.6)",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: "yP",
            order: 2,
          },
          {
            type: "line",
            data: prices,
            borderColor: "#003a6b",
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: "yP",
            order: 1,
          },
        ],
      },
      options: {
        ...base,
        scales: {
          x: {
            ticks: {
              maxTicksLimit: 10,
              font: { size: 11, family: "Tahoma" },
              color: "#9ca3af",
            },
            grid: { color: "rgba(0,0,0,.04)" },
          },
          y: {
            position: "left",
            ticks: {
              maxTicksLimit: 5,
              font: { size: 11, family: "Tahoma" },
              color: "#9ca3af",
              callback: (v) =>
                v >= 1e6
                  ? (v / 1e6).toFixed(1) + "M"
                  : v >= 1e3
                  ? (v / 1e3).toFixed(0) + "K"
                  : v,
            },
            grid: { color: "rgba(0,0,0,.04)" },
          },
          yP: {
            position: "right",
            ticks: {
              font: { size: 11, family: "Tahoma" },
              color: "#6b7280",
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
    mainChartInstance._srLevels = d.chart.srLevels || null;
    mainChartInstance._trendlines = computeTrendlines(
      highs.map((v, i) => v ?? prices[i]),
      lows.map((v, i)  => v ?? prices[i])
    );
  }

  rsiChartInstance = new Chart(document.getElementById("rsiChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data: rD,
          borderColor: "#003a6b",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          segment: {
            borderColor: (ctx) => {
              const v = ctx.p1.parsed.y;
              return v > 70 ? "#e03131" : v < 30 ? "#2f9e44" : "#003a6b";
            },
          },
        },
        {
          data: labels.map(() => 70),
          borderColor: "rgba(224,49,49,.2)",
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
        },
        {
          data: labels.map(() => 30),
          borderColor: "rgba(47,158,68,.2)",
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      ...base,
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 35,
            font: { size: 10, family: "Tahoma" },
            color: "#9ca3af",
          },
          grid: { color: "rgba(0,0,0,.04)" },
        },
      },
    },
  });
  macdChartInstance = new Chart(document.getElementById("macdChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: mD,
          backgroundColor: mD.map((v) =>
            v > 0 ? "rgba(47,158,68,.4)" : "rgba(224,49,49,.4)"
          ),
        },
      ],
    },
    options: {
      ...base,
      scales: {
        x: { display: false },
        y: {
          ticks: {
            maxTicksLimit: 3,
            font: { size: 10, family: "Tahoma" },
            color: "#9ca3af",
          },
          grid: { color: "rgba(0,0,0,.04)" },
        },
      },
    },
  });
  // Áp dụng lại đường giá live nếu đang có realtime data
  if (realtimePriceData) updateChartsWithRealtime(realtimePriceData);
}
// ── Candlestick plugin (vẽ nến bằng Canvas API, không cần thư viện ngoài) ──
Chart.register({
  id: "candlestick",
  afterDatasetsDraw(chart) {
    const dsIdx = chart.data.datasets.findIndex((d) => d.label === "Nến");
    if (dsIdx === -1) return;
    const ds = chart.data.datasets[dsIdx];
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(dsIdx);
    const yScale = chart.scales["yP"];
    if (!yScale) return;
    const n = ds.data.length;
    const chartW = chart.chartArea.width;
    const rawW = n > 0 ? (chartW / n) * 0.7 : 6;
    const half = Math.max(Math.floor(rawW / 2), 1);
    ds.data.forEach((d, i) => {
      if (!d || d.o == null || d.h == null || d.l == null || d.c == null)
        return;
      const el = meta.data[i];
      if (!el) return;
      const x = el.x;
      const yO = yScale.getPixelForValue(d.o);
      const yC = yScale.getPixelForValue(d.c);
      const yH = yScale.getPixelForValue(d.h);
      const yL = yScale.getPixelForValue(d.l);
      const isUp = d.c >= d.o;
      const color = isUp ? "#2f9e44" : "#e03131";
      const bodyTop = Math.min(yO, yC);
      const bodyBot = Math.max(yO, yC);
      const bodyH = Math.max(bodyBot - bodyTop, 1);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, bodyTop);
      ctx.moveTo(x, bodyBot);
      ctx.lineTo(x, yL);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.fillRect(x - half, bodyTop, half * 2, bodyH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - half, bodyTop, half * 2, bodyH);
      ctx.restore();
    });
  },
});

// ── Trendline plugin ─────────────────────────────────────────────────────────
Chart.register({
  id: "trendlinePlugin",
  afterDraw(chart) {
    if (!showTrendlines) return;
    const lines = chart._trendlines;
    if (!lines || !lines.length) return;
    const yScale = chart.scales["yP"];
    if (!yScale) return;
    // Dùng x-scale trực tiếp — đáng tin cậy hơn meta.data[i].x
    const xScale = chart.scales["x"];
    if (!xScale) return;
    const labels = chart.data.labels;
    const n = labels.length;
    // Lấy pixel x theo index — dùng getPixelForValue với label string
    const getX = (i) => {
      const idx = Math.max(0, Math.min(n - 1, i));
      return xScale.getPixelForValue(labels[idx]);
    };
    const getY = (v) => yScale.getPixelForValue(v);
    const { top, bottom, left, right } = chart.chartArea;
    const ctx = chart.ctx;

    lines.forEach((line) => {
      const isRes = line.type === "resistance";
      const color    = isRes ? "rgba(224,49,49,.8)"  : "rgba(47,158,68,.8)";
      const colorDot = isRes ? "#e03131" : "#2f9e44";
      const colorFill= isRes ? "rgba(224,49,49,.07)" : "rgba(47,158,68,.07)";
      const dx = line.x2 - line.x1;
      if (dx === 0) return;
      // slope tính theo đơn vị giá / phiên (index space)
      const slope = (line.y2 - line.y1) / dx;

      // x pixel của 2 điểm neo (chính xác 100% vì lấy từ scale)
      const xPx1 = getX(line.x1);
      const xPx2 = getX(line.x2);
      const yPx1 = getY(line.y1);
      const yPx2 = getY(line.y2);

      // Kéo dài từ điểm đầu tiên ra tới mép phải chart
      // y tại mép phải (index n-1)
      const yValRight = line.y1 + slope * ((n - 1) - line.x1);
      const xPxRight  = getX(n - 1);
      const yPxRight  = getY(yValRight);

      // Kéo ngược về bên trái một chút (từ peak 1 về ~10% để tạo context)
      const extLeft = Math.max(0, line.x1 - Math.round(n * 0.08));
      const yValLeft = line.y1 + slope * (extLeft - line.x1);
      const xPxLeft  = getX(extLeft);
      const yPxLeft  = getY(yValLeft);

      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, right - left, bottom - top);
      ctx.clip();

      // ── Vùng fill nhạt dưới/trên đường ──
      ctx.beginPath();
      ctx.moveTo(xPxLeft, yPxLeft);
      ctx.lineTo(xPxRight, yPxRight);
      if (isRes) {
        ctx.lineTo(xPxRight, top);
        ctx.lineTo(xPxLeft, top);
      } else {
        ctx.lineTo(xPxRight, bottom);
        ctx.lineTo(xPxLeft, bottom);
      }
      ctx.closePath();
      ctx.fillStyle = colorFill;
      ctx.fill();

      // ── Đường trendline: solid giữa 2 đỉnh, dashed phần kéo dài ──
      // Phần kéo dài bên trái (dashed mờ)
      ctx.beginPath();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.45;
      ctx.moveTo(xPxLeft, yPxLeft);
      ctx.lineTo(xPx1, yPx1);
      ctx.stroke();

      // Phần giữa 2 đỉnh (solid đậm)
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.moveTo(xPx1, yPx1);
      ctx.lineTo(xPx2, yPx2);
      ctx.stroke();

      // Phần kéo dài bên phải (dashed)
      ctx.beginPath();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.65;
      ctx.moveTo(xPx2, yPx2);
      ctx.lineTo(xPxRight, yPxRight);
      ctx.stroke();

      // ── Label ở mép phải ──
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const labelText = isRes ? "Kháng cự" : "Hỗ trợ";
      ctx.font = "bold 10px Tahoma";
      const textW = ctx.measureText(labelText).width;
      const lx = Math.min(xPxRight + 4, right - textW - 4);
      const ly = Math.max(top + 12, Math.min(bottom - 4, yPxRight + 4));
      // Badge nhỏ
      ctx.fillStyle = colorFill.replace(".07", ".55");
      ctx.beginPath();
      ctx.roundRect(lx - 2, ly - 11, textW + 8, 14, 3);
      ctx.fill();
      ctx.fillStyle = colorDot;
      ctx.fillText(labelText, lx + 2, ly);

      // ── Chấm tròn tại đỉnh/đáy (vẽ SAU cùng để đè lên đường) ──
      [[line.x1, line.y1], [line.x2, line.y2]].forEach(([xi, yi]) => {
        const px = getX(xi);
        const py = getY(yi);
        // Vòng ngoài mờ
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = colorFill.replace(".07", ".3");
        ctx.fill();
        // Chấm giữa
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = colorDot;
        ctx.globalAlpha = 1;
        ctx.fill();
        // Viền trắng
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      ctx.restore();
    });
  },
});

// ─── Vietnam trading hours & MSH realtime price ──────────────────────────────
function getVNDate() {
  const now = new Date();
  return new Date(now.getTime() + 7 * 3600 * 1000);
}
function isVNTradingHours() {
  const vn = getVNDate();
  const total = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return total >= 9 * 60 && total < 15 * 60;
}
function isAfterVNClose() {
  const vn = getVNDate();
  return vn.getUTCHours() * 60 + vn.getUTCMinutes() >= 15 * 60;
}
function vnDateStr() {
  return getVNDate().toISOString().slice(0, 10);
}

function getMshCache(sym) {
  try {
    const r = localStorage.getItem(`msh_rt_${sym}_${vnDateStr()}`);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}
function setMshCache(sym, data) {
  try {
    localStorage.setItem(
      `msh_rt_${sym}_${vnDateStr()}`,
      JSON.stringify({ data, cachedAt: new Date().toISOString() })
    );
  } catch {}
}

function closeMshStream() {
  if (mshEventSource) {
    mshEventSource.close();
    mshEventSource = null;
  }
}

function showRealtimeBadgeLoading() {
  const badge = document.getElementById("realtimeBadge");
  if (!badge) return;
  badge.style.display = "flex";
  badge.innerHTML = `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:var(--gray100);border:1px solid var(--gray200);color:var(--gray500)">
<span style="width:6px;height:6px;border-radius:50%;background:var(--gray400);display:inline-block;animation:blink 1.2s infinite"></span> Đang kết nối…
  </div>
  <button id="mshRefreshBtn" onclick="refreshRealtimePrice()" title="Lấy giá mới nhất"
style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:1px solid var(--gray200);background:var(--wht);color:var(--gray500);cursor:pointer;padding:0;transition:all .15s;flex-shrink:0"
onmouseenter="this.style.borderColor='var(--navy)';this.style.color='var(--navy)'" onmouseleave="this.style.borderColor='var(--gray200)';this.style.color='var(--gray500)'">
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
  </button>`;
}

function loadRealtimePrice(sym) {
  closeMshStream();
  showRealtimeBadgeLoading();
  if (isVNTradingHours()) {
    // Giờ giao dịch: dùng SSE — server poll MSH 1 lần mỗi 10s, push về browser
    mshEventSource = new EventSource(
      `${SERVER}/msh-stream?symbol=${sym}`
    );
    mshEventSource.onmessage = (e) => {
      try {
        // Server gửi data đã parse: {price, change, changePct, ref, open, high, low, volume}
        const data = JSON.parse(e.data);
        if (data?.price) {
          setMshCache(sym, data);
          renderRealtimePrice(data, sym, false, null);
        }
      } catch {}
    };
    mshEventSource.onerror = () => {
      // Kết nối lỗi → fallback cache
      const cached = getMshCache(sym);
      if (cached?.data)
        renderRealtimePrice(cached.data, sym, true, cached.cachedAt);
    };
  } else if (isAfterVNClose()) {
    // Sau 15:00: chỉ dùng cache localStorage
    const cached = getMshCache(sym);
    if (cached?.data)
      renderRealtimePrice(cached.data, sym, true, cached.cachedAt);
    else {
      // Không có cache, vẫn giữ badge với nút refresh
      const badge = document.getElementById("realtimeBadge");
      if (badge) {
        badge.style.display = "flex";
        badge.innerHTML = badge.innerHTML.replace(
          "Đang kết nối…",
          "Sau giờ giao dịch"
        );
      }
    }
  }
}

function renderRealtimePrice(data, sym, fromCache, cachedAt) {
  realtimePriceData = data;
  updateChartsWithRealtime(data);

  // Helper: cập nhật giá trị + flash nếu thay đổi
  function setRtVal(id, newText, isUp) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== newText && el.textContent !== "—") {
      flashEl(el, isUp);
    }
    el.textContent = newText;
  }

  const isUp = data.change == null || data.change >= 0;

  if (data.price != null) {
    const el = document.getElementById("priceDisplay");
    if (el) {
      const newTxt = fp(data.price);
      const changed = el.textContent !== newTxt && el.textContent !== "—";
      el.textContent = newTxt;
      el.style.color = isUp ? "var(--up)" : "var(--dn)";
      if (changed) flashEl(el, isUp);
    }
  }
  if (data.change != null && data.changePct != null) {
    const el = document.getElementById("changeDisplay");
    if (el) {
      const s = data.change > 0 ? "+" : "";
      el.textContent = `${s}${fp(
        data.change
      )} (${s}${data.changePct.toFixed(2)}%)`;
      el.style.color =
        data.change > 0
          ? "var(--up)"
          : data.change < 0
          ? "var(--dn)"
          : "var(--am)";
      el.style.background =
        data.change > 0
          ? "var(--up-bg)"
          : data.change < 0
          ? "var(--dn-bg)"
          : "var(--am-bg)";
    }
  }
  if (data.ref != null) setRtVal("refVal", fp(data.ref), isUp);
  if (data.open != null) setRtVal("openVal", fp(data.open), isUp);
  if (data.high != null) setRtVal("highVal", fp(data.high), true);
  if (data.low != null) setRtVal("lowVal", fp(data.low), false);
  if (data.volume != null) {
    const newVol = fvol(data.volume);
    const prevVol = _prevRt.volume;
    setRtVal("volumeVal", newVol, data.volume >= (prevVol ?? 0));
  }
  _prevRt = { price: data.price, volume: data.volume };

  // Update PiP window
  setPipData(sym, data.price, data.change, data.changePct, isUp);

  // Cập nhật analysisData.latestPrice để portfolio card & advisory dùng giá mới
  if (analysisData && data.price != null) {
    analysisData.latestPrice = data.price;
    const s = data.change != null ? (data.change > 0 ? "+" : "") : "";
    const fakeChange =
      data.change != null
        ? `${s}${fp(data.change)}(${s}${data.changePct?.toFixed(2)}%)`
        : "";
    if (data.change != null) analysisData.latestChange = fakeChange;
    updateFloatingPrice({
      ...analysisData,
      latestPrice: data.price,
      latestChange: fakeChange || analysisData.latestChange,
    });
    // Re-render các section dùng giá hiện tại để phản ánh giá intraday
    renderHeroExtra(analysisData);
    renderIndicators(analysisData.indicators);
    renderSR(analysisData.supportResistance, data.price);
    renderPortfolio();
  }

  // Badge
  const badge = document.getElementById("realtimeBadge");
  if (!badge) return;
  const isLive = !fromCache && isVNTradingHours();
  let timeLabel = "";
  if (fromCache && cachedAt) {
    const vnCached = new Date(
      new Date(cachedAt).getTime() + 7 * 3600 * 1000
    );
    timeLabel = `${String(vnCached.getUTCHours()).padStart(
      2,
      "0"
    )}:${String(vnCached.getUTCMinutes()).padStart(2, "0")}`;
  } else {
    const vn = getVNDate();
    timeLabel = `${String(vn.getUTCHours()).padStart(2, "0")}:${String(
      vn.getUTCMinutes()
    ).padStart(2, "0")}`;
  }
  const dotColor = isLive ? "var(--up)" : "var(--am)";
  const bgColor = isLive ? "var(--up-bg)" : "var(--am-bg)";
  const bdColor = isLive ? "var(--up-bd)" : "var(--am-bd)";
  badge.style.display = "flex";
  badge.innerHTML =
    `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;
background:${bgColor};border:1px solid ${bdColor};color:${dotColor}">${
      isLive
        ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--up);display:inline-block;animation:blink 1.2s infinite"></span> LIVE ' +
          timeLabel
        : "📦 Cache " + timeLabel
    }</div>` +
    `<button id="mshRefreshBtn" onclick="refreshRealtimePrice()" title="Lấy giá mới nhất từ MSH"
style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:1px solid var(--gray200);background:var(--wht);color:var(--gray500);cursor:pointer;padding:0;transition:all .15s;flex-shrink:0"
onmouseenter="this.style.borderColor='var(--navy)';this.style.color='var(--navy)'" onmouseleave="this.style.borderColor='var(--gray200)';this.style.color='var(--gray500)'">
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
</button>`;
}

function refreshRealtimePrice() {
  // Reconnect SSE → server sẽ fetch MSH ngay lập tức
  const sym = document.getElementById("symbolBadge")?.textContent?.trim();
  if (!sym) return;
  const btn = document.getElementById("mshRefreshBtn");
  if (btn) {
    btn.style.opacity = ".4";
    btn.style.pointerEvents = "none";
    btn.querySelector("svg").style.animation = "sp .6s linear infinite";
  }
  loadRealtimePrice(sym);
  setTimeout(() => {
    const b = document.getElementById("mshRefreshBtn");
    if (b) {
      b.style.opacity = "1";
      b.style.pointerEvents = "";
      b.querySelector("svg").style.animation = "";
    }
  }, 1200);
}

window.addEventListener("beforeunload", () => closeMshStream());
window.addEventListener("load", () => {
  loadSymbols();
  loadWatchlistState();
  initFloatingPrice();
  const s = new URLSearchParams(location.search).get("s");
  if (s) {
    document.getElementById("symbolInput").value = s;
    loadAnalysis(s);
  } else {
    const last = localStorage.getItem("detail_last_symbol");
    if (last) {
      document.getElementById("symbolInput").value = last;
      loadAnalysis(last);
    }
  }
});

function renderCompanyInfo(d) {
  const el = document.getElementById("companyInfo");
  if (!el || !d) return;

  const dot = `<span style="color:var(--gray300);margin:0 2px">·</span>`;

  const fmtShares = (n) => {
    if (!n) return null;
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + " tỷ CP";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.?0+$/, "") + " triệu CP";
    return n.toLocaleString("vi-VN") + " CP";
  };

  const rows = [];

  // Dòng 1: Tên công ty
  if (d.nameVi) {
    rows.push(`<div style="font-size:13px;font-weight:600;color:var(--gray700);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.nameVi}</div>`);
  }

  // Dòng 2: Sàn · Ngành · ICB · Index groups · Mệnh giá
  const meta = [];
  if (d.exchange) meta.push(`<span style="font-weight:700;color:#3b82f6">${d.exchange}</span>`);
  if (d.sectorVi) meta.push(`<span>${d.sectorVi}</span>`);
  if (d.icbCode)  meta.push(`<span style="color:var(--gray400)">ICB ${d.icbCode}</span>`);
  const idxBadge = (label, color) =>
    `<span style="font-weight:700;font-size:10px;padding:1px 6px;border-radius:4px;background:${color}18;color:${color};border:1px solid ${color}30">${label}</span>`;
  if (d.indexGroups?.includes("VN30"))     meta.push(idxBadge("VN30", "#7c3aed"));
  if (d.indexGroups?.includes("VNINDEX"))  meta.push(idxBadge("VNINDEX", "#0369a1"));
  if (d.indexGroups?.includes("HNXIndex")) meta.push(idxBadge("HNXIndex", "#0369a1"));
  if (d.parValue) meta.push(`<span style="color:var(--gray400)">Mệnh giá ${(d.parValue / 1000).toLocaleString("vi-VN")}k</span>`);
  if (meta.length) {
    rows.push(`<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--gray500)">${meta.join(dot)}</div>`);
  }

  // Dòng 3: KL niêm yết · SLCP lưu hành
  const shareItems = [];
  const ls = fmtShares(d.issueShare);
  const os = fmtShares(d.outstandingShare);
  if (ls) shareItems.push(`<span>KL niêm yết <b style="color:var(--gray700)">${ls}</b></span>`);
  if (os) shareItems.push(`<span>SLCP lưu hành <b style="color:var(--gray700)">${os}</b></span>`);
  if (shareItems.length) {
    rows.push(`<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--gray500)">${shareItems.join(dot)}</div>`);
  }

  el.style.display = rows.length ? "flex" : "none";
  el.innerHTML = rows.join("");
}

// ── TrendPro tooltip content ──
function buildTrendProTooltip(action, d) {
  if (!action || !d) return "";
  const fp = v => v != null ? parseFloat(v).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) : "—";

  const s1   = d.supportResistance?.supports?.[0]?.price;
  const s2   = d.supportResistance?.supports?.[1]?.price;
  const r1   = d.supportResistance?.resistances?.[0]?.price;
  const ma20 = d.indicators?.ma20;
  const ma5  = d.indicators?.ma5;
  const opt  = d.predictions?.bestBuy?.entryZone?.optimal;
  const stScore = d.trendPro?.shortTerm?.score;

  // QUAN SÁT / WATCH — trung lập, chờ tín hiệu rõ
  if (action.includes("QUAN SÁT") || action.includes("WATCH")) {
    return "Đà ngắn hạn đang trung lập, chưa có hướng rõ.\n\n" +
      "Chuyển sang MUA khi:\n" +
      (ma20 != null ? `• Giá vượt MA20 (${fp(ma20)}) kèm volume tăng\n` : "") +
      (r1   != null ? `• Giá breakout R1 (${fp(r1)})\n` : "") +
      "\nChuyển sang BÁN khi:\n" +
      (s1   != null ? `• Giá phá xuống S1 (${fp(s1)})\n` : "") +
      (ma20 != null ? `• MA20 (${fp(ma20)}) bắt đầu quay đầu giảm` : "");
  }

  // THEO DÕI TĂNG / MILD BULLISH — sắp có tín hiệu mua
  if (action.includes("THEO DÕI TĂNG") || action.includes("MILD BULLISH")) {
    return "Đà ngắn hạn đang cải thiện, chưa đủ mạnh để mua.\n\n" +
      "Vào lệnh khi:\n" +
      (ma5  != null ? `• Giá giữ trên MA5 (${fp(ma5)}) ≥ 2 phiên liên tiếp\n` : "") +
      (r1   != null ? `• Giá vượt R1 (${fp(r1)}) với volume tăng mạnh\n` : "") +
      "\nHủy kế hoạch nếu:\n" +
      (s1   != null ? `• Giá quay về dưới S1 (${fp(s1)})` : "");
  }

  // THEO DÕI GIẢM / MILD BEARISH — sắp có tín hiệu bán
  if (action.includes("THEO DÕI GIẢM") || action.includes("MILD BEARISH")) {
    return "Đà ngắn hạn đang suy yếu nhẹ, cần thận trọng.\n\n" +
      "Cắt giảm vị thế khi:\n" +
      (s1   != null ? `• Giá phá S1 (${fp(s1)}) với volume lớn\n` : "") +
      (ma20 != null ? `• Giá đóng cửa dưới MA20 (${fp(ma20)})\n` : "") +
      "\nPhục hồi nếu:\n" +
      (ma5  != null ? `• Giá giữ MA5 (${fp(ma5)}) và volume thu hẹp` : "");
  }

  // BÁN / EXIT / GIẢM ĐỒNG THUẬN
  if (action.includes("BÁN") || action.includes("EXIT") || action.includes("GIẢM")) {
    return "Đà ngắn hạn yếu" + (stScore != null ? ` (score: ${stScore}/100)` : "") + " — nên đứng ngoài.\n\n" +
      "Vùng mua lại ngắn hạn:\n" +
      (s1   != null ? `• Hỗ trợ S1  : ${fp(s1)}\n` : "") +
      (s2   != null ? `• Hỗ trợ S2  : ${fp(s2)}\n` : "") +
      (opt  != null ? `• Entry tối ưu: ${fp(opt)}\n` : "") +
      (ma20 != null ? `• MA20       : ${fp(ma20)}\n` : "") +
      "\nMua lại khi giá + volume xác nhận vùng hỗ trợ.";
  }

  // MUA / NẮM GIỮ / TĂNG ĐỒNG THUẬN / FTD
  if (action.includes("MUA") || action.includes("HOLD") || action.includes("TĂNG") || action.includes("FTD")) {
    return "Đà ngắn hạn tích cực" + (stScore != null ? ` (score: ${stScore}/100)` : "") + ".\n\n" +
      "Giữ vị thế, trailing stop:\n" +
      (s1   != null ? `• Dưới S1 (${fp(s1)}) → xem xét chốt lời\n` : "") +
      (ma5  != null ? `• Giá đóng cửa dưới MA5 (${fp(ma5)}) 2 phiên → cảnh báo\n` : "") +
      (r1   != null ? `• Kháng cự R1 (${fp(r1)}) → có thể chốt một phần` : "");
  }

  return "";
}

// ── Global tooltip system ──
(function () {
  const tt = document.createElement("div");
  tt.style.cssText =
    "position:fixed;background:#1a1a2e;color:#fff;font-size:12px;line-height:1.6;" +
    "padding:10px 14px;border-radius:10px;max-width:280px;pointer-events:none;" +
    "opacity:0;transition:opacity .15s;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.3);" +
    "white-space:pre-line;word-break:break-word";
  document.body.appendChild(tt);

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (!el) return;
    tt.textContent = el.dataset.tooltip;
    tt.style.opacity = "1";
  });
  document.addEventListener("mousemove", (e) => {
    if (tt.style.opacity === "0") return;
    const x = e.clientX + 14;
    const y = e.clientY + 14;
    tt.style.left = (x + 280 > window.innerWidth ? e.clientX - 294 : x) + "px";
    tt.style.top  = (y + tt.offsetHeight > window.innerHeight ? e.clientY - tt.offsetHeight - 8 : y) + "px";
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-tooltip]")) tt.style.opacity = "0";
  });
})();
