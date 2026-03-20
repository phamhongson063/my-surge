import fs from "fs";
import path from "path";
import { BASE_DIR } from "./utils.mjs";

const SSI_TOKEN_FILE = path.join(BASE_DIR, "database", "ssi_token.json");
let ssiToken = null; // Bearer token, loaded from file on start

export function loadSsiToken() {
  try {
    if (fs.existsSync(SSI_TOKEN_FILE)) {
      const { token } = JSON.parse(fs.readFileSync(SSI_TOKEN_FILE, "utf8"));
      ssiToken = token || null;
      if (ssiToken) console.log("[SSI] Token loaded from file");
    }
  } catch {}
}

export function saveSsiToken(token) {
  ssiToken = token;
  fs.mkdirSync(path.dirname(SSI_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    SSI_TOKEN_FILE,
    JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)
  );
  console.log("[SSI] Token saved");
}

export function getSsiToken() {
  return ssiToken;
}

export function getSsiTokenFile() {
  return SSI_TOKEN_FILE;
}
