#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { URL } from "url";

const CSV_PATH = new URL("../database/stocks.csv", import.meta.url);
const API_BASE = "https://cafef.vn/du-lieu/ajax/pagenew/companyinfor.ashx?symbol=";
const CONCURRENCY = 5;   // số request song song
const DELAY_MS = 200;    // delay giữa mỗi batch (ms)

// --- helpers CSV ---
function parseCSV(text) {
  const [headerLine, ...lines] = text.replace(/^\uFEFF/, "").split("\n").filter(Boolean);
  const headers = headerLine.split(",");
  return {
    headers,
    rows: lines.map((line) => {
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
        cur += ch;
      }
      cols.push(cur);
      return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
    }),
  };
}

function toCSV(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))];
  return "\uFEFF" + lines.join("\n");
}

// --- fetch nganh với retry ---
async function fetchNganh(symbol) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${symbol}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return "";
      const json = await res.json();
      return json?.Data?.Nganh ?? "";
    } catch {
      if (attempt === 3) return "";
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return "";
}

// --- chạy concurrency pool ---
async function runPool(tasks, concurrency, onDone) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const result = await tasks[i]();
      onDone(i, result);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// --- main ---
const raw = readFileSync(CSV_PATH, "utf8");
const { headers, rows } = parseCSV(raw);

if (!headers.includes("Ngành")) headers.push("Ngành");
rows.forEach((r) => { if (!r["Ngành"]) r["Ngành"] = ""; });

const todo = rows.filter((r) => !r["Ngành"]);
console.log(`Tổng: ${rows.length} cổ phiếu | Cần fetch: ${todo.length}`);

let done = 0;
const tasks = todo.map((row) => async () => {
  const nganh = await fetchNganh(row.Symbol);
  await new Promise((r) => setTimeout(r, DELAY_MS));
  return { row, nganh };
});

await runPool(tasks, CONCURRENCY, (_, { row, nganh }) => {
  row["Ngành"] = nganh;
  done++;
  process.stdout.write(`\r  ${done}/${todo.length} - ${row.Symbol.padEnd(6)} → ${nganh || "(trống)"}          `);
});

console.log("\nLưu file...");
writeFileSync(CSV_PATH, toCSV(headers, rows), "utf8");
console.log(`Hoàn tất! Đã cập nhật database/stocks.csv`);
