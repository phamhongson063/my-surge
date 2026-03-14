/**
 * analyze.mjs — phân tích khối lượng đột biến từ tmp/*.xlsx
 * Không dùng npm — chỉ dùng built-in: fs, path, zlib
 */

import fs            from 'fs';
import path          from 'path';
import zlib          from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);

// ── ZIP parser (xlsx = zip) ───────────────────────────────────────────────────
function parseZipEntries(buf) {
  const files = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const compression = buf.readUInt16LE(i + 8);
    const compSize    = buf.readUInt32LE(i + 18);
    const nameLen     = buf.readUInt16LE(i + 26);
    const extraLen    = buf.readUInt16LE(i + 28);
    const name        = buf.slice(i + 30, i + 30 + nameLen).toString();
    const dataStart   = i + 30 + nameLen + extraLen;
    const data        = buf.slice(dataStart, dataStart + compSize);
    files[name]       = { compression, data };
    i = dataStart + compSize;
  }
  return files;
}

async function readEntry(entry) {
  if (!entry) return '';
  if (entry.compression === 0) return entry.data.toString('utf8');
  try {
    const out = await inflateRaw(entry.data);
    return out.toString('utf8');
  } catch {
    return entry.data.toString('utf8');
  }
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function decodeXml(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

// Parse shared strings (tên cột + giá trị string)
function parseSharedStrings(xml) {
  const strings = [];
  const re = /<si>[\s\S]*?<\/si>/g;
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) {
    let text = '';
    let t;
    tRe.lastIndex = 0;
    while ((t = tRe.exec(m[0]))) text += decodeXml(t[1]);
    strings.push(text);
  }
  return strings;
}

// Parse sheet XML → array of row objects { colLetter: value }
function parseSheet(xml, strings) {
  const rows   = {};
  const rowRe  = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  // Match toàn bộ <c ...>...</c>, extract type riêng
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>(?:[^<]*<v>([^<]*)<\/v>)?/g;
  const typeRe = /\bt="([^"]*)"/;

  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNum  = parseInt(rm[1]);
    const content = rm[2];
    rows[rowNum]  = {};
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(content))) {
      const col  = cm[1];
      let   val  = cm[2] ?? '';
      const tm   = typeRe.exec(cm[0]);
      const type = tm ? tm[1] : '';
      if (type === 's' && val !== '') val = strings[parseInt(val)] ?? '';
      rows[rowNum][col] = val;
    }
  }
  return rows;
}

// ── Số / ngày helpers ─────────────────────────────────────────────────────────
// CafeF lưu tất cả dưới dạng string — KL là số nguyên '22324700'
function parseVol(val) {
  if (val == null || val === '') return 0;
  // Bỏ dấu chấm/phẩy phân cách nghìn, lấy phần nguyên
  const clean = String(val).replace(/\./g, '').replace(/,/g, '').trim();
  return parseInt(clean, 10) || 0;
}

function parseDate(val) { // dd/mm/yyyy → timestamp
  if (!val) return 0;
  const parts = String(val).split('/');
  if (parts.length !== 3) return 0;
  const [d, m, y] = parts;
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`).getTime();
}

// ── Đọc 1 xlsx → [{date, volume, ts}] sort cũ→mới ───────────────────────────
async function readXlsx(filePath) {
  const buf     = fs.readFileSync(filePath);
  const entries = parseZipEntries(buf);

  const sharedXml = await readEntry(entries['xl/sharedStrings.xml']);
  const sheetXml  = await readEntry(entries['xl/worksheets/sheet1.xml']);

  if (!sheetXml) return null;

  const strings = sharedXml ? parseSharedStrings(sharedXml) : [];
  const rows    = parseSheet(sheetXml, strings);

  // Tìm index cột từ header row 1
  const header  = rows[1] || {};
  const colOf   = name => Object.entries(header).find(([,v]) => v === name)?.[0];
  const dateCol    = colOf('Ngay')              || 'A';
  const adjCol     = colOf('GiaDieuChinh')      || 'B';
  const closeCol   = colOf('GiaDongCua')        || 'C';
  const changeCol  = colOf('ThayDoi')           || 'D';
  const volCol     = colOf('KhoiLuongKhopLenh') || 'E';
  const valCol     = colOf('GiaTriKhopLenh')    || 'F';
  const openCol    = colOf('GiaMoCua')          || 'I';
  const highCol    = colOf('GiaCaoNhat')        || 'J';
  const lowCol     = colOf('GiaThapNhat')       || 'K';

  const parseP = raw => raw
    ? parseFloat(String(raw).replace(/\./g, '').replace(',', '.')) || null
    : null;

  const data = [];
  for (const [rNum, cells] of Object.entries(rows)) {
    if (parseInt(rNum) <= 1) continue;
    const dateVal = cells[dateCol];
    if (!dateVal) continue;
    const ts = parseDate(dateVal);
    if (!ts) continue;
    data.push({
      date   : String(dateVal),
      volume : parseVol(cells[volCol]),
      price  : parseP(cells[closeCol]),
      open   : parseP(cells[openCol]),
      high   : parseP(cells[highCol]),
      low    : parseP(cells[lowCol]),
      adj    : parseP(cells[adjCol]),
      val    : parseP(cells[valCol]),    // Giá trị khớp lệnh (tỷ đồng nếu chia 1e9)
      change : cells[changeCol] ? String(cells[changeCol]) : null,
      ts,
    });
  }

  data.sort((a, b) => a.ts - b.ts);
  return data;
}

// ── Phân tích tất cả ─────────────────────────────────────────────────────────
export async function analyzeAll(tmpDir, options = {}) {
  const {
    maPeriod  = 20,
    threshold = 2.0,
    topN      = 264,
  } = options;

  if (!fs.existsSync(tmpDir)) {
    return { error: `Thư mục ${tmpDir} không tồn tại` };
  }

  const files = fs.readdirSync(tmpDir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  if (files.length === 0) {
    return { error: 'Không có file xlsx nào trong thư mục tmp/' };
  }

  const results = [];

  for (const file of files) {
    const symbol   = path.basename(file, path.extname(file)).toUpperCase();
    const filePath = path.join(tmpDir, file);

    let data;
    try {
      data = await readXlsx(filePath);
    } catch (e) {
      console.error(`  ⚠️  ${symbol}: ${e.message}`);
      continue;
    }

    if (!data || data.length < maPeriod + 1) {
      console.log(`  ⏭  ${symbol}: bỏ qua (${data?.length ?? 0} dòng < ${maPeriod + 1})`);
      continue;
    }

    // MA = trung bình maPeriod phiên trước phiên cuối
    const forMA  = data.slice(-(maPeriod + 1), -1);
    const ma     = forMA.reduce((s, d) => s + d.volume, 0) / forMA.length;
    const latest = data[data.length - 1];
    const ratio  = ma > 0 ? latest.volume / ma : 0;

    // topN phiên gần nhất cho chart
    const recent = data.slice(-topN);
    const maLine = recent.map((_, i) => {
      const gi = data.length - recent.length + i;
      if (gi < maPeriod) return null;
      const slice = data.slice(gi - maPeriod, gi);
      return Math.round(slice.reduce((s, d) => s + d.volume, 0) / slice.length);
    });

    // Bollinger Bands trên giá đóng cửa (MA20 ± 2σ)
    const bbPeriod = 20;
    const bbMid = recent.map((_, i) => {
      const gi = data.length - recent.length + i;
      if (gi < bbPeriod) return null;
      const slice = data.slice(gi - bbPeriod, gi);
      const prices = slice.map(d => d.price).filter(p => p != null);
      if (prices.length < bbPeriod) return null;
      return prices.reduce((s, p) => s + p, 0) / prices.length;
    });
    const bbUpper = bbMid.map((mid, i) => {
      if (mid == null) return null;
      const gi = data.length - recent.length + i;
      const slice = data.slice(gi - bbPeriod, gi);
      const prices = slice.map(d => d.price).filter(p => p != null);
      const variance = prices.reduce((s, p) => s + (p - mid) ** 2, 0) / prices.length;
      return parseFloat((mid + 2 * Math.sqrt(variance)).toFixed(2));
    });
    const bbLower = bbMid.map((mid, i) => {
      if (mid == null) return null;
      const gi = data.length - recent.length + i;
      const slice = data.slice(gi - bbPeriod, gi);
      const prices = slice.map(d => d.price).filter(p => p != null);
      const variance = prices.reduce((s, p) => s + (p - mid) ** 2, 0) / prices.length;
      return parseFloat((mid - 2 * Math.sqrt(variance)).toFixed(2));
    });

    // Tính giá tham chiếu, trần, sàn từ GiaDieuChinh (±7%)
    const ref   = latest.adj  ?? latest.price;
    const ceil  = ref ? parseFloat((ref * 1.07).toFixed(2)) : null;
    const floor = ref ? parseFloat((ref * 0.93).toFixed(2)) : null;

    results.push({
      symbol,
      isSurge   : ratio >= threshold,
      ratio     : Math.round(ratio * 100) / 100,
      ma20      : Math.round(ma),
      latestVol : latest.volume,
      latestDate: latest.date,
      session: {
        ref,
        ceil,
        floor,
        open   : latest.open,
        high   : latest.high,
        low    : latest.low,
        close  : latest.price,
        change : latest.change,
        val    : latest.val,
      },
      chart: {
        labels  : recent.map(d => d.date),
        volumes : recent.map(d => d.volume),
        prices  : recent.map(d => d.price),
        opens   : recent.map(d => d.open),
        highs   : recent.map(d => d.high),
        lows    : recent.map(d => d.low),
        ma20    : maLine,
        bbMid,
        bbUpper,
        bbLower,
      },
    });
  }

  // Trả về tất cả surges, frontend tự sort theo lựa chọn người dùng
  const surges = results.filter(r => r.isSurge);

  return {
    scannedFiles: files.length,
    surgeCount  : surges.length,
    threshold,
    maPeriod,
    results     : surges,
  };
}
