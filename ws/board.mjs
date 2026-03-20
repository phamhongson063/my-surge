import https from "https";
import crypto from "crypto";
import { SSI_HEADERS } from "../lib/utils.mjs";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BOARD_INDEX_IDS = ["VNINDEX", "VN30", "HNXIndex", "HNX30", "UpcomIndex"];
const BOARD_TAB_URLS = {
  VN30:  "https://iboard-query.ssi.com.vn/stock/group/VN30",
  hose:  "https://iboard-query.ssi.com.vn/stock/exchange/hose",
  hnx:   "https://iboard-query.ssi.com.vn/stock/exchange/hnx",
  upcom: "https://iboard-query.ssi.com.vn/stock/exchange/upcom",
};

const boardWsClients = new Set(); // Set<{socket, subs: Set<string>}>
const boardTabCache   = new Map(); // tab → data[]
const boardTabPrevMap = new Map(); // tab → Map<sym, stock>  — for diff
let boardPoller = null;
const BOARD_POLL_MS = 1000;

// Các field cần theo dõi để phát hiện thay đổi
const BOARD_DIFF_FIELDS = [
  "matchedPrice", "matchedVolume", "priceChange", "priceChangePercent",
  "best1Bid", "best1BidVol", "best2Bid", "best2BidVol", "best3Bid", "best3BidVol",
  "best1Offer", "best1OfferVol", "best2Offer", "best2OfferVol", "best3Offer", "best3OfferVol",
  "nmTotalTradedQty", "buyForeignQtty", "sellForeignQtty",
];

function computeDiff(tab, newData) {
  const key = s => s.stockSymbol ?? s.code ?? "";
  const newMap = new Map(newData.map(s => [key(s), s]));
  const prev = boardTabPrevMap.get(tab);
  boardTabPrevMap.set(tab, newMap);
  if (!prev) return null; // first time — no diff yet

  const updates = [];
  for (const [k, s] of newMap) {
    const old = prev.get(k);
    if (!old) { updates.push(s); continue; }
    for (const f of BOARD_DIFF_FIELDS) {
      if (old[f] !== s[f]) { updates.push(s); break; }
    }
  }
  return updates; // [] = nothing changed
}

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsSend(socket, obj) {
  if (socket.destroyed) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const len = buf.length;
    let frame;
    if (len < 126) {
      frame = Buffer.allocUnsafe(2 + len);
      frame[0] = 0x81; frame[1] = len;
      buf.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.allocUnsafe(4 + len);
      frame[0] = 0x81; frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      buf.copy(frame, 4);
    } else {
      frame = Buffer.allocUnsafe(10 + len);
      frame[0] = 0x81; frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      buf.copy(frame, 10);
    }
    socket.write(frame);
  } catch {}
}

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
      payloadLen = buf.readUInt16BE(offset + 2); hdrLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2)); hdrLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const totalLen = hdrLen + maskLen + payloadLen;
    if (offset + totalLen > buf.length) break;
    if (opcode === 0x8) { messages.push({ type: "close" }); break; }
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
      try { messages.push({ type: "message", data: JSON.parse(payload.toString("utf8")) }); } catch {}
    }
    offset += totalLen;
  }
  return { messages, remaining: buf.slice(offset) };
}

function fetchSsiBoardTab(tabKey) {
  const targetUrl = BOARD_TAB_URLS[tabKey];
  if (!targetUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    https.get(targetUrl, { headers: SSI_HEADERS }, (rsp) => {
      const chunks = [];
      rsp.on("data", c => chunks.push(c));
      rsp.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : null);
        } catch { resolve(null); }
      });
      rsp.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

function fetchSsiBoardIndex(indexId) {
  const targetUrl = `https://iboard-query.ssi.com.vn/exchange-index/${encodeURIComponent(indexId)}?hasHistory=false`;
  return new Promise((resolve) => {
    https.get(targetUrl, { headers: SSI_HEADERS }, (rsp) => {
      const chunks = [];
      rsp.on("data", c => chunks.push(c));
      rsp.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data ?? null); }
        catch { resolve(null); }
      });
      rsp.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

function getActiveTabsAndSubs() {
  const tabs = new Set();
  let wantIndexes = false;
  for (const client of boardWsClients) {
    for (const s of client.subs) {
      if (s === "indexes") wantIndexes = true;
      else tabs.add(s);
    }
  }
  return { tabs, wantIndexes };
}

function broadcastToSubs(tab, msg) {
  for (const client of boardWsClients) {
    if (client.subs.has(tab)) wsSend(client.socket, msg);
  }
}

function startBoardPoller() {
  if (boardPoller) return;
  boardPoller = setInterval(async () => {
    if (boardWsClients.size === 0) return;
    const { tabs, wantIndexes } = getActiveTabsAndSubs();
    const promises = [];

    for (const tab of tabs) {
      promises.push(fetchSsiBoardTab(tab).then(data => {
        if (!data) return;
        boardTabCache.set(tab, data);
        const diff = computeDiff(tab, data);
        if (diff === null) {
          // First fetch for this tab — broadcast full board
          broadcastToSubs(tab, { type: "board", tab, data });
        } else if (diff.length > 0) {
          // Only push changed stocks
          broadcastToSubs(tab, { type: "update", tab, updates: diff });
        }
        // diff.length === 0 → nothing changed, send nothing
      }));
    }

    if (wantIndexes) {
      promises.push(
        Promise.all(BOARD_INDEX_IDS.map(id => fetchSsiBoardIndex(id).then(d => [id, d])))
          .then(results => {
            const indexData = {};
            for (const [id, d] of results) if (d) indexData[id] = d;
            if (Object.keys(indexData).length) {
              for (const client of boardWsClients) {
                if (client.subs.has("indexes")) wsSend(client.socket, { type: "indexes", data: indexData });
              }
            }
          })
      );
    }

    await Promise.allSettled(promises);
  }, BOARD_POLL_MS);
}

function stopBoardPoller() {
  if (boardPoller) { clearInterval(boardPoller); boardPoller = null; }
}

export function handleBoardWsUpgrade(req, socket) {
  if (!wsHandshake(req, socket)) return;
  const client = { socket, subs: new Set() };
  boardWsClients.add(client);
  console.log(`[WS Board] ➕ connected (total: ${boardWsClients.size})`);
  if (boardWsClients.size === 1) startBoardPoller();

  let recvBuf = Buffer.alloc(0);

  async function handleSubscribe(sub) {
    client.subs.add(sub);
    if (sub === "indexes") {
      const results = await Promise.all(BOARD_INDEX_IDS.map(id => fetchSsiBoardIndex(id).then(d => [id, d])));
      const indexData = {};
      for (const [id, d] of results) if (d) indexData[id] = d;
      if (Object.keys(indexData).length) wsSend(socket, { type: "indexes", data: indexData });
    } else {
      // Gửi cache ngay nếu có
      if (boardTabCache.has(sub)) {
        wsSend(socket, { type: "board", tab: sub, data: boardTabCache.get(sub) });
      }
      // Fetch fresh và seed prevMap để poller tiếp theo có baseline diff
      fetchSsiBoardTab(sub).then(data => {
        if (!data) return;
        boardTabCache.set(sub, data);
        if (!boardTabPrevMap.has(sub)) {
          // Seed prevMap — poller tiếp theo sẽ diff từ đây
          const key = s => s.stockSymbol ?? s.code ?? "";
          boardTabPrevMap.set(sub, new Map(data.map(s => [key(s), s])));
        }
        wsSend(socket, { type: "board", tab: sub, data });
      });
    }
  }

  socket.on("data", (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    const { messages, remaining } = wsParseFrames(recvBuf);
    recvBuf = remaining;
    for (const msg of messages) {
      if (msg.type === "close") { socket.destroy(); return; }
      if (msg.type === "message" && msg.data) {
        const { sub, unsub } = msg.data;
        if (sub) handleSubscribe(sub);
        if (unsub) client.subs.delete(unsub);
      }
    }
  });

  function cleanup() {
    boardWsClients.delete(client);
    console.log(`[WS Board] ➖ disconnected (total: ${boardWsClients.size})`);
    if (boardWsClients.size === 0) stopBoardPoller();
  }
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
