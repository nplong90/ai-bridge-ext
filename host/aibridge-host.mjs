#!/usr/bin/env node
// AI Bridge native-messaging host.
// Chrome launches this process when the extension calls connectNative(). It exposes a tiny
// local HTTP API on 127.0.0.1 and relays each request to the extension over native messaging
// (stdio framing), then returns the extension's reply as the HTTP response. Zero dependencies.
//
// Endpoints:
//   GET  /health            -> { ok, service, port }
//   POST /ask  {prompt, provider?, tts?, lang?}  -> { ok, text, conversationId, images, audio?, provider }
//   POST /tts  {text, lang?}                      -> { ok, audio:{dataUrl,mimeType} }
import http from "node:http";

const PORT = Number(process.env.AIBRIDGE_PORT || 8765);
const KEY = process.env.AIBRIDGE_KEY || "";               // if set, require header x-aibridge-key
const KEEPALIVE = process.env.AIBRIDGE_KEEPALIVE !== "0"; // "0" = let the SW sleep (lower idle cost)
const REQUEST_TIMEOUT_MS = 180000;
const pending = new Map(); // id -> { res, timer }
let seq = 1;

// ---- Native messaging framing: [uint32 LE length][UTF-8 JSON] on stdin/stdout ----
// stdout carries ONLY frames — never console.log here (it would corrupt the stream).
function sendToChrome(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(json); } catch { continue; }
    onChromeMessage(msg);
  }
});
// When the extension's service worker goes away, Chrome closes our stdin — exit cleanly so a
// later reconnect can spawn a fresh host and rebind the port.
process.stdin.on("end", () => process.exit(0));

function onChromeMessage(msg) {
  if (!msg || msg.id == null) return;
  if (msg.op === "pong") return; // keepalive ack
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  p.res.writeHead(200, { "content-type": "application/json" });
  p.res.end(JSON.stringify(msg));
}

// Keepalive: nudge the extension SW every 20s so Chrome doesn't terminate it (idle ~30s), which
// keeps the API instantly ready. Turn off (AIBRIDGE_KEEPALIVE=0) to save resources — the first
// call after the SW sleeps may then be slow or need one retry (the SW reconnects on its alarm).
if (KEEPALIVE) setInterval(() => sendToChrome({ id: 0, op: "ping" }), 20000);

// ---- Local HTTP API ----
function fail(res, code, error) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error }));
}

const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "ai-bridge", port: PORT }));
    return;
  }

  if (req.method === "POST" && (req.url === "/ask" || req.url === "/tts")) {
    if (KEY && req.headers["x-aibridge-key"] !== KEY) return fail(res, 401, "UNAUTHORIZED");
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = body ? JSON.parse(body) : {}; } catch { return fail(res, 400, "BAD_JSON"); }
      const id = seq++;
      const op = req.url === "/tts" ? "tts" : "ask";
      const timer = setTimeout(() => { pending.delete(id); fail(res, 504, "TIMEOUT"); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { res, timer });
      sendToChrome({ id, op, ...payload });
    });
    return;
  }

  fail(res, 404, "NOT_FOUND");
});

server.on("error", (e) => {
  // Port busy (e.g. an old host still shutting down) or bind failure — report and exit; the
  // extension's keepalive alarm will retry the connection shortly.
  sendToChrome({ id: 0, op: "hosterror", error: String(e.message || e) });
  process.exit(1);
});
server.listen(PORT, "127.0.0.1");
