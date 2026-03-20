import path from "path";
import url from "url";

export const BASE_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

export const SSI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Origin: "https://iboard.ssi.com.vn",
  Referer: "https://iboard.ssi.com.vn/",
  Accept: "application/json",
};

export function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
