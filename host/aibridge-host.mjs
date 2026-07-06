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
//   POST /ask-file (raw bytes body, meta in query) -> { ok, text, conversationId, images, audio?, provider }
//   GET  /blob/<id>          -> raw bytes held for the extension to fetch (one-shot)
import http from "node:http";
import crypto from "node:crypto";

// True only when this file is the process entry point (Chrome/launcher run it directly) — false
// when another module (e.g. the test file) imports it, so importing never binds the port.
const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("aibridge-host.mjs");

const PORT = Number(process.env.AIBRIDGE_PORT || 8765);
const KEY = process.env.AIBRIDGE_KEY || "";               // if set, require header x-aibridge-key
const KEEPALIVE = process.env.AIBRIDGE_KEEPALIVE !== "0"; // "0" = let the SW sleep (lower idle cost)
const REQUEST_TIMEOUT_MS = 180000;
const pending = new Map(); // id -> { res, timer }
const blobs = new Map(); // id -> { bytes, mime, timer }
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
if (IS_MAIN) {
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
}

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
if (IS_MAIN && KEEPALIVE) setInterval(() => sendToChrome({ id: 0, op: "ping" }), 20000);

// ---- Local HTTP API ----
function fail(res, code, error) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error }));
}

// A strict mime token: type/subtype of word/./+/- chars only. Rejects CR/LF and anything else
// that could be smuggled into a response header (entry.mime is written to content-type verbatim).
const MIME_RE = /^[a-zA-Z0-9][\w.+-]*\/[\w.+-]+$/;

// Parse a POST /ask-file: meta in the query string, raw file bytes in the body. Kept pure so it
// can be unit-tested without spinning up the server.
export function parseAskFileRequest({ query, bodyBuffer }) {
  const mime = query.get("mime");
  if (!bodyBuffer || bodyBuffer.length === 0 || !mime) throw new Error("BAD_REQUEST");
  if (!MIME_RE.test(mime)) throw new Error("BAD_REQUEST");
  return {
    prompt: query.get("prompt") || "",
    mime,
    filename: query.get("filename") || "upload.bin",
    lang: query.get("lang") || "",
    path: query.get("path") || "auto",
    bytes: bodyBuffer,
  };
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

  // GET /blob/<id> — the extension fetches the raw bytes here (localhost is a secure context, so
  // the gemini.google.com content script can fetch it without mixed-content errors). One-shot: the
  // entry is dropped after it's served so bytes don't linger in memory.
  if (req.method === "GET" && req.url.startsWith("/blob/")) {
    if (KEY && req.headers["x-aibridge-key"] !== KEY) return fail(res, 401, "UNAUTHORIZED");
    const id = req.url.slice("/blob/".length);
    const entry = blobs.get(id);
    if (!entry) return fail(res, 404, "NO_BLOB");
    clearTimeout(entry.timer);
    blobs.delete(id);
    res.writeHead(200, { "content-type": entry.mime });
    res.end(entry.bytes);
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/ask-file")) {
    if (KEY && req.headers["x-aibridge-key"] !== KEY) return fail(res, 401, "UNAUTHORIZED");
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { chunks.push(c); size += c.length; if (size > 200e6) req.destroy(); });
    req.on("end", () => {
      let parsed;
      try {
        const query = new URL(req.url, "http://127.0.0.1").searchParams;
        parsed = parseAskFileRequest({ query, bodyBuffer: Buffer.concat(chunks) });
      } catch (e) { return fail(res, 400, String(e.message || e)); }
      const id = seq++;
      const blobId = crypto.randomUUID();
      // hold bytes ~3 min; if the extension never fetches, drop them
      const timer = setTimeout(() => blobs.delete(blobId), 180000);
      blobs.set(blobId, { bytes: parsed.bytes, mime: parsed.mime, timer });
      const rtimer = setTimeout(() => { pending.delete(id); blobs.delete(blobId); fail(res, 504, "TIMEOUT"); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { res, timer: rtimer });
      sendToChrome({
        id, op: "askfile", prompt: parsed.prompt, mime: parsed.mime, filename: parsed.filename,
        lang: parsed.lang, path: parsed.path, blobUrl: `http://127.0.0.1:${PORT}/blob/${blobId}`,
      });
    });
    return;
  }

  fail(res, 404, "NOT_FOUND");
});

if (IS_MAIN) {
  server.on("error", (e) => {
    // Port busy (e.g. an old host still shutting down) or bind failure — report and exit; the
    // extension's keepalive alarm will retry the connection shortly.
    sendToChrome({ id: 0, op: "hosterror", error: String(e.message || e) });
    process.exit(1);
  });
  server.listen(PORT, "127.0.0.1");
}
