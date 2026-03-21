import https from "https";
import crypto from "crypto";
import { SSI_HEADERS } from "../lib/utils.mjs";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BOARD_INDEX_IDS = ["VNINDEX", "VN30", "HNXIndex", "HNX30", "UpcomIndex"];
const BOARD_TAB_URLS = {
  VN30: "https://iboard-query.ssi.com.vn/stock/group/VN30",
  hose: "https://iboard-query.ssi.com.vn/stock/exchange/hose",
  hnx: "https://iboard-query.ssi.com.vn/stock/exchange/hnx",
  upcom: "https://iboard-query.ssi.com.vn/stock/exchange/upcom",
};

const boardWsClients = new Set();
const boardTabCache = new Map();
const boardTabPrevMap = new Map();
const pendingTabFetches = new Map();
let lastIndexDataStr = "";
let boardPoller = null;
const BOARD_POLL_MS = 1000;
const FETCH_TIMEOUT_MS = 5000; // Timeout 5s cho API (Issue 3)
const MAX_BUFFER_SIZE = 1024 * 1024;

const BOARD_DIFF_FIELDS = [
  "matchedPrice",
  "matchedVolume",
  "priceChange",
  "priceChangePercent",
  "best1Bid",
  "best1BidVol",
  "best2Bid",
  "best2BidVol",
  "best3Bid",
  "best3BidVol",
  "best1Offer",
  "best1OfferVol",
  "best2Offer",
  "best2OfferVol",
  "best3Offer",
  "best3OfferVol",
  "nmTotalTradedQty",
  "buyForeignQtty",
  "sellForeignQtty",
];

// --- CORE UTILS ---

function computeDiff(tab, newData) {
  const key = (s) => s.stockSymbol ?? s.code ?? "";
  const newMap = new Map(newData.map((s) => [key(s), s]));
  const prev = boardTabPrevMap.get(tab);
  boardTabPrevMap.set(tab, newMap);
  if (!prev) return null;

  const updates = [];
  for (const [k, s] of newMap) {
    const old = prev.get(k);
    if (!old) {
      updates.push(s);
      continue;
    }
    for (const f of BOARD_DIFF_FIELDS) {
      if (old[f] !== s[f]) {
        updates.push(s);
        break;
      }
    }
  }
  return updates;
}

function wsSend(socket, obj) {
  if (socket.destroyed || !socket.writable) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const len = buf.length;
    let frame;
    if (len < 126) {
      frame = Buffer.allocUnsafe(2 + len);
      frame[0] = 0x81;
      frame[1] = len;
      buf.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.allocUnsafe(4 + len);
      frame[0] = 0x81;
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      buf.copy(frame, 4);
    } else {
      frame = Buffer.allocUnsafe(10 + len);
      frame[0] = 0x81;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      buf.copy(frame, 10);
    }
    socket.write(frame, (err) => {
      if (err) socket.destroy();
    });
  } catch (e) {
    console.error("[WS] Write error:", e.message);
  }
}

// --- DATA FETCHING WITH TIMEOUT ---

function fetchWithTimeout(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: SSI_HEADERS }, (rsp) => {
      const chunks = [];
      rsp.on("data", (c) => chunks.push(c));
      rsp.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(j.data ?? (Array.isArray(j) ? j : null));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function fetchSsiBoardIndexAll() {
  const results = await Promise.all(
    BOARD_INDEX_IDS.map((id) => {
      const url = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(
        id
      )}?hasHistory=false`;
      return fetchWithTimeout(url).then((d) => [id, d]);
    })
  );
  const indexData = {};
  for (const [id, d] of results) if (d) indexData[id] = d;
  return indexData;
}

async function getOrFetchTab(sub) {
  if (boardTabCache.has(sub) && boardTabPrevMap.has(sub))
    return boardTabCache.get(sub);
  if (pendingTabFetches.has(sub)) return pendingTabFetches.get(sub);

  const fetchTask = (async () => {
    try {
      const data = await fetchWithTimeout(BOARD_TAB_URLS[sub]);
      if (data) {
        boardTabCache.set(sub, data);
        const key = (s) => s.stockSymbol ?? s.code ?? "";
        boardTabPrevMap.set(sub, new Map(data.map((s) => [key(s), s])));
      }
      return data;
    } finally {
      pendingTabFetches.delete(sub);
    }
  })();
  pendingTabFetches.set(sub, fetchTask);
  return fetchTask;
}

// --- POLLER CONTROL ---

function stopBoardPoller() {
  if (boardPoller) {
    clearInterval(boardPoller);
    boardPoller = null;
    lastIndexDataStr = "";
  }
}

function startBoardPoller() {
  if (boardPoller) return;
  boardPoller = setInterval(async () => {
    if (boardWsClients.size === 0) return stopBoardPoller();

    const tabs = new Set();
    let wantIndexes = false;
    for (const client of boardWsClients) {
      for (const s of client.subs) {
        if (s === "indexes") wantIndexes = true;
        else tabs.add(s);
      }
    }

    const promises = [];
    for (const tab of tabs) {
      promises.push(
        fetchWithTimeout(BOARD_TAB_URLS[tab]).then((data) => {
          if (!data) return;
          boardTabCache.set(tab, data);
          const diff = computeDiff(tab, data);
          const payload =
            diff === null
              ? { type: "board", tab, data }
              : { type: "update", tab, updates: diff };
          if (diff === null || diff.length > 0) {
            for (const c of boardWsClients)
              if (c.subs.has(tab)) wsSend(c.socket, payload);
          }
        })
      );
    }

    if (wantIndexes) {
      promises.push(
        fetchSsiBoardIndexAll().then((indexData) => {
          const currentStr = JSON.stringify(indexData);
          if (
            currentStr !== lastIndexDataStr &&
            Object.keys(indexData).length
          ) {
            lastIndexDataStr = currentStr;
            for (const c of boardWsClients)
              if (c.subs.has("indexes"))
                wsSend(c.socket, { type: "indexes", data: indexData });
          }
        })
      );
    }
    await Promise.allSettled(promises);
  }, BOARD_POLL_MS);
}

// --- MAIN HANDLER ---

export function handleBoardWsUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );

  const client = { socket, subs: new Set() };
  boardWsClients.add(client);
  if (boardWsClients.size === 1) startBoardPoller();

  let recvBuf = Buffer.alloc(0);
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || recvBuf.length === 0 || socket.destroyed) return;
    isProcessing = true;

    try {
      while (true) {
        if (socket.destroyed) break; // Issue 2: Kiểm tra destroy trong vòng lặp

        const { messages, remaining } = wsParseFrames(recvBuf);
        recvBuf = remaining;
        if (messages.length === 0) break;

        for (const msg of messages) {
          if (msg.type === "close") {
            socket.destroy();
            return;
          }
          if (msg.type === "message" && msg.data) {
            const { sub, unsub } = msg.data;
            if (unsub) client.subs.delete(unsub);
            if (sub) {
              client.subs.add(sub);
              if (sub === "indexes") {
                const data = lastIndexDataStr
                  ? JSON.parse(lastIndexDataStr)
                  : await fetchSsiBoardIndexAll();
                // Issue 1: Không gửi {} nếu fetch thất bại (cold start)
                if (Object.keys(data).length > 0) {
                  if (!lastIndexDataStr)
                    lastIndexDataStr = JSON.stringify(data);
                  wsSend(socket, { type: "indexes", data });
                }
              } else {
                const data = await getOrFetchTab(sub);
                if (data) wsSend(socket, { type: "board", tab: sub, data });
              }
            }
          }
        }
      }
    } finally {
      isProcessing = false;
      if (recvBuf.length > 0 && !socket.destroyed) setImmediate(processQueue);
    }
  }

  socket.on("data", (chunk) => {
    if (recvBuf.length + chunk.length > MAX_BUFFER_SIZE)
      return socket.destroy();
    recvBuf = Buffer.concat([recvBuf, chunk]);
    processQueue();
  });

  const cleanup = () => {
    boardWsClients.delete(client);
    if (boardWsClients.size === 0) stopBoardPoller();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

// (wsParseFrames giữ nguyên logic như bản trước)
function wsParseFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let hdrLen = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      hdrLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      hdrLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const totalLen = hdrLen + maskLen + payloadLen;
    if (offset + totalLen > buf.length) break;

    if (opcode === 0x8) {
      messages.push({ type: "close" });
      break;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      const maskOffset = offset + hdrLen;
      const dataOffset = maskOffset + maskLen;
      const payload = Buffer.allocUnsafe(payloadLen);
      if (masked) {
        for (let i = 0; i < payloadLen; i++)
          payload[i] = buf[dataOffset + i] ^ buf[maskOffset + (i % 4)];
      } else {
        buf.copy(payload, 0, dataOffset, dataOffset + payloadLen);
      }
      try {
        messages.push({
          type: "message",
          data: JSON.parse(payload.toString("utf8")),
        });
      } catch {}
    }
    offset += totalLen;
  }
  return { messages, remaining: buf.slice(offset) };
}
