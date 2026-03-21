/**
 * trend.mjs — PHIÊN BẢN MODULAR (V16 - FINAL POLISH)
 * Đặc điểm: Tên biến tường minh, Tree-shakeable, IBD/FTD Logic.
 */

/** @const {Object} Cấu hình mặc định */
export const DEFAULT_CONFIG = {
  RSI: {
    UPPER_THRESHOLD: 65,
    LOWER_THRESHOLD: 35,
    SWING_WINDOW: 3,
    DIV_MAX_BARS: 6,
  },
  ADAPTIVE_SWING: { BASE_WINDOW: 5, MIN_WINDOW: 3, MAX_WINDOW: 12 },
  MARKET: {
    VOL_AVG_PERIOD: 20,
    VOL_BREAKOUT_RATIO: 1.3,
    FTD_MIN_DAY: 4,
    FTD_LOOKBACK: 21,
    FTD_PRICE_GIVE: 1.7,
  },
  WEIGHTS: {
    BASE_SCORE: 50,
    MA_ALIGNMENT: 20,
    VOL_CONFIRM: 10,
    DIVERGENCE: 20,
  },
};

const roundToTwo = (value) =>
  value != null ? Math.round(value * 100) / 100 : null;

// ─── 1. CORE UTILS ──────────────────────────────────────────────────────────

/** Deep merge an toàn cho cấu hình */
export function deepMerge(target, source) {
  const output = { ...target };
  if (source && typeof source === "object") {
    Object.keys(source).forEach((key) => {
      if (
        source[key] &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        output[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    });
  }
  return output;
}

export function sma(arr, n) {
  if (!arr || arr.length < n) return new Array(arr.length).fill(null);
  const r = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] ?? 0;
    if (i >= n) sum -= arr[i - n] ?? 0;
    if (i >= n - 1) r[i] = sum / n;
  }
  return r;
}

export function calcATR(data, period = 14) {
  const totalBars = data.length;
  if (totalBars < period) return new Array(totalBars).fill(0);
  const atr = new Array(totalBars).fill(0);
  const trueRanges = data.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const previousClose = data[i - 1].price;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });
  let sumTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  atr[period - 1] = sumTR / period;
  for (let i = period; i < totalBars; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

function calcAvgVol(data, endIndex, period) {
  const start = Math.max(0, endIndex - period);
  const volumeSlice = data.slice(start, endIndex).map((d) => d.volume ?? 0);
  return volumeSlice.length > 0
    ? volumeSlice.reduce((s, v) => s + v, 0) / volumeSlice.length
    : 0;
}

// ─── 2. SWING DETECTION ─────────────────────────────────────────────────────

export function getAdaptivePriceSwings(prices, atrArr, start, end, swingCfg) {
  const swings = { highs: [], lows: [] };
  const { BASE_WINDOW, MIN_WINDOW, MAX_WINDOW } = swingCfg;
  const segment = atrArr.slice(start, end + 1).filter((v) => v != null);
  const averageATR =
    segment.length > 0
      ? segment.reduce((a, b) => a + b, 0) / segment.length
      : 1;

  for (let i = start; i <= end; i++) {
    const volatilityFactor = (atrArr[i] || averageATR) / averageATR;
    const dynamicWindow = Math.min(
      MAX_WINDOW,
      Math.max(MIN_WINDOW, Math.round(BASE_WINDOW * volatilityFactor))
    );
    if (i < dynamicWindow || i > prices.length - 1 - dynamicWindow) continue;

    let isHigh = true,
      isLow = true;
    for (let j = i - dynamicWindow; j <= i + dynamicWindow; j++) {
      if (j === i) continue;
      if (prices[j] >= prices[i]) isHigh = false;
      if (prices[j] <= prices[i]) isLow = false;
    }
    if (isHigh) swings.highs.push({ i, v: prices[i], type: "high" });
    if (isLow) swings.lows.push({ i, v: prices[i], type: "low" });
  }
  return swings;
}

export function getRsiSwings(rsiArr, start, end, rsiCfg) {
  const swings = { highs: [], lows: [] };
  const { UPPER_THRESHOLD, LOWER_THRESHOLD, SWING_WINDOW } = rsiCfg;
  for (let i = start; i <= end; i++) {
    if (i < SWING_WINDOW || i > rsiArr.length - 1 - SWING_WINDOW) continue;
    const val = rsiArr[i];
    if (val == null) continue;
    let isHigh = true,
      isLow = true;
    for (let j = i - SWING_WINDOW; j <= i + SWING_WINDOW; j++) {
      if (j === i) continue;
      if (rsiArr[j] >= val) isHigh = false;
      if (rsiArr[j] <= val) isLow = false;
    }
    if (isHigh && val > UPPER_THRESHOLD)
      swings.highs.push({ i, v: val, type: "high" });
    if (isLow && val < LOWER_THRESHOLD)
      swings.lows.push({ i, v: val, type: "low" });
  }
  return swings;
}

// ─── 3. CORE LOGIC ──────────────────────────────────────────────────────────

export function analyzeTimeframe(context, params, cfg) {
  const { data, rsiArr, atrArr } = context;
  const { lookback, maS, maL, label } = params;
  const totalBars = data.length;
  const endIndex = totalBars - 1;
  const startIndex = Math.max(0, totalBars - lookback);
  const prices = data.map((d) => d.price);

  const priceSwings = getAdaptivePriceSwings(
    prices,
    atrArr,
    startIndex,
    endIndex,
    cfg.ADAPTIVE_SWING
  );
  const rsiSwings = getRsiSwings(rsiArr, startIndex, endIndex, cfg.RSI);

  let divergence = null;
  const maxBarsBetween = cfg.RSI.DIV_MAX_BARS;
  if (priceSwings.highs.length >= 2 && rsiSwings.highs.length >= 2) {
    const lastP = priceSwings.highs[priceSwings.highs.length - 1],
      prevP = priceSwings.highs[priceSwings.highs.length - 2];
    const lastR = rsiSwings.highs[rsiSwings.highs.length - 1],
      prevR = rsiSwings.highs[rsiSwings.highs.length - 2];
    if (
      Math.abs(lastP.i - lastR.i) <= maxBarsBetween &&
      lastP.v > prevP.v &&
      lastR.v < prevR.v
    ) {
      divergence = { type: "BEARISH", desc: "Phân kỳ giảm" };
    }
  }
  if (
    !divergence &&
    priceSwings.lows.length >= 2 &&
    rsiSwings.lows.length >= 2
  ) {
    const lastP = priceSwings.lows[priceSwings.lows.length - 1],
      prevP = priceSwings.lows[priceSwings.lows.length - 2];
    const lastR = rsiSwings.lows[rsiSwings.lows.length - 1],
      prevR = rsiSwings.lows[rsiSwings.lows.length - 2];
    if (
      Math.abs(lastP.i - lastR.i) <= maxBarsBetween &&
      lastP.v < prevP.v &&
      lastR.v > prevR.v
    ) {
      divergence = { type: "BULLISH", desc: "Phân kỳ tăng" };
    }
  }

  const averageVolume = calcAvgVol(data, endIndex, cfg.MARKET.VOL_AVG_PERIOD);
  const relativeVolume =
    averageVolume > 0 ? (data[endIndex].volume ?? 0) / averageVolume : 1;
  let score = cfg.WEIGHTS.BASE_SCORE;

  const maShortValue = sma(prices, maS)[endIndex];
  const maLongValue = sma(prices, maL)[endIndex];
  if (maShortValue !== null && maLongValue !== null) {
    if (prices[endIndex] > maShortValue && maShortValue > maLongValue)
      score += cfg.WEIGHTS.MA_ALIGNMENT;
    else if (prices[endIndex] < maShortValue && maShortValue < maLongValue)
      score -= cfg.WEIGHTS.MA_ALIGNMENT;
  }

  const previousPrice = data[totalBars - 2]?.price;
  if (
    previousPrice !== undefined &&
    relativeVolume > cfg.MARKET.VOL_BREAKOUT_RATIO
  ) {
    score +=
      prices[endIndex] > previousPrice
        ? cfg.WEIGHTS.VOL_CONFIRM
        : -cfg.WEIGHTS.VOL_CONFIRM;
  }

  if (divergence?.type === "BULLISH") score += cfg.WEIGHTS.DIVERGENCE;
  if (divergence?.type === "BEARISH") score -= cfg.WEIGHTS.DIVERGENCE;

  return {
    label,
    score: Math.min(100, Math.max(0, score)),
    divergence,
    relVol: roundToTwo(relativeVolume),
  };
}

// ─── 4. PUBLIC API ──────────────────────────────────────────────────────────

export function determineTrendPro(data, indicators = {}, customConfig = {}) {
  if (!data || data.length < 50) return { error: "Insufficient data" };

  const cfg = deepMerge(DEFAULT_CONFIG, customConfig);
  const context = {
    data,
    rsiArr: indicators.rsi ?? new Array(data.length).fill(50),
    atrArr: calcATR(data, 14),
  };

  const shortTerm = analyzeTimeframe(
    context,
    { label: "Ngắn hạn", lookback: 30, maS: 5, maL: 20 },
    cfg
  );
  const midTerm = analyzeTimeframe(
    context,
    { label: "Trung hạn", lookback: 60, maS: 20, maL: 50 },
    cfg
  );

  // [REFACTORED FTD BLOCK]
  const totalBars = data.length;
  const { FTD_LOOKBACK, FTD_MIN_DAY, FTD_PRICE_GIVE, VOL_AVG_PERIOD } =
    cfg.MARKET;

  let minPriceObserved = Infinity;
  let minPriceIndex = -1;

  for (let i = totalBars - FTD_LOOKBACK; i < totalBars - 1; i++) {
    if (data[i].price < minPriceObserved) {
      minPriceObserved = data[i].price;
      minPriceIndex = i;
    }
  }

  const daysSinceBottom = totalBars - 1 - minPriceIndex;
  const currentPrice = data[totalBars - 1].price;
  const previousPrice = data[totalBars - 2].price || 1;
  const priceChangePercent = (currentPrice / previousPrice - 1) * 100;

  const currentVolume = data[totalBars - 1].volume ?? 0;
  const previousVolume = data[totalBars - 2].volume ?? 0;
  const averageVolume20 = calcAvgVol(data, totalBars - 1, VOL_AVG_PERIOD);

  const ftd = {
    isFTD:
      daysSinceBottom >= FTD_MIN_DAY &&
      priceChangePercent >= FTD_PRICE_GIVE &&
      currentVolume > previousVolume &&
      averageVolume20 > 0 &&
      currentVolume > averageVolume20,
    daysSinceBottom,
    priceChange: roundToTwo(priceChangePercent),
    relVol:
      averageVolume20 > 0 ? roundToTwo(currentVolume / averageVolume20) : 0,
  };

  const shortScore = shortTerm.score;
  const midScore = midTerm.score;
  let action = "QUAN SÁT (WATCH)",
    state = "Sideways";

  if (ftd.isFTD) {
    action = "XÁC NHẬN FTD (STRONG BUY)";
    state = "FTD Confirmed";
  } else if (shortScore >= 75 && midScore >= 65) {
    action = "TĂNG ĐỒNG THUẬN (STRONG HOLD)";
    state = "Strong Bullish";
  } else if (shortScore >= 65) {
    action = "MUA / NẮM GIỮ (HOLD)";
    state = "Bullish";
  } else if (shortScore <= 25 && midScore <= 35) {
    action = "GIẢM ĐỒNG THUẬN (STRONG EXIT)";
    state = "Strong Bearish";
  } else if (shortScore <= 35) {
    action = "BÁN / ĐỨNG NGOÀI (EXIT)";
    state = "Bearish";
  } else if (shortScore > 55) {
    action = "THEO DÕI TĂNG (MILD BULLISH)";
    state = "Mild Bullish";
  } else if (shortScore < 45) {
    action = "THEO DÕI GIẢM (MILD BEARISH)";
    state = "Mild Bearish";
  }

  return {
    shortTerm,
    midTerm,
    ftd,
    summary: {
      action,
      marketState: state,
      scores: { shortTerm: shortScore, midTerm: midScore },
      warning: shortTerm.divergence?.desc || "Ổn định",
      updatedAt: new Date().toISOString(),
    },
  };
}
