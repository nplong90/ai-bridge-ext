# AI Media Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho AI Bridge extension nhận một file (bất kỳ định dạng Gemini nhận) + prompt qua HTTP API local, upload lên Gemini Web, trả về text kết quả.

**Architecture:** Native host giữ file bytes theo request-id và phát một job nhỏ qua native messaging (kèm `blobUrl` local). Content script trên gemini.google.com fetch bytes rồi đẩy lên Gemini. Path A (forge upload + StreamGenerate) là chính; Path B (mô phỏng kéo-thả, trang tự lo) là fallback. Chi tiết: `docs/superpowers/specs/2026-07-06-ai-audio-bridge-design.md`.

**Tech Stack:** MV3 extension (JS module, không build step), native messaging host (Node, zero-dep), `node --test` cho unit test hàm thuần.

## Global Constraints

- Không thêm dependency: extension và host đều zero-dep (host chỉ dùng `node:http`, `node:*`).
- Hàm thuần (builder request, validate, phân loại) phải test được bằng `node --test`, tách khỏi API trình duyệt.
- MIME pass-through: KHÔNG hardcode định dạng trong logic; allowlist nằm ở config `src/config/gemini-upload.json`, chỉ để cảnh báo, không chặn cứng.
- Mọi hằng số hay đổi theo Google (URL, rpcids, key scrape, template f.req, selectors) nằm trong `src/config/gemini-upload.json`.
- Giữ format phản hồi host hiện có: thành công `{ ok:true, ... }`, lỗi `{ ok:false, error }`.
- Mỗi request dùng chat mới (`newChatUrl`) tránh lẫn ngữ cảnh.
- Native messaging host→extension giới hạn ~1MB: KHÔNG truyền bytes qua native messaging; extension fetch bytes từ `blobUrl`.
- Style: file JS module, comment ngắn giải thích "tại sao", theo đúng giọng code hiện có.

---

## Milestone 0 — Smoke test đường ống (không viết code)

### Task 0: Xác nhận đường ống text sẵn có hoạt động

**Files:** không sửa gì (dùng code hiện tại).

- [ ] **Step 1: Cài native host + load extension**

Chạy `host/install.ps1` để đăng ký native messaging host, load unpacked extension trong Chrome, đăng nhập gemini.google.com trong một tab.

- [ ] **Step 2: Gọi API text và xác nhận có phản hồi**

Run:
```bash
curl -s -X POST http://127.0.0.1:8765/ask -H "content-type: application/json" -d '{"prompt":"say hi in one word","provider":"gemini"}'
```
Expected: JSON `{ "ok": true, "text": "...", "provider": "gemini", ... }` với `text` không rỗng.

- [ ] **Step 3: Ghi nhận kết quả**

Nếu Step 2 trả text → toàn bộ đường ống dùng chung OK; mọi lỗi về sau nằm ở phần file mới. Nếu fail: sửa cài đặt host/đăng nhập TRƯỚC khi sang Milestone 1 (không phải lỗi của plan này).

---

## Milestone 1 — Path A (forge upload + StreamGenerate)

### Task 1: Config `gemini-upload.json` + validator

**Files:**
- Create: `src/config/gemini-upload.json`
- Create: `src/config/upload-config.js`
- Test: `test/upload-config.test.js`

**Interfaces:**
- Produces: `validateUploadConfig(cfg) -> cfg` (throws `Error("BAD_CONFIG:<field>")` nếu thiếu field bắt buộc); `SUPPORTED_MIME_DEFAULT` (array).

- [ ] **Step 1: Viết config JSON**

Create `src/config/gemini-upload.json`:
```json
{
  "capturedOn": "2026-07-06",
  "upload": {
    "url": "https://push.clients6.google.com/upload/",
    "tenantId": "bard-storage",
    "chunkGranularity": 262144
  },
  "generate": {
    "url": "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "hl": "en"
  },
  "scrapeKeys": { "at": "SNlM0e", "bl": "cfb2h", "fsid": "FdrFJe" },
  "freq": { "fileMagic": 4 },
  "selectors": {
    "dropZone": "input[type=file]",
    "composer": ".ql-editor",
    "send": ".send-button button, button[aria-label='Send message']"
  },
  "supportedMime": [
    "audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/aac", "audio/flac", "audio/aiff",
    "video/mp4", "video/mpeg", "video/quicktime", "video/webm", "video/x-msvideo", "video/3gpp",
    "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
    "application/pdf", "text/plain"
  ]
}
```

- [ ] **Step 2: Viết failing test**

Create `test/upload-config.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateUploadConfig, SUPPORTED_MIME_DEFAULT } from "../src/config/upload-config.js";

const cfg = JSON.parse(readFileSync(new URL("../src/config/gemini-upload.json", import.meta.url)));

test("shipped config passes validation", () => {
  assert.equal(validateUploadConfig(cfg), cfg);
});

test("validator rejects missing upload.url", () => {
  const bad = { ...cfg, upload: { tenantId: "x" } };
  assert.throws(() => validateUploadConfig(bad), /BAD_CONFIG:upload.url/);
});

test("default mime list is non-empty and includes audio/ogg", () => {
  assert.ok(SUPPORTED_MIME_DEFAULT.includes("audio/ogg"));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/upload-config.test.js`
Expected: FAIL — `Cannot find module '../src/config/upload-config.js'`.

- [ ] **Step 4: Viết validator**

Create `src/config/upload-config.js`:
```js
// Validate the shape of gemini-upload.json so a bad edit fails loudly, not silently at runtime.
export const SUPPORTED_MIME_DEFAULT = [
  "audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/aac", "audio/flac", "audio/aiff",
  "video/mp4", "video/mpeg", "video/quicktime", "video/webm", "video/x-msvideo", "video/3gpp",
  "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
  "application/pdf", "text/plain",
];

const REQUIRED = ["upload.url", "upload.tenantId", "generate.url", "generate.hl",
  "scrapeKeys.at", "scrapeKeys.bl", "scrapeKeys.fsid", "freq.fileMagic"];

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function validateUploadConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("BAD_CONFIG:root");
  for (const p of REQUIRED) {
    if (get(cfg, p) == null) throw new Error("BAD_CONFIG:" + p);
  }
  if (!Array.isArray(cfg.supportedMime) || cfg.supportedMime.length === 0) {
    throw new Error("BAD_CONFIG:supportedMime");
  }
  return cfg;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/upload-config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/gemini-upload.json src/config/upload-config.js test/upload-config.test.js
git commit -m "feat: add gemini-upload config + validator"
```

### Task 2: `buildGeminiGenerateRequest` (hàm thuần)

**Files:**
- Modify: `src/drivers/gemini.js`
- Test: `test/drivers.test.js`

**Interfaces:**
- Consumes: config object (Task 1) — dùng `generate.url`, `generate.hl`, `freq.fileMagic`.
- Produces: `buildGeminiGenerateRequest({ prompt, fileToken, mime, filename, at, bl, fsid, reqid, sessionBlob, cfg }) -> { url, body }`. `sessionBlob` mặc định `""` (chat mới). `body` = `f.req=<enc>&at=<at>` (giống pattern delete/tts). Cấu trúc f.req khớp HAR:
  `[null, JSON.stringify([[ prompt, 0, null, [[[fileToken, fileMagic, null, mime], filename]], null, null, 0 ], [hl], ["","","",null,null,null,null,null,null,""], sessionBlob ])]`

- [ ] **Step 1: Viết failing test**

Thêm vào `test/drivers.test.js` (và import `buildGeminiGenerateRequest`):
```js
import { buildGeminiGenerateRequest } from "../src/drivers/gemini.js";

test("buildGeminiGenerateRequest embeds prompt, token, mime, filename in f.req", () => {
  const cfg = {
    generate: { url: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", hl: "en" },
    freq: { fileMagic: 4 },
  };
  const { url, body } = buildGeminiGenerateRequest({
    prompt: "đọc nội dung", fileToken: "/contrib_service/ttl_1d/TOK", mime: "audio/ogg",
    filename: "chunk1.ogg", at: "AT_TOK", bl: "BL", fsid: "SID", reqid: 12345, cfg,
  });
  assert.ok(url.startsWith(cfg.generate.url));
  assert.ok(url.includes("f.sid=SID"));
  assert.ok(url.includes("_reqid=12345"));
  assert.ok(url.includes("rt=c"));
  const decoded = decodeURIComponent(body);
  assert.ok(decoded.includes("đọc nội dung"));
  assert.ok(decoded.includes("/contrib_service/ttl_1d/TOK"));
  assert.ok(decoded.includes("audio/ogg"));
  assert.ok(decoded.includes("chunk1.ogg"));
  assert.ok(body.includes("at=AT_TOK"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — `buildGeminiGenerateRequest is not a function` / import không tồn tại.

- [ ] **Step 3: Viết hàm**

Thêm vào `src/drivers/gemini.js` (cạnh `buildGeminiDeleteRequest`):
```js
// Build the StreamGenerate request that Path A POSTs directly (no composer). The inner f.req
// structure was reverse-engineered from a real upload trace (see specs). `sessionBlob` is the
// per-conversation "!Wlml…" token the page normally injects; for a fresh chat we send "" and
// rely on Gemini accepting it — if it rejects, the driver falls back to Path B (drag-drop).
export function buildGeminiGenerateRequest({ prompt, fileToken, mime, filename, at, bl, fsid, reqid, sessionBlob = "", cfg }) {
  const inner = [
    [ prompt, 0, null, [[[fileToken, cfg.freq.fileMagic, null, mime], filename]], null, null, 0 ],
    [cfg.generate.hl],
    ["", "", "", null, null, null, null, null, null, ""],
    sessionBlob,
  ];
  const freq = JSON.stringify([null, JSON.stringify(inner)]);
  const body = new URLSearchParams({ "f.req": freq, at }).toString();
  const qs = new URLSearchParams({
    bl, "f.sid": fsid, hl: cfg.generate.hl, _reqid: String(reqid), rt: "c",
  });
  return { url: cfg.generate.url + "?" + qs.toString(), body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS (tất cả test cũ + test mới).

- [ ] **Step 5: Commit**

```bash
git add src/drivers/gemini.js test/drivers.test.js
git commit -m "feat: add buildGeminiGenerateRequest for file-attached StreamGenerate"
```

### Task 3: MIME check + `parseUploadStartResponse`/`parseUploadFinalize` (hàm thuần)

**Files:**
- Modify: `src/drivers/gemini.js`
- Test: `test/drivers.test.js`

**Interfaces:**
- Produces:
  - `checkMime(mime, supportedList) -> { mime, supported }` (không throw; `supported=false` chỉ để cảnh báo).
  - `uploadStartHeaders({ byteLength, filename, tenantId }) -> { headers, body }`.
  - `isUploadTokenValid(text) -> boolean` (token hợp lệ = bắt đầu `/contrib_service/`).

- [ ] **Step 1: Viết failing test**

Thêm vào `test/drivers.test.js`:
```js
import { checkMime, uploadStartHeaders, isUploadTokenValid } from "../src/drivers/gemini.js";

test("checkMime flags unsupported without blocking", () => {
  assert.deepEqual(checkMime("audio/ogg", ["audio/ogg"]), { mime: "audio/ogg", supported: true });
  assert.deepEqual(checkMime("application/x-weird", ["audio/ogg"]), { mime: "application/x-weird", supported: false });
});

test("uploadStartHeaders sets resumable start headers + filename body", () => {
  const { headers, body } = uploadStartHeaders({ byteLength: 1234, filename: "a.ogg", tenantId: "bard-storage" });
  assert.equal(headers["X-Goog-Upload-Protocol"], "resumable");
  assert.equal(headers["X-Goog-Upload-Command"], "start");
  assert.equal(headers["X-Goog-Upload-Header-Content-Length"], "1234");
  assert.equal(headers["X-Tenant-Id"], "bard-storage");
  assert.equal(body, "File name: a.ogg");
});

test("isUploadTokenValid accepts contrib_service token only", () => {
  assert.equal(isUploadTokenValid("/contrib_service/ttl_1d/abc_XYZ"), true);
  assert.equal(isUploadTokenValid("<html>error</html>"), false);
  assert.equal(isUploadTokenValid(""), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — các hàm chưa tồn tại.

- [ ] **Step 3: Viết các hàm**

Thêm vào `src/drivers/gemini.js`:
```js
// Allowlist is advisory only — Gemini's server is the real authority. We pass any mime through
// and just flag unknown ones so the caller can log a warning.
export function checkMime(mime, supportedList) {
  return { mime, supported: Array.isArray(supportedList) && supportedList.includes(mime) };
}

// Step-1 (start) of Google's resumable upload. Body carries only the filename metadata.
export function uploadStartHeaders({ byteLength, filename, tenantId }) {
  return {
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(byteLength),
      "X-Tenant-Id": tenantId,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "File name: " + filename,
  };
}

// The finalize step returns a plain-text token like "/contrib_service/ttl_1d/…". Anything else
// (empty, HTML error page) means the upload failed → caller triggers Path B.
export function isUploadTokenValid(text) {
  return typeof text === "string" && text.startsWith("/contrib_service/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/gemini.js test/drivers.test.js
git commit -m "feat: add mime check + resumable-upload helpers"
```

### Task 4: `classifyPathAResult` — logic phát hiện A hỏng (hàm thuần)

**Files:**
- Modify: `src/drivers/gemini.js`
- Test: `test/drivers.test.js`

**Interfaces:**
- Produces: `classifyPathAResult({ tokensOk, uploadOk, generateStatus, answer }) -> "ok" | "fallback"`. Trả `"fallback"` khi: thiếu token phiên, upload fail, HTTP generate ≠ 2xx, hoặc answer rỗng.

- [ ] **Step 1: Viết failing test**

Thêm vào `test/drivers.test.js`:
```js
import { classifyPathAResult } from "../src/drivers/gemini.js";

test("classifyPathAResult falls back on each failure signal", () => {
  const ok = { tokensOk: true, uploadOk: true, generateStatus: 200, answer: "hi" };
  assert.equal(classifyPathAResult(ok), "ok");
  assert.equal(classifyPathAResult({ ...ok, tokensOk: false }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, uploadOk: false }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, generateStatus: 400 }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, answer: "" }), "fallback");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — `classifyPathAResult is not a function`.

- [ ] **Step 3: Viết hàm**

Thêm vào `src/drivers/gemini.js`:
```js
// Decide whether Path A produced a usable answer. Any failure signal → tell the driver to run
// Path B (drag-drop) instead. Keeps the fallback trigger in one testable place.
export function classifyPathAResult({ tokensOk, uploadOk, generateStatus, answer }) {
  if (!tokensOk) return "fallback";
  if (!uploadOk) return "fallback";
  if (!(generateStatus >= 200 && generateStatus < 300)) return "fallback";
  if (!answer || !String(answer).trim()) return "fallback";
  return "ok";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/gemini.js test/drivers.test.js
git commit -m "feat: add Path A failure classifier"
```

### Task 5: Native host — `/ask-file` endpoint + `/blob/<id>` route

**Files:**
- Modify: `host/aibridge-host.mjs`
- Test: `test/host.test.js`

**Interfaces:**
- Produces (pure helper, exported for test): `parseAskFileRequest({ headers, query, bodyBuffer }) -> { prompt, mime, filename, lang, path, bytes }` (throws `Error("BAD_REQUEST")` nếu thiếu bytes/mime).
- HTTP: `POST /ask-file` (body = raw bytes; meta qua query `?prompt=&mime=&filename=&lang=&path=`); `GET /blob/<id>` trả bytes.
- Native frame gửi extension: `{ id, op:"askfile", prompt, blobUrl:"http://127.0.0.1:<port>/blob/<id>", mime, filename, lang, path }`.

- [ ] **Step 1: Viết failing test cho parser thuần**

Create `test/host.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskFileRequest } from "../host/aibridge-host.mjs";

test("parseAskFileRequest reads meta from query + bytes from body", () => {
  const r = parseAskFileRequest({
    query: new URLSearchParams("prompt=hi&mime=audio/ogg&filename=a.ogg&path=A"),
    bodyBuffer: Buffer.from([1, 2, 3]),
  });
  assert.equal(r.prompt, "hi");
  assert.equal(r.mime, "audio/ogg");
  assert.equal(r.filename, "a.ogg");
  assert.equal(r.path, "A");
  assert.deepEqual([...r.bytes], [1, 2, 3]);
});

test("parseAskFileRequest rejects empty body", () => {
  assert.throws(() => parseAskFileRequest({ query: new URLSearchParams("mime=audio/ogg"), bodyBuffer: Buffer.alloc(0) }), /BAD_REQUEST/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/host.test.js`
Expected: FAIL — `parseAskFileRequest` chưa export (host chạy server ở top-level; xem Step 3 note).

- [ ] **Step 3: Refactor host để export parser + thêm routes**

Trong `host/aibridge-host.mjs`:

(a) Thêm export hàm thuần (đặt trên phần server):
```js
// Parse a POST /ask-file: meta in the query string, raw file bytes in the body. Kept pure so it
// can be unit-tested without spinning up the server.
export function parseAskFileRequest({ query, bodyBuffer }) {
  const mime = query.get("mime");
  if (!bodyBuffer || bodyBuffer.length === 0 || !mime) throw new Error("BAD_REQUEST");
  return {
    prompt: query.get("prompt") || "",
    mime,
    filename: query.get("filename") || "upload.bin",
    lang: query.get("lang") || "",
    path: query.get("path") || "auto",
    bytes: bodyBuffer,
  };
}
```

(b) Guard server startup so importing the module for tests doesn't bind the port:
```js
const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("aibridge-host.mjs");
```
Bọc `server.listen(...)`, `setInterval` keepalive, và `process.stdin.on(...)` trong `if (IS_MAIN) { ... }`.

(c) Thêm store bytes + routes trong `http.createServer` handler:
```js
const blobs = new Map(); // id -> { bytes, mime, timer }

// GET /blob/<id> — the extension fetches the raw bytes here (localhost is a secure context, so
// the gemini.google.com content script can fetch it without mixed-content errors). One-shot: the
// entry is dropped after it's served so bytes don't linger in memory.
if (req.method === "GET" && req.url.startsWith("/blob/")) {
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
    const blobId = "b" + id;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/host.test.js`
Expected: PASS (2 tests). Import không được bind port (nhờ IS_MAIN guard).

- [ ] **Step 5: Run full suite (không hồi quy)**

Run: `node --test`
Expected: PASS toàn bộ.

- [ ] **Step 6: Commit**

```bash
git add host/aibridge-host.mjs test/host.test.js
git commit -m "feat: native host /ask-file endpoint + /blob byte store"
```

### Task 6: Manifest — thêm host_permissions upload

**Files:**
- Modify: `manifest.json:8`

**Interfaces:** không có API mới; chỉ mở quyền fetch.

- [ ] **Step 1: Thêm host permission**

Sửa mảng `host_permissions` trong `manifest.json`, thêm phần tử:
```json
"https://push.clients6.google.com/*"
```
(giữ nguyên các entry hiện có).

- [ ] **Step 2: Verify JSON hợp lệ**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: in `ok`.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: grant host permission for Gemini upload endpoint"
```

### Task 7: Content script — fetch bytes + chạy Path A

**Files:**
- Modify: `src/content.js`
- Modify: `src/drivers/gemini.js` (thêm method điều phối `askWithFile`)

**Interfaces:**
- Consumes: `buildGeminiGenerateRequest`, `uploadStartHeaders`, `isUploadTokenValid`, `classifyPathAResult`, `scrapeTokens` (Tasks 2–4); config JSON (Task 1).
- Produces (trên `geminiDriver`): `async uploadFileA(bytes, mime, filename, cfg) -> fileToken|null`; `async askWithFile({ bytes, mime, filename, prompt, path, cfg }, ctx) -> { answer, conversationId }`. `ctx` có `waitForResponse` (như `readAnswer`).

- [ ] **Step 1: Thêm Path A upload + orchestration vào driver**

Thêm vào `geminiDriver` trong `src/drivers/gemini.js`:
```js
  // Path A: replicate Google's 2-step resumable upload with the logged-in session cookies
  // (fetch runs in the gemini.google.com content-script context → credentials flow).
  async uploadFileA(bytes, mime, filename, cfg) {
    const { headers, body } = uploadStartHeaders({ byteLength: bytes.byteLength, filename, tenantId: cfg.upload.tenantId });
    const start = await fetch(cfg.upload.url, { method: "POST", headers, body, credentials: "include" });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!start.ok || !uploadUrl) return null;
    const fin = await fetch(uploadUrl, {
      method: "POST",
      headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
      body: bytes, credentials: "include",
    });
    const token = (await fin.text()).trim();
    return isUploadTokenValid(token) ? token : null;
  },

  // Try Path A (headless forge). Returns null-answer signal on any failure so content.js runs B.
  async askWithFile({ bytes, mime, filename, prompt, cfg }, ctx) {
    const html = document.documentElement.innerHTML;
    const { at, bl, fsid } = scrapeTokens(html);
    const tokensOk = !!(at && bl && fsid);
    let uploadOk = false, generateStatus = 0, answer = "", conversationId = null;
    if (tokensOk) {
      const fileToken = await this.uploadFileA(bytes, mime, filename, cfg);
      uploadOk = !!fileToken;
      if (uploadOk) {
        const reqid = 100000 + Math.floor(Math.random() * 800000);
        const { url, body } = buildGeminiGenerateRequest({ prompt, fileToken, mime, filename, at, bl, fsid, reqid, cfg });
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body, credentials: "include",
        });
        generateStatus = r.status;
        const raw = await r.text();
        const parsed = parseGeminiStream(raw);
        answer = parsed.answer || "";
        conversationId = parsed.conversationId;
      }
    }
    const verdict = classifyPathAResult({ tokensOk, uploadOk, generateStatus, answer });
    return { verdict, answer, conversationId };
  },
```
Thêm import ở đầu file: `import { parseGeminiStream } from "../parsers.js";` (đã có) và đảm bảo `buildGeminiGenerateRequest`, `uploadStartHeaders`, `isUploadTokenValid`, `classifyPathAResult` nằm cùng module (đã ở Tasks 2–4).

- [ ] **Step 2: Thêm xử lý ASK-FILE trong content.js**

Thêm listener trong `src/content.js` (sau listener ASK hiện có, cùng cấu trúc):
```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "ASK-FILE") return;
  (async () => {
    try {
      const { pickDriver } = await registry;
      const driver = pickDriver(location.host);
      if (!driver || driver.id !== "gemini") throw new Error("NO_GEMINI_DRIVER");
      if (!(await driver.isLoggedIn())) throw new Error("NOT_AUTHENTICATED");
      const cfg = await (await fetch(chrome.runtime.getURL("src/config/gemini-upload.json"))).json();
      const bytes = new Uint8Array(await (await fetch(msg.blobUrl)).arrayBuffer());
      netBuffer.length = 0;
      const wantB = msg.path === "B";
      let out = null;
      if (!wantB) {
        const a = await driver.askWithFile({ bytes, mime: msg.mime, filename: msg.filename, prompt: msg.prompt, cfg }, { waitForResponse });
        if (a.verdict === "ok") out = { answer: a.answer, conversationId: a.conversationId };
      }
      if (!out) { // Path B fallback (Task 10) — filled in there
        out = await driver.askWithFileDrop({ bytes, mime: msg.mime, filename: msg.filename, prompt: msg.prompt, cfg }, { waitForResponse });
      }
      sendResponse({ ok: true, text: out.answer || "", conversationId: out.conversationId, provider: driver.id });
      driver.deleteConversation(out.conversationId);
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e), provider: null });
    }
  })();
  return true;
})
```
> NOTE: `askWithFileDrop` chưa tồn tại tới Task 8. Trong Task 7, tạm để nhánh fallback ném lỗi rõ ràng: thay dòng gọi `askWithFileDrop` bằng `throw new Error("PATH_A_FAILED")` để Task 7 test được Path A độc lập; Task 8 sẽ thay lại bằng gọi `askWithFileDrop`.

- [ ] **Step 3: Web-accessible config**

Thêm `"src/config/gemini-upload.json"` vào mảng `web_accessible_resources[0].resources` trong `manifest.json` (để content script fetch được).

- [ ] **Step 4: Verify unit suite vẫn xanh**

Run: `node --test`
Expected: PASS (không hồi quy; code mới là browser-only, không phá test thuần).

- [ ] **Step 5: Live test Path A (thủ công, ép path A)**

Reload extension. Chuẩn bị file `test.ogg` nhỏ. Chạy:
```bash
curl -s -X POST "http://127.0.0.1:8765/ask-file?prompt=viết%20nội%20dung%20file%20ra%20text&mime=audio/ogg&filename=test.ogg&path=A" \
  --data-binary @test.ogg -H "content-type: application/octet-stream"
```
Expected: JSON `{ "ok": true, "text": "<nội dung phiên âm>", ... }`.
Nếu trả `PATH_A_FAILED` → ghi nhận: `f.req` forge (session_blob) bị Gemini từ chối. Đây là kết quả HỢP LỆ của mốc này — Path B (Task 8) sẽ xử lý. Ghi lại HTTP status/thân response để Task 8 tham chiếu.

- [ ] **Step 6: Commit**

```bash
git add src/content.js src/drivers/gemini.js manifest.json
git commit -m "feat: Path A file upload + StreamGenerate in content script"
```

### Task 8: Background — wiring `askfile` op

**Files:**
- Modify: `src/background.js`

**Interfaces:**
- Consumes: native frame `{ op:"askfile", prompt, mime, filename, lang, path, blobUrl }`.
- Produces: `askFile({ prompt, mime, filename, path, blobUrl, provider }) -> { text, conversationId, provider }`; `sendAskFile(tabId, payload)`.

- [ ] **Step 1: Thêm sendAskFile + askFile**

Thêm vào `src/background.js` (cạnh `sendAsk`/`ask`):
```js
async function sendAskFile(tabId, payload) {
  const resp = await withTimeout(
    chrome.tabs.sendMessage(tabId, { channel: "cgw", type: "ASK-FILE", ...payload }),
    REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT",
  );
  if (!resp || !resp.ok) throw new Error(resp ? resp.error : "NO_RESPONSE");
  return resp;
}

function askFile(payload) {
  return queue.enqueue(async () => {
    const driver = driverById("gemini"); // file upload is Gemini-only for now
    const tabId = await ensureTab(driver);
    await navigateNewChat(tabId, driver);
    // Path B needs the tab foreground to render; activate it and restore afterward.
    const prevActive = await activateTab(tabId);
    try {
      const resp = await sendAskFile(tabId, {
        prompt: payload.prompt, mime: payload.mime, filename: payload.filename,
        path: payload.path, blobUrl: payload.blobUrl,
      });
      return { text: resp.text, conversationId: resp.conversationId, provider: "gemini" };
    } finally {
      if (prevActive != null) { try { await chrome.tabs.update(prevActive, { active: true }); } catch {} }
    }
  });
}
```

- [ ] **Step 2: Route op trong handleApiOp**

Thêm vào `handleApiOp` (trước nhánh `ask`):
```js
  if (msg.op === "askfile") {
    return askFile(msg).then((r) => ({ ok: true, text: r.text, conversationId: r.conversationId, provider: r.provider }));
  }
```

- [ ] **Step 3: Verify unit suite**

Run: `node --test`
Expected: PASS (không hồi quy).

- [ ] **Step 4: Commit**

```bash
git add src/background.js
git commit -m "feat: background wiring for askfile op"
```

---

## Milestone 2 — Path B fallback + circuit breaker

### Task 9: `createPathPreference` — circuit breaker (hàm thuần)

**Files:**
- Modify: `src/drivers/gemini.js`
- Test: `test/drivers.test.js`

**Interfaces:**
- Produces: `createPathPreference({ threshold = 3 } = {}) -> { prefer(), recordA(ok) }`. `prefer()` trả `"A"` bình thường, `"B"` sau `threshold` lần A hỏng liên tiếp; một lần A thành công reset đếm.

- [ ] **Step 1: Viết failing test**

Thêm vào `test/drivers.test.js`:
```js
import { createPathPreference } from "../src/drivers/gemini.js";

test("createPathPreference trips to B after N consecutive A failures, resets on success", () => {
  const p = createPathPreference({ threshold: 3 });
  assert.equal(p.prefer(), "A");
  p.recordA(false); p.recordA(false);
  assert.equal(p.prefer(), "A"); // still under threshold
  p.recordA(false);
  assert.equal(p.prefer(), "B"); // tripped
  p.recordA(true);
  assert.equal(p.prefer(), "A"); // reset
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — `createPathPreference is not a function`.

- [ ] **Step 3: Viết hàm**

Thêm vào `src/drivers/gemini.js`:
```js
// Circuit breaker: once Path A fails `threshold` times in a row (schema drift), prefer Path B so
// we stop wasting a doomed A attempt on every request. One success flips back to A.
export function createPathPreference({ threshold = 3 } = {}) {
  let consecutiveFails = 0;
  return {
    prefer() { return consecutiveFails >= threshold ? "B" : "A"; },
    recordA(ok) { consecutiveFails = ok ? 0 : consecutiveFails + 1; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/gemini.js test/drivers.test.js
git commit -m "feat: add Path A/B circuit breaker"
```

### Task 10: Path B — `attachViaDrop` + `askWithFileDrop`

**Files:**
- Modify: `src/drivers/gemini.js`
- Modify: `src/content.js`

**Interfaces:**
- Consumes: `startSend` (sẵn có), config selectors (Task 1), `readAnswer`/`waitForResponse`.
- Produces (trên `geminiDriver`): `async attachViaDrop(bytes, mime, filename, cfg) -> boolean`; `async askWithFileDrop({ bytes, mime, filename, prompt, cfg }, ctx) -> { answer, conversationId }`.

- [ ] **Step 1: Thêm attachViaDrop + askWithFileDrop vào driver**

Thêm vào `geminiDriver` trong `src/drivers/gemini.js`:
```js
  // Path B: build a real File and hand it to Gemini's own uploader by setting it on the hidden
  // file input and firing change (the page then runs the exact upload we saw in the HAR and
  // builds its own f.req). Robust to schema changes; needs a foreground tab.
  async attachViaDrop(bytes, mime, filename, cfg) {
    const input = document.querySelector(cfg.selectors.dropZone);
    if (!input) return false;
    const file = new File([bytes], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },

  async askWithFileDrop({ bytes, mime, filename, prompt, cfg }, ctx) {
    const attached = await this.attachViaDrop(bytes, mime, filename, cfg);
    if (!attached) throw new Error("DROP_ATTACH_FAILED");
    // Wait for the page's own upload to finish before sending (the composer's send stays disabled
    // until the attachment resolves). Reuse startSend which waits for the send button.
    await sleep(1500);
    await this.startSend(prompt);
    const raw = await ctx.waitForResponse((url) => /\/StreamGenerate/.test(url), 120000);
    if (!raw) throw new Error("NO_RESPONSE_CAPTURED");
    const parsed = parseGeminiStream(raw);
    return { answer: parsed.answer || "", conversationId: parsed.conversationId };
  },
```
(`sleep` đã được import ở đầu file.)

- [ ] **Step 2: Nối fallback thật trong content.js**

Trong `src/content.js`, thay dòng tạm `throw new Error("PATH_A_FAILED")` (Task 7 Step 2 NOTE) bằng gọi thật:
```js
      if (!out) {
        out = await driver.askWithFileDrop({ bytes, mime: msg.mime, filename: msg.filename, prompt: msg.prompt, cfg }, { waitForResponse });
      }
```
Và xử lý `path === "A"` (ép chỉ A, không fallback) để test riêng:
```js
      if (!out && msg.path === "A") throw new Error("PATH_A_FAILED");
```
(đặt trước nhánh gọi `askWithFileDrop`).

- [ ] **Step 3: Verify unit suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Live test Path B (ép path=B)**

Reload extension.
```bash
curl -s -X POST "http://127.0.0.1:8765/ask-file?prompt=viết%20nội%20dung%20file%20ra%20text&mime=audio/ogg&filename=test.ogg&path=B" \
  --data-binary @test.ogg -H "content-type: application/octet-stream"
```
Expected: JSON `{ "ok": true, "text": "<nội dung>" }`. Nếu selector sai → sửa `selectors.dropZone` trong config (không sửa code).

- [ ] **Step 5: Live test auto (A→B)**

```bash
curl -s -X POST "http://127.0.0.1:8765/ask-file?prompt=...&mime=audio/ogg&filename=test.ogg&path=auto" \
  --data-binary @test.ogg -H "content-type: application/octet-stream"
```
Expected: `{ ok:true, text }` — dù A hay B thắng.

- [ ] **Step 6: Commit**

```bash
git add src/drivers/gemini.js src/content.js
git commit -m "feat: Path B drag-drop fallback wired into auto flow"
```

### Task 11: Nối circuit breaker vào content flow

**Files:**
- Modify: `src/content.js`

**Interfaces:**
- Consumes: `createPathPreference` (Task 9). Một instance module-scope trong content.js để nhớ giữa các request trong cùng đời tab.

- [ ] **Step 1: Thêm preference instance + dùng trong ASK-FILE**

Đầu `src/content.js` (sau import registry):
```js
const pathPref = (await import(chrome.runtime.getURL("src/drivers/gemini.js"))).createPathPreference();
```
> NOTE: nếu top-level await không khả dụng trong content script, khai báo `let pathPref;` và khởi tạo bên trong listener lần đầu (`pathPref ||= (await registry_gemini).createPathPreference()`).

Trong listener ASK-FILE, thay `const wantB = msg.path === "B";` bằng:
```js
      const forced = msg.path === "A" || msg.path === "B" ? msg.path : null;
      const wantB = forced ? forced === "B" : pathPref.prefer() === "B";
```
Và sau khi chạy A: `if (!forced || forced === "A") pathPref.recordA(out != null && !wantB);`
(record chỉ khi thực sự thử A).

- [ ] **Step 2: Verify unit suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 3: Live smoke (auto vẫn chạy)**

Lặp lại lệnh `path=auto` ở Task 10 Step 5 hai lần liên tiếp; cả hai đều trả `{ ok:true }`.

- [ ] **Step 4: Commit**

```bash
git add src/content.js
git commit -m "feat: wire circuit breaker into ask-file path selection"
```

### Task 12: Tài liệu README + host README

**Files:**
- Modify: `README.md`
- Modify: `host/README.md`

- [ ] **Step 1: Ghi endpoint mới**

Thêm mục vào `README.md` mô tả `POST /ask-file` (query meta + body bytes, param `path=A|B|auto`), và ví dụ `curl` như Task 10 Step 4. Ghi rõ: chỉ Gemini, một file/request, extension không parse JSON kết quả.

- [ ] **Step 2: Ghi giới hạn + config**

Thêm ghi chú: file lớn giữ trong host tối đa ~3 phút; định dạng hỗ trợ nằm ở `src/config/gemini-upload.json`; khi Gemini đổi UI/schema chỉ sửa config.

- [ ] **Step 3: Commit**

```bash
git add README.md host/README.md
git commit -m "docs: document /ask-file endpoint and config"
```

---

---

## Milestone 3 — UI test trong extension (file picker side panel)

### Task 13: Đính file trong side panel để test bằng tay

Cho phép người dùng chọn/kéo-thả file ngay trong side panel (không cần host/curl). Side panel đọc bytes → gửi thẳng background → `askFile()` (Task 8). Đây vừa là tính năng vừa là UI để test Path A/B bằng tay. File-upload chỉ dùng Gemini.

**Files:**
- Modify: `src/sidepanel.html`
- Modify: `src/sidepanel.js`
- Modify: `src/content.js` (cho phép nhận bytes inline base64, không chỉ blobUrl)
- Modify: `src/background.js` (handler `ASK-FILE-FROM-PANEL` + truyền `bytesB64` qua `askFile`)

**Interfaces:**
- Consumes: `askFile(payload)`, `sendAskFile` (Task 8); ASK-FILE listener (Task 7/10).
- Produces: message `ASK-FILE-FROM-PANEL { prompt, mime, filename, bytesB64, path }`; ASK-FILE message giờ chấp nhận `bytesB64` HOẶC `blobUrl`.

- [ ] **Step 1: content.js — nhận bytes inline hoặc blobUrl**

Trong `src/content.js` ASK-FILE listener, thay dòng lấy bytes hiện tại:
```js
const bytes = new Uint8Array(await (await fetch(msg.blobUrl)).arrayBuffer());
```
bằng:
```js
let bytes;
if (msg.blobUrl) {
  bytes = new Uint8Array(await (await fetch(msg.blobUrl)).arrayBuffer());
} else if (msg.bytesB64) {
  const bin = atob(msg.bytesB64);
  bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
} else {
  throw new Error("NO_FILE_BYTES");
}
```

- [ ] **Step 2: background.js — pass bytesB64 qua askFile + handler panel**

Trong `askFile(payload)`, sửa lời gọi `sendAskFile` để chuyển tiếp cả hai transport (chỉ một cái có giá trị):
```js
      const resp = await sendAskFile(tabId, {
        prompt: payload.prompt, mime: payload.mime, filename: payload.filename,
        path: payload.path, blobUrl: payload.blobUrl, bytesB64: payload.bytesB64,
      });
```
Thêm handler mới trong `chrome.runtime.onMessage.addListener` (cạnh `ASK-FROM-PANEL`), mirror pattern writeState + sendResponse của nó:
```js
  if (msg && msg.type === "ASK-FILE-FROM-PANEL") {
    const provider = "gemini"; // file upload is Gemini-only
    writeState({ status: "sending", prompt: msg.prompt, text: "", error: "", provider, images: [] });
    askFile({ prompt: msg.prompt, mime: msg.mime, filename: msg.filename, path: msg.path || "auto", bytesB64: msg.bytesB64 }).then(
      (r) => { writeState({ status: "ok", prompt: msg.prompt, text: r.text, error: "", provider, images: [] }); sendResponse({ ok: true, text: r.text, provider }); },
      (e) => { const error = String(e.message || e); writeState({ status: "error", prompt: msg.prompt, text: "", error, provider, images: [] }); sendResponse({ ok: false, error, provider }); },
    );
    return true;
  }
```

- [ ] **Step 3: sidepanel.html — nút đính file + tên file**

Trong `.composer-foot`, thêm nút đính file bên trái nút Gửi (giữ layout hiện có), và một hàng hiển thị tên file dưới textarea. Thêm vào trong `.composer`:
```html
      <input id="file" type="file" hidden />
```
Sửa `.composer-foot` để thêm nút 📎 cạnh hint (trái), giữ nút send bên phải:
```html
      <div class="composer-foot">
        <div style="display:flex;align-items:center;gap:8px;">
          <button id="attach" class="new-btn" type="button" title="Đính file gửi lên Gemini">📎 File</button>
          <span id="filename" class="hint"></span>
        </div>
        <button id="send" class="send" type="button">
          <span class="spinner"></span>
          <span class="send-label">Gửi</span>
        </button>
      </div>
```
(Xoá hàng hint `Ctrl+Enter` cũ trong composer-foot nếu trùng — giữ một cấu trúc foot duy nhất như trên.)

- [ ] **Step 4: sidepanel.js — đọc file → gửi ASK-FILE-FROM-PANEL**

Thêm gần đầu (sau các `$` khai báo):
```js
const fileEl = $("file");
const attachBtn = $("attach");
const filenameEl = $("filename");
let attached = null; // { bytesB64, mime, filename }

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

attachBtn.addEventListener("click", () => fileEl.click());
fileEl.addEventListener("change", async () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) { attached = null; filenameEl.textContent = ""; return; }
  const buf = await f.arrayBuffer();
  attached = { bytesB64: bytesToB64(buf), mime: f.type || "application/octet-stream", filename: f.name };
  filenameEl.textContent = f.name;
});

// Drag-drop onto the composer.
const composerEl = document.querySelector(".composer");
composerEl.addEventListener("dragover", (e) => { e.preventDefault(); });
composerEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  attached = { bytesB64: bytesToB64(buf), mime: f.type || "application/octet-stream", filename: f.name };
  filenameEl.textContent = f.name;
});
```
Sửa `send()` để rẽ nhánh khi có file:
```js
function send() {
  const prompt = promptEl.value.trim();
  if (!prompt && !attached) { promptEl.focus(); return; }
  setLoading(true);
  setStatus("info", "Đang tạo chat mới và gửi…");
  answerEl.classList.remove("show");
  if (attached) {
    chrome.runtime.sendMessage(
      { type: "ASK-FILE-FROM-PANEL", prompt, mime: attached.mime, filename: attached.filename, bytesB64: attached.bytesB64, path: "auto" },
      () => void chrome.runtime.lastError,
    );
  } else {
    chrome.runtime.sendMessage({ type: "ASK-FROM-PANEL", prompt, provider: providerEl.value }, () => void chrome.runtime.lastError);
  }
}
```
Trong `newBtn` handler, reset file: thêm `attached = null; filenameEl.textContent = ""; fileEl.value = "";`.

- [ ] **Step 5: Verify unit suite (không hồi quy)**

Run: `node --test`
Expected: PASS (43/43; code mới là browser-only, không phá test thuần).

- [ ] **Step 6: Live test qua extension (thủ công)**

Reload extension, mở side panel, đăng nhập Gemini. Bấm 📎 chọn (hoặc kéo-thả) một file audio nhỏ, nhập prompt "viết nội dung file ra text", bấm Gửi.
Expected: status "Đang gửi…" → khung trả lời hiện text Gemini sinh. Đây là đường test bằng tay không cần curl/host.

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel.html src/sidepanel.js src/content.js src/background.js
git commit -m "feat: attach/drag-drop file in side panel to test upload via extension"
```

---

## Ghi chú rủi ro triển khai

- **`session_blob` trong f.req (Path A):** khả năng cao Gemini từ chối StreamGenerate forge cho chat mới nếu blob rỗng. Nếu Task 7 Step 5 cho thấy A luôn hỏng, KHÔNG cố sửa lâu — Path B (Task 10) là đường chính thực dụng; A vẫn giữ để thử trước và circuit breaker sẽ tự né sau vài lần hỏng.
- **Selector Path B:** nếu `input[type=file]` không phải điểm nhận đúng, thử biến thể drop-event trên khung chat; cập nhật `selectors` trong config, không sửa logic.
- **Kích thước file:** giới hạn 200MB ở host là chặn thô; native messaging không tải bytes nên không phải nút thắt. Chunk/nén do tool ngoài lo.
