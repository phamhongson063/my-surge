import fs from "fs";
import path from "path";
import url from "url";
import { sendJSON, BASE_DIR } from "../lib/utils.mjs";

const staticFiles = {
  "/css/style.css": {
    file: "public/css/style.css",
    mime: "text/css; charset=utf-8",
  },
  "/js/app.js": {
    file: "public/js/app.js",
    mime: "application/javascript; charset=utf-8",
  },
  "/surge.html": {
    file: "public/surge.html",
    mime: "text/html; charset=utf-8",
  },
  "/detail.html": {
    file: "public/detail.html",
    mime: "text/html; charset=utf-8",
  },
  "/detail.css": {
    file: "public/detail.css",
    mime: "text/css; charset=utf-8",
  },
  "/detail.js": {
    file: "public/detail.js",
    mime: "application/javascript; charset=utf-8",
  },
  "/watchlist.html": {
    file: "public/watchlist.html",
    mime: "text/html; charset=utf-8",
  },
  "/watcher.html": {
    file: "public/watcher.html",
    mime: "text/html; charset=utf-8",
  },
  "/portfolio.html": {
    file: "public/portfolio.html",
    mime: "text/html; charset=utf-8",
  },
  "/css/portfolio.css": {
    file: "public/css/portfolio.css",
    mime: "text/css; charset=utf-8",
  },
  "/js/portfolio.js": {
    file: "public/js/portfolio.js",
    mime: "application/javascript; charset=utf-8",
  },
  "/stocks.csv": {
    file: "public/stocks.csv",
    mime: "text/csv; charset=utf-8",
  },
  "/sector.html": {
    file: "public/sector.html",
    mime: "text/html; charset=utf-8",
  },
  "/sector-detail.html": {
    file: "public/sector-detail.html",
    mime: "text/html; charset=utf-8",
  },
  "/price-board.html": {
    file: "public/price-board.html",
    mime: "text/html; charset=utf-8",
  },
};

export async function handle(req, res, { pathname, parsed }) {
  if (pathname === "/health") {
    sendJSON(res, 200, { status: "ok", time: new Date().toISOString() });
    return true;
  }

  // Serve front.html tại /front.html, index.html tại /
  if (pathname === "/" || pathname === "/index.html") {
    const htmlPath = path.join(BASE_DIR, "public", "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end("index.html not found");
    }
    return true;
  }

  if (pathname === "/front.html") {
    const htmlPath = path.join(BASE_DIR, "public", "front.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end("front.html not found");
    }
    return true;
  }

  if (staticFiles[pathname]) {
    const { file, mime } = staticFiles[pathname];
    const filePath = path.join(BASE_DIR, file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end(`${file} not found`);
    }
    return true;
  }

  return false;
}
