import https from "https";
import { SSI_HEADERS } from "./utils.mjs";

let _snapshotCache = null;
let _snapshotCacheTime = 0;
const SNAPSHOT_TTL_MS = 60_000; // cache 1 phút để tránh gọi lại khi 2 endpoint chạy song song

export async function fetchMarketSnapshot() {
  if (_snapshotCache && Date.now() - _snapshotCacheTime < SNAPSHOT_TTL_MS) {
    return _snapshotCache;
  }
  const snapshot = {}; // { SYM: { changePct, volume, price, refPrice } }
  const exchanges = ["hose", "hnx", "upcom"];

  await Promise.all(
    exchanges.map(
      (ex) =>
        new Promise((resolve) => {
          const targetUrl = `https://iboard-query.ssi.com.vn/stock/exchange/${encodeURIComponent(ex)}`;
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
                  try {
                    const json = JSON.parse(
                      Buffer.concat(chunks).toString("utf8")
                    );
                    const list = Array.isArray(json)
                      ? json
                      : Array.isArray(json.data)
                      ? json.data
                      : [];
                    list.forEach((s) => {
                      const sym = (
                        s.stockSymbol ||
                        s.code ||
                        ""
                      )
                        .trim()
                        .toUpperCase();
                      if (!sym) return;
                      snapshot[sym] = {
                        price: s.matchedPrice,
                        refPrice: s.refPrice,
                        // priceChangePercent từ SSI là số thực (vd: 1.85 = +1.85%)
                        changePct: parseFloat(
                          (s.priceChangePercent ?? 0).toFixed(2)
                        ),
                        // nmTotalTradedQty / 100 = khối lượng (cổ phiếu, đơn vị nghìn)
                        volume: Math.round((s.nmTotalTradedQty ?? 0) / 100),
                      };
                    });
                  } catch { /* ignore */ }
                  resolve();
                });
                rsp.on("error", resolve);
              }
            )
            .on("error", resolve);
        })
    )
  );

  _snapshotCache = snapshot;
  _snapshotCacheTime = Date.now();
  console.log(
    `[Snapshot] ✅ ${Object.keys(snapshot).length} mã từ 3 sàn`
  );
  return snapshot;
}
