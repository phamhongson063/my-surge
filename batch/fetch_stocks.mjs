#!/usr/bin/env node
import { writeFileSync } from "fs";

const API_URL = "https://cafefnew.mediacdn.vn/Search/company.json";

function getSan(redirectUrl) {
  if (redirectUrl.includes("/hastc/")) return "HASTC";
  if (redirectUrl.includes("/hose/")) return "HOSE";
  return "";
}

function escapeCSV(value) {
  const str = String(value ?? "");
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

console.log(`Đang tải dữ liệu từ ${API_URL} ...`);

const res = await fetch(API_URL);
if (!res.ok) throw new Error(`HTTP ${res.status}`);

const data = await res.json();
console.log(`Tổng số công ty: ${data.length}`);

const rows = [];
for (const item of data) {
  const redirect = item.RedirectUrl ?? "";
  const san = getSan(redirect);
  if (!san) continue;

  rows.push({
    Symbol: item.Symbol ?? "",
    Title: item.Title ?? "",
    san,
    info: redirect,
  });
}

const header = ["stt", "Symbol", "Title", "Sàn giao dịch", "Info"].join(",");
const lines = rows.map((r, i) =>
  [i + 1, escapeCSV(r.Symbol), escapeCSV(r.Title), r.san, escapeCSV(r.info)].join(",")
);

const csv = "\uFEFF" + [header, ...lines].join("\n"); // BOM cho Excel đọc UTF-8
const outputPath = new URL("../database/stocks.csv", import.meta.url);
writeFileSync(outputPath, csv, "utf8");

const hose = rows.filter((r) => r.san === "HOSE").length;
const hastc = rows.filter((r) => r.san === "HASTC").length;
console.log(`Đã lưu ${rows.length} công ty vào file: database/stocks.csv`);
console.log(`  - HOSE:  ${hose}`);
console.log(`  - HASTC: ${hastc}`);
