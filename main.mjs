/**
 * server.mjs — Express proxy server cho CafeF Stock Downloader
 *
 * Khởi động: node server.mjs
 * Mặc định chạy tại: http://localhost:3000
 *
 * API:
 *   GET /download?symbol=DPM&start=2025-01-01&end=2026-03-13
 *     → tải file từ CafeF, lưu vào export/<SYMBOL>/, trả blob về browser
 *
 *   GET /health  → { status: "ok" }
 */

import http from "http";
import os from "os";
import url from "url";
import { setCORS } from "./lib/utils.mjs";
import { loadSsiToken } from "./lib/ssiToken.mjs";
import { handle as boardRoutes } from "./routes/board.mjs";
import { handle as sectorsRoutes } from "./routes/sectors.mjs";
import { handle as historyRoutes } from "./routes/history.mjs";
import { handle as portfolioRoutes } from "./routes/portfolio.mjs";
import { handle as watchlistRoutes } from "./routes/watchlist.mjs";
import { handle as analyzeRoutes } from "./routes/analyze.mjs";
import { handle as realtimeRoutes } from "./routes/realtime.mjs";
import { handle as staticRoutes } from "./routes/static.mjs";
import { handleBoardWsUpgrade } from "./lib/board.mjs";
import { killPort } from "./kill-port.mjs";

const PORT = process.env.PORT || 3000;
await killPort(PORT);

loadSsiToken();

const ROUTES = [
  boardRoutes,
  sectorsRoutes,
  historyRoutes,
  portfolioRoutes,
  watchlistRoutes,
  analyzeRoutes,
  realtimeRoutes,
  staticRoutes,
];

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const parsed = url.parse(req.url, true);
  const ctx = { pathname: parsed.pathname, parsed };
  for (const handle of ROUTES) {
    if (await handle(req, res, ctx)) return;
  }
  res.writeHead(404);
  res.end("Not found");
});

server.on("upgrade", (req, socket) => {
  const { pathname } = url.parse(req.url);
  if (pathname === "/ws/board") handleBoardWsUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIp =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i.family === "IPv4" && !i.internal)?.address ?? "?";
  console.log("╔══════════════════════════════════════════════╗");
  console.log(`║  CafeF Stock Downloader Server               ║`);
  console.log(`║  Local:   http://localhost:${PORT}               ║`);
  console.log(`║  Network: http://${lanIp}:${PORT}          ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log("\nEndpoints:");
  console.log(`  GET /              → Giao diện HTML (front.html)`);
  console.log(`  GET /surge.html    → Quét khối lượng đột biến`);
  console.log(`  GET /detail.html?s=DGC → Phân tích chi tiết 1 mã`);
  console.log(`  GET /download?symbol=DPM&start=2025-01-01&end=2026-03-13`);
  console.log(`  GET /health        → Health check`);
  console.log(`  GET /watchlist     → Lấy watchlist + alerts`);
  console.log(`  POST /watchlist/add    { symbol }  → Thêm mã`);
  console.log(`  POST /watchlist/remove { symbol }  → Xóa mã`);
  console.log(`  GET /watchlist/scan    → Quét tín hiệu toàn bộ watchlist`);
  console.log(`  GET /watchlist/scan?refresh=1 → Force scan (bỏ qua cache)`);
  console.log(`  GET /symbols                  → List mã đã có data\n`);
});
