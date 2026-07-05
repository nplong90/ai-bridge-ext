# ChatGPT Web Wrapper Extension — Implementation Plan

> ⚠️ **SUPERSEDED IN PART (2026-07-04).** Live testing (Playwright + real session) proved the
> "forge fetch for SEND" approach in Tasks 2–5 is **not viable** — ChatGPT enforces client-minted
> sentinel proof/turnstile tokens (403), API traffic bypasses `window.fetch`, and `backend-api`
> also requires an `Authorization: Bearer` token. The shipped implementation uses **UI-drive send +
> DOM read + forge-delete-with-Bearer**. See the updated design doc
> [2026-07-04-chatgpt-web-wrapper-extension-design.md](../specs/2026-07-04-chatgpt-web-wrapper-extension-design.md)
> §4 and §10. Still valid from this plan: **Task 1** (scaffold/manifest/test runner) and **Task 7's
> `queue.js`** (serial queue, unchanged). Modules `parser.js`/`sentinel.js`/`interceptor.js`/`endpoints.js`
> were removed and replaced by `shared.js` + a rewritten `content.js`/`background.js`.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that sends a text prompt to ChatGPT using the browser's logged-in session and returns the answer text (new chat → forge send → capture SSE → delete chat), driven from a test popup.

**Architecture:** A MAIN-world interceptor forges `POST /backend-api/f/conversation` directly (reusing the page's sentinel tokens via a harvest+mint strategy) and reads the SSE stream through a pure delta-encoding parser; a content script bridges it to a background service worker that owns the ChatGPT tab and serializes requests; a popup drives it for testing. Pure logic (SSE parser, endpoint/body builders, token-header assembly, request queue) is unit-tested with `node --test`; browser-integration modules are verified manually against a real ChatGPT tab.

**Tech Stack:** Chrome MV3 (service worker `type:module`, ES modules everywhere), vanilla JS, `node --test` (Node ≥18, zero dependencies).

## Global Constraints

- Target browser: Chrome MV3. Manifest v3 only.
- Language: vanilla JavaScript, ES modules (`import`/`export`). No bundler, no npm runtime deps.
- Tests: `node --test` (built-in). Test files end in `.test.js`. No test framework dependency.
- Auth model: rely on the browser's existing ChatGPT **session cookie** — never store or transmit credentials.
- All API paths and sentinel header names live only in `src/endpoints.js` — no hardcoded paths elsewhere.
- Send is **text-only** in v1. Image/multimodal is documented in the spec §7 but **out of scope** here.
- Serial execution: at most **one** in-flight ChatGPT request at a time (background queue).
- Send-message endpoint: `POST /backend-api/f/conversation`. New chat = `parent_message_id:"client-created-root"` with **no** `conversation_id`. Delete = `PATCH /backend-api/conversation/{id}` body `{"is_visible":false}`.
- Default request timeout: 60000 ms.

---

## File Structure

```
ws_ext/
  manifest.json            # MV3 manifest (static config, MAIN-world injection wiring)
  src/
    endpoints.js           # API paths, sentinel header names, request-body builders (pure)
    parser.js              # SSE delta-encoding v1 → { text, conversationId, done } (pure)
    sentinel.js            # token harvest cache + header-bundle assembly + mint (MAIN world)
    interceptor.js         # MAIN world: patch fetch, forge send + delete, wire parser
    content.js             # isolated world: inject interceptor module, bridge postMessage ↔ runtime
    background.js          # service worker: tab lifecycle, serial queue, timeout, routing
    popup.html
    popup.js               # test UI: prompt input, result + status display
  test/
    endpoints.test.js
    parser.test.js
    sentinel.test.js
    queue.test.js
```

Files that change together live together: pure modules under `src/` are imported both by the browser (as ES modules via `chrome-extension://` URLs) and by Node tests directly.

---

### Task 1: Project scaffold, git, manifest, test runner

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `.gitignore`
- Create: `src/endpoints.js` (placeholder export so the module graph resolves)
- Create: `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a loadable MV3 extension shell and a working `npm test` → `node --test` pipeline.

- [ ] **Step 1: Initialize git** (the working directory is not yet a git repo)

Run:
```bash
cd "c:/Users/DT0038/Desktop/ws_ext"
git init
```
Expected: `Initialized empty Git repository`.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "chatgpt-web-wrapper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 4: Create `manifest.json`** (complete MV3 wiring, incl. MAIN-world injection assets)

```json
{
  "manifest_version": 3,
  "name": "ChatGPT Web Wrapper (dev)",
  "version": "0.1.0",
  "description": "Send a prompt to ChatGPT via the logged-in web session and get the answer text.",
  "permissions": ["scripting", "tabs"],
  "host_permissions": ["https://chatgpt.com/*", "https://*.oaiusercontent.com/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "action": { "default_popup": "src/popup.html", "default_title": "ChatGPT Web Wrapper" },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["src/content.js"],
      "run_at": "document_start"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/interceptor.js", "src/sentinel.js", "src/parser.js", "src/endpoints.js"],
      "matches": ["https://chatgpt.com/*"]
    }
  ]
}
```

- [ ] **Step 5: Create placeholder `src/endpoints.js`** so the module graph resolves before Task 2 fills it

```js
// Filled in by Task 2.
export const PLACEHOLDER = true;
```

- [ ] **Step 6: Write a smoke test** `test/smoke.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACEHOLDER } from "../src/endpoints.js";

test("test runner works and modules import", () => {
  assert.equal(PLACEHOLDER, true);
});
```

- [ ] **Step 7: Run the test to verify the pipeline**

Run: `npm test`
Expected: `tests 1` / `pass 1` / `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold MV3 extension, manifest, and node --test pipeline"
```

---

### Task 2: `endpoints.js` — API paths, header names, body builders

**Files:**
- Modify: `src/endpoints.js` (replace placeholder)
- Test: `test/endpoints.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ORIGIN = "https://chatgpt.com"`
  - `PATHS = { conversation, conversationById(id), chatRequirementsPrepare, chatRequirementsFinalize }`
  - `SENTINEL_HEADERS = { chatRequirements, proof, turnstile }` (exact header-name strings)
  - `buildTextMessageBody({ prompt, messageId, createTime, model })` → send-request body object for a **new** chat
  - `buildDeleteBody()` → `{ is_visible: false }`

- [ ] **Step 1: Write the failing test** `test/endpoints.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PATHS, SENTINEL_HEADERS, buildTextMessageBody, buildDeleteBody } from "../src/endpoints.js";

test("paths are correct", () => {
  assert.equal(PATHS.conversation, "/backend-api/f/conversation");
  assert.equal(PATHS.conversationById("abc-123"), "/backend-api/conversation/abc-123");
});

test("sentinel header names match the protocol", () => {
  assert.equal(SENTINEL_HEADERS.chatRequirements, "openai-sentinel-chat-requirements-token");
  assert.equal(SENTINEL_HEADERS.proof, "openai-sentinel-proof-token");
  assert.equal(SENTINEL_HEADERS.turnstile, "openai-sentinel-turnstile-token");
});

test("new-chat text body has no conversation_id and uses client-created-root", () => {
  const body = buildTextMessageBody({ prompt: "hello", messageId: "m1", createTime: 1783147668.888, model: "auto" });
  assert.equal(body.action, "next");
  assert.equal(body.parent_message_id, "client-created-root");
  assert.ok(!("conversation_id" in body), "new chat must omit conversation_id");
  assert.equal(body.model, "auto");
  assert.deepEqual(body.supported_encodings, ["v1"]);
  const msg = body.messages[0];
  assert.equal(msg.id, "m1");
  assert.equal(msg.author.role, "user");
  assert.equal(msg.content.content_type, "text");
  assert.deepEqual(msg.content.parts, ["hello"]);
});

test("delete body hides the conversation", () => {
  assert.deepEqual(buildDeleteBody(), { is_visible: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/endpoints.test.js`
Expected: FAIL — `buildTextMessageBody is not a function` (and others).

- [ ] **Step 3: Write `src/endpoints.js`**

```js
export const ORIGIN = "https://chatgpt.com";

export const PATHS = {
  conversation: "/backend-api/f/conversation",
  conversationById: (id) => `/backend-api/conversation/${id}`,
  chatRequirementsPrepare: "/backend-api/sentinel/chat-requirements/prepare",
  chatRequirementsFinalize: "/backend-api/sentinel/chat-requirements/finalize",
};

export const SENTINEL_HEADERS = {
  chatRequirements: "openai-sentinel-chat-requirements-token",
  proof: "openai-sentinel-proof-token",
  turnstile: "openai-sentinel-turnstile-token",
};

export function buildTextMessageBody({ prompt, messageId, createTime, model = "auto" }) {
  return {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: createTime,
        content: { content_type: "text", parts: [prompt] },
        metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
      },
    ],
    parent_message_id: "client-created-root",
    model,
    timezone_offset_min: new Date().getTimezoneOffset(),
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ["v1"],
  };
}

export function buildDeleteBody() {
  return { is_visible: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/endpoints.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/endpoints.js test/endpoints.test.js
git commit -m "feat: endpoints module with paths, header names, and body builders"
```

---

### Task 3: `parser.js` — SSE delta-encoding v1 parser

This is the core testable unit. It consumes the SSE text stream and reconstructs the assistant answer.

**Files:**
- Create: `src/parser.js`
- Test: `test/parser.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createSseAccumulator()` → object `{ push(rawEventDataString), text, conversationId, done }`
  - `push(s)`: feed one SSE `data:` payload string (the part after `data: `). Mutates internal state.
  - `text` (getter): the assistant answer accumulated so far.
  - `conversationId` (getter): captured from the `resume_conversation_token` event, or `null`.
  - `done` (getter): `true` once `[DONE]` has been pushed.
  - Also export `parseSseChunk(rawChunk)` → array of `data:` payload strings extracted from a raw network chunk (splits on lines, strips `data: ` prefix, ignores `event:` lines).

- [ ] **Step 1: Write the failing test** `test/parser.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseAccumulator, parseSseChunk } from "../src/parser.js";

test("parseSseChunk extracts data payloads and ignores event lines", () => {
  const chunk = 'event: delta\ndata: {"a":1}\n\ndata: "v1"\n\ndata: [DONE]\n';
  assert.deepEqual(parseSseChunk(chunk), ['{"a":1}', '"v1"', "[DONE]"]);
});

test("captures conversation_id from resume_conversation_token", () => {
  const acc = createSseAccumulator();
  acc.push(JSON.stringify({ type: "resume_conversation_token", conversation_id: "conv-9" }));
  assert.equal(acc.conversationId, "conv-9");
  assert.equal(acc.done, false);
});

test("accumulates append deltas on parts/0", () => {
  const acc = createSseAccumulator();
  acc.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "Hel" }));
  acc.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "lo" }));
  assert.equal(acc.text, "Hello");
});

test("handles batched patch op wrapping appends", () => {
  const acc = createSseAccumulator();
  acc.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "A" }));
  acc.push(JSON.stringify({
    o: "patch",
    v: [
      { p: "/message/content/parts/0", o: "append", v: "B" },
      { p: "/message/status", o: "replace", v: "finished_successfully" },
    ],
  }));
  assert.equal(acc.text, "AB");
});

test("initial add op seeds parts from the full message object", () => {
  const acc = createSseAccumulator();
  acc.push(JSON.stringify({
    p: "", o: "add",
    v: { message: { content: { content_type: "text", parts: ["seed"] } }, conversation_id: "c1" },
  }));
  acc.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "-more" }));
  assert.equal(acc.text, "seed-more");
});

test("[DONE] marks done", () => {
  const acc = createSseAccumulator();
  acc.push("[DONE]");
  assert.equal(acc.done, true);
});

test("ignores unrelated system messages and empty parts", () => {
  const acc = createSseAccumulator();
  acc.push(JSON.stringify({ p: "", o: "add", v: { message: { author: { role: "system" }, content: { parts: [""] } } } }));
  assert.equal(acc.text, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/parser.test.js`
Expected: FAIL — `createSseAccumulator is not a function`.

- [ ] **Step 3: Write `src/parser.js`**

```js
// Parses ChatGPT's SSE "delta_encoding v1" stream into the assistant answer text.
// The stream sends JSON-pointer ops (add/append/replace) plus batched "patch" ops.

export function parseSseChunk(rawChunk) {
  const payloads = [];
  for (const line of rawChunk.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) {
      payloads.push(trimmed.slice(5).trimStart());
    }
  }
  return payloads;
}

const PART0 = "/message/content/parts/0";

export function createSseAccumulator() {
  let text = "";
  let conversationId = null;
  let done = false;

  function applyOp(op) {
    if (!op || typeof op !== "object") return;
    const { p, o, v } = op;
    if (o === "add" && (p === "" || p == null) && v && v.message) {
      const parts = v.message?.content?.parts;
      const author = v.message?.author?.role;
      if (author === "assistant" && Array.isArray(parts) && typeof parts[0] === "string") {
        text = parts[0];
      }
      if (v.conversation_id) conversationId = v.conversation_id;
      return;
    }
    if (o === "patch" && Array.isArray(v)) {
      for (const sub of v) applyOp(sub);
      return;
    }
    if (o === "append" && p === PART0 && typeof v === "string") {
      text += v;
      return;
    }
  }

  return {
    push(payload) {
      if (payload === "[DONE]") { done = true; return; }
      let obj;
      try { obj = JSON.parse(payload); } catch { return; }
      if (obj && obj.type === "resume_conversation_token" && obj.conversation_id) {
        conversationId = obj.conversation_id;
        return;
      }
      if (obj && obj.conversation_id && !conversationId) conversationId = obj.conversation_id;
      applyOp(obj);
    },
    get text() { return text; },
    get conversationId() { return conversationId; },
    get done() { return done; },
  };
}
```

> Note: the `add` seed only overwrites `text` for `author:"assistant"` messages so that the
> user-echo and system messages in the stream do not clobber the answer. The seed test uses
> a message without an author role — adjust: the seed test's message has no `author`, so it
> will NOT seed. Fix the test's expectation OR add `author.role:"assistant"`. Use the latter:

- [ ] **Step 3b: Correct the seed test to use an assistant author**

In `test/parser.test.js`, change the "initial add op seeds parts" test's pushed object to include the author:
```js
  acc.push(JSON.stringify({
    p: "", o: "add",
    v: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["seed"] } }, conversation_id: "c1" },
  }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/parser.test.js`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parser.js test/parser.test.js
git commit -m "feat: SSE delta-encoding v1 parser for assistant answer + conversation id"
```

---

### Task 4: `sentinel.js` — token harvest cache + header-bundle assembly

The fragile, isolated part. This task builds the **pure, testable** pieces: a harvest cache that records the latest tokens/ids the page emits, and a function that assembles the request headers from a token bundle. The live *mint* (calling the page SDK) is wired in Task 5 against the real page; here we define its interface and a fallback flag.

**Files:**
- Create: `src/sentinel.js`
- Test: `test/sentinel.test.js`

**Interfaces:**
- Consumes: `SENTINEL_HEADERS` from `endpoints.js`.
- Produces:
  - `createTokenCache()` → `{ harvestFromHeaders(headersLike), get() , has() }`
    - `harvestFromHeaders(h)`: given a `Headers` object or plain object of request headers, records any of `oai-device-id`, `oai-client-version`, and the three sentinel tokens it finds.
    - `get()` → `{ deviceId, clientVersion, chatRequirements, proof, turnstile }` (missing = `undefined`).
    - `has()` → `true` if all of `deviceId`, `clientVersion`, `chatRequirements`, `proof` are present (turnstile optional).
  - `assembleSendHeaders(bundle)` → plain header object for the forged `POST` (Content-Type + oai-* + sentinel-* headers, omitting undefined turnstile).

- [ ] **Step 1: Write the failing test** `test/sentinel.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenCache, assembleSendHeaders } from "../src/sentinel.js";

test("harvests ids and tokens from a plain header object", () => {
  const cache = createTokenCache();
  cache.harvestFromHeaders({
    "oai-device-id": "dev-1",
    "oai-client-version": "prod-abc",
    "openai-sentinel-chat-requirements-token": "req-1",
    "openai-sentinel-proof-token": "proof-1",
    "openai-sentinel-turnstile-token": "turn-1",
    "content-type": "application/json",
  });
  const b = cache.get();
  assert.equal(b.deviceId, "dev-1");
  assert.equal(b.clientVersion, "prod-abc");
  assert.equal(b.chatRequirements, "req-1");
  assert.equal(b.proof, "proof-1");
  assert.equal(b.turnstile, "turn-1");
  assert.equal(cache.has(), true);
});

test("harvest is case-insensitive and works with a Headers instance", () => {
  const cache = createTokenCache();
  const h = new Headers();
  h.set("OAI-Device-Id", "dev-2");
  h.set("OpenAI-Sentinel-Proof-Token", "proof-2");
  cache.harvestFromHeaders(h);
  assert.equal(cache.get().deviceId, "dev-2");
  assert.equal(cache.get().proof, "proof-2");
});

test("has() is false until required fields present", () => {
  const cache = createTokenCache();
  cache.harvestFromHeaders({ "oai-device-id": "d" });
  assert.equal(cache.has(), false);
});

test("assembleSendHeaders emits sentinel headers and omits missing turnstile", () => {
  const headers = assembleSendHeaders({
    deviceId: "d", clientVersion: "v", chatRequirements: "r", proof: "p",
  });
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["oai-device-id"], "d");
  assert.equal(headers["oai-client-version"], "v");
  assert.equal(headers["openai-sentinel-chat-requirements-token"], "r");
  assert.equal(headers["openai-sentinel-proof-token"], "p");
  assert.ok(!("openai-sentinel-turnstile-token" in headers));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sentinel.test.js`
Expected: FAIL — `createTokenCache is not a function`.

- [ ] **Step 3: Write `src/sentinel.js`**

```js
import { SENTINEL_HEADERS } from "./endpoints.js";

const DEVICE_ID = "oai-device-id";
const CLIENT_VERSION = "oai-client-version";

function readHeader(headersLike, name) {
  if (!headersLike) return undefined;
  if (typeof headersLike.get === "function") {
    return headersLike.get(name) ?? undefined; // Headers is case-insensitive
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headersLike)) {
    if (key.toLowerCase() === lower) return headersLike[key];
  }
  return undefined;
}

export function createTokenCache() {
  const bundle = {
    deviceId: undefined,
    clientVersion: undefined,
    chatRequirements: undefined,
    proof: undefined,
    turnstile: undefined,
  };
  const set = (k, v) => { if (v != null) bundle[k] = v; };
  return {
    harvestFromHeaders(h) {
      set("deviceId", readHeader(h, DEVICE_ID));
      set("clientVersion", readHeader(h, CLIENT_VERSION));
      set("chatRequirements", readHeader(h, SENTINEL_HEADERS.chatRequirements));
      set("proof", readHeader(h, SENTINEL_HEADERS.proof));
      set("turnstile", readHeader(h, SENTINEL_HEADERS.turnstile));
    },
    get() { return { ...bundle }; },
    has() {
      return Boolean(bundle.deviceId && bundle.clientVersion && bundle.chatRequirements && bundle.proof);
    },
  };
}

export function assembleSendHeaders(bundle) {
  const headers = {
    "content-type": "application/json",
    [DEVICE_ID]: bundle.deviceId,
    [CLIENT_VERSION]: bundle.clientVersion,
    [SENTINEL_HEADERS.chatRequirements]: bundle.chatRequirements,
    [SENTINEL_HEADERS.proof]: bundle.proof,
  };
  if (bundle.turnstile) headers[SENTINEL_HEADERS.turnstile] = bundle.turnstile;
  return headers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sentinel.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sentinel.js test/sentinel.test.js
git commit -m "feat: sentinel token harvest cache and send-header assembly"
```

---

### Task 5: `interceptor.js` — MAIN world: patch fetch, forge send + delete

Runs in the page's MAIN world (has access to the same-origin session cookie and the page's sentinel machinery). Patches `fetch` to harvest tokens, then forges the send + delete. Verified manually against the real ChatGPT tab.

**Files:**
- Create: `src/interceptor.js`

**Interfaces:**
- Consumes: `createTokenCache`, `assembleSendHeaders` (sentinel.js); `createSseAccumulator`, `parseSseChunk` (parser.js); `PATHS`, `ORIGIN`, `buildTextMessageBody`, `buildDeleteBody` (endpoints.js).
- Produces: listens for `window.postMessage({ source:"cgw-content", type:"ASK", id, prompt })`; replies with `window.postMessage({ source:"cgw-interceptor", type:"RESULT"|"ERROR", id, text?, conversationId?, error? })`.

- [ ] **Step 1: Write `src/interceptor.js`**

```js
import { createTokenCache, assembleSendHeaders } from "./sentinel.js";
import { createSseAccumulator, parseSseChunk } from "./parser.js";
import { PATHS, ORIGIN, buildTextMessageBody, buildDeleteBody } from "./endpoints.js";

const cache = createTokenCache();

// 1) Patch fetch to harvest tokens/ids from every real request the page makes.
const nativeFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  try {
    if (init && init.headers) cache.harvestFromHeaders(new Headers(init.headers));
  } catch { /* ignore harvest errors */ }
  return nativeFetch(input, init);
};

function uuid() {
  return crypto.randomUUID();
}

async function forgeSend(prompt) {
  if (!cache.has()) {
    throw new Error("NO_TOKENS"); // Task 6 maps this to the UI fallback / clear error
  }
  const body = buildTextMessageBody({
    prompt,
    messageId: uuid(),
    createTime: Date.now() / 1000,
    model: "auto",
  });
  const res = await nativeFetch(ORIGIN + PATHS.conversation, {
    method: "POST",
    headers: assembleSendHeaders(cache.get()),
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (res.status === 401 || res.status === 403) throw new Error("NOT_AUTHENTICATED");
  if (!res.ok || !res.body) throw new Error("SEND_FAILED_" + res.status);

  const acc = createSseAccumulator();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (!acc.done) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const payload of parseSseChunk(decoder.decode(value, { stream: true }))) {
      acc.push(payload);
    }
  }
  return { text: acc.text, conversationId: acc.conversationId };
}

async function forgeDelete(conversationId) {
  if (!conversationId) return;
  try {
    await nativeFetch(ORIGIN + PATHS.conversationById(conversationId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDeleteBody()),
      credentials: "include",
    });
  } catch { /* best-effort cleanup; do not block result */ }
}

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "cgw-content" || msg.type !== "ASK") return;
  try {
    const { text, conversationId } = await forgeSend(msg.prompt);
    window.postMessage({ source: "cgw-interceptor", type: "RESULT", id: msg.id, text, conversationId }, ORIGIN);
    forgeDelete(conversationId); // fire-and-forget cleanup
  } catch (err) {
    window.postMessage({ source: "cgw-interceptor", type: "ERROR", id: msg.id, error: String(err.message || err) }, ORIGIN);
  }
});

window.postMessage({ source: "cgw-interceptor", type: "READY" }, ORIGIN);
```

- [ ] **Step 2: Manual smoke check of module load** (no automated test — MAIN-world/browser only)

Deferred to Task 9 end-to-end verification. For now just confirm the file parses:
Run: `node --check src/interceptor.js`
Expected: no output (syntax OK). *(Import resolution against `chrome-extension://` is browser-only; `--check` only validates syntax.)*

- [ ] **Step 3: Commit**

```bash
git add src/interceptor.js
git commit -m "feat: MAIN-world interceptor forging send+delete over harvested tokens"
```

---

### Task 6: `content.js` — isolated-world bridge

Injects the interceptor module into the MAIN world and relays messages between the page and the background service worker.

**Files:**
- Create: `src/content.js`

**Interfaces:**
- Consumes: `interceptor.js` messages (`cgw-interceptor`), and `chrome.runtime` messages from background.
- Produces: forwards `{type:"ASK", id, prompt}` from background into the page as `cgw-content` postMessage; sends `RESULT`/`ERROR`/`READY` back to background via `chrome.runtime.sendMessage`.

- [ ] **Step 1: Write `src/content.js`**

```js
// Isolated world. Injects the MAIN-world interceptor as an ES module, then bridges messages.
const url = chrome.runtime.getURL("src/interceptor.js");
const script = document.createElement("script");
script.type = "module";
script.src = url;
(document.head || document.documentElement).appendChild(script);

// Page (MAIN world) -> background
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "cgw-interceptor") return;
  chrome.runtime.sendMessage({ channel: "cgw", ...msg });
});

// Background -> page (MAIN world)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "ASK") return;
  window.postMessage({ source: "cgw-content", type: "ASK", id: msg.id, prompt: msg.prompt }, location.origin);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/content.js`
Expected: no output. *(chrome APIs are undefined in Node — do not execute, only syntax-check.)*

- [ ] **Step 3: Commit**

```bash
git add src/content.js
git commit -m "feat: content-script bridge injecting interceptor and relaying messages"
```

---

### Task 7: `background.js` — service worker: tab lifecycle + serial queue

Owns the ChatGPT tab and enforces one-request-at-a-time. The queue logic is extracted into a pure, testable helper.

**Files:**
- Create: `src/background.js`
- Create: `src/queue.js`
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: `content.js`/interceptor `RESULT`/`ERROR` runtime messages; popup `ASK` runtime messages.
- Produces:
  - `src/queue.js`: `createSerialQueue()` → `{ enqueue(taskFn) → Promise, size }` — runs one `taskFn` at a time, FIFO; a rejected task does not block the next.
  - `background.js`: message handler for `{type:"ASK-FROM-POPUP", prompt}` → resolves with `{text}` or `{error}`.

- [ ] **Step 1: Write the failing test** `test/queue.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "../src/queue.js";

test("runs tasks one at a time in FIFO order", async () => {
  const q = createSerialQueue();
  const order = [];
  const mk = (n, ms) => () => new Promise((r) => setTimeout(() => { order.push(n); r(n); }, ms));
  const results = await Promise.all([q.enqueue(mk(1, 30)), q.enqueue(mk(2, 5)), q.enqueue(mk(3, 1))]);
  assert.deepEqual(order, [1, 2, 3], "must not interleave despite differing delays");
  assert.deepEqual(results, [1, 2, 3]);
});

test("a rejected task does not block the next", async () => {
  const q = createSerialQueue();
  const bad = q.enqueue(() => Promise.reject(new Error("boom")));
  await assert.rejects(bad, /boom/);
  const good = await q.enqueue(() => Promise.resolve("ok"));
  assert.equal(good, "ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue.test.js`
Expected: FAIL — `createSerialQueue is not a function`.

- [ ] **Step 3: Write `src/queue.js`**

```js
export function createSerialQueue() {
  let tail = Promise.resolve();
  let size = 0;
  return {
    enqueue(taskFn) {
      size += 1;
      const run = tail.then(taskFn, taskFn); // run regardless of prior outcome
      // advance tail without propagating rejection into the chain
      tail = run.then(() => { size -= 1; }, () => { size -= 1; });
      return run;
    },
    get size() { return size; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/queue.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Write `src/background.js`**

```js
import { createSerialQueue } from "./queue.js";

const CHATGPT_URL = "https://chatgpt.com/";
const REQUEST_TIMEOUT_MS = 60000;
const queue = createSerialQueue();

// id -> { resolve, reject, timer }
const pending = new Map();

async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (tabs.length > 0) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: CHATGPT_URL, pinned: true, active: false });
  // wait for the content script to announce READY
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(onReady); reject(new Error("TAB_LOAD_TIMEOUT")); }, REQUEST_TIMEOUT_MS);
    function onReady(msg) {
      if (msg && msg.channel === "cgw" && msg.type === "READY") {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onReady);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(onReady);
  });
  return tab.id;
}

function ask(prompt) {
  return queue.enqueue(async () => {
    const tabId = await ensureTab();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("TIMEOUT")); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      chrome.tabs.sendMessage(tabId, { channel: "cgw", type: "ASK", id, prompt });
    });
  });
}

// Results/errors coming back from the interceptor (via content script)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.channel === "cgw" && (msg.type === "RESULT" || msg.type === "ERROR")) {
    const entry = pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.type === "RESULT") entry.resolve({ text: msg.text, conversationId: msg.conversationId });
      else entry.reject(new Error(msg.error || "UNKNOWN"));
    }
    return; // no response needed
  }
  // Popup asks
  if (msg && msg.type === "ASK-FROM-POPUP") {
    ask(msg.prompt).then(
      (r) => sendResponse({ ok: true, text: r.text }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) }),
    );
    return true; // async response
  }
});
```

- [ ] **Step 6: Verify syntax of background**

Run: `node --check src/background.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/queue.js src/background.js test/queue.test.js
git commit -m "feat: background service worker with serial queue, tab lifecycle, timeout"
```

---

### Task 8: `popup.html` / `popup.js` — test UI

**Files:**
- Create: `src/popup.html`
- Create: `src/popup.js`

**Interfaces:**
- Consumes: background `{type:"ASK-FROM-POPUP", prompt}` → `{ok, text?|error?}`.
- Produces: nothing downstream (leaf).

- [ ] **Step 1: Write `src/popup.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { width: 360px; font: 13px system-ui, sans-serif; padding: 10px; }
    textarea { width: 100%; box-sizing: border-box; height: 70px; }
    button { margin-top: 6px; padding: 6px 12px; }
    #status { color: #666; margin: 6px 0; min-height: 16px; }
    #out { white-space: pre-wrap; border: 1px solid #ddd; padding: 8px; margin-top: 6px; max-height: 300px; overflow: auto; }
  </style>
</head>
<body>
  <textarea id="prompt" placeholder="Nhập prompt..."></textarea>
  <button id="send">Gửi</button>
  <div id="status"></div>
  <div id="out"></div>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/popup.js`**

```js
const $ = (id) => document.getElementById(id);

$("send").addEventListener("click", () => {
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  $("status").textContent = "Đang gửi...";
  $("out").textContent = "";
  $("send").disabled = true;
  chrome.runtime.sendMessage({ type: "ASK-FROM-POPUP", prompt }, (resp) => {
    $("send").disabled = false;
    if (chrome.runtime.lastError) {
      $("status").textContent = "Lỗi: " + chrome.runtime.lastError.message;
      return;
    }
    if (resp && resp.ok) {
      $("status").textContent = "Xong ✓ (chat đã xoá)";
      $("out").textContent = resp.text;
    } else {
      $("status").textContent = "Lỗi: " + (resp ? resp.error : "no response");
    }
  });
});
```

- [ ] **Step 3: Verify syntax**

Run: `node --check src/popup.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/popup.html src/popup.js
git commit -m "feat: test popup for prompt input and result display"
```

---

### Task 9: End-to-end manual verification

No new files. Confirm the whole flow against a real logged-in ChatGPT session.

**Files:** none.

**Interfaces:** exercises the full chain popup → background → content → interceptor → ChatGPT → back.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all tests pass (`endpoints`, `parser`, `sentinel`, `queue`, `smoke`), `fail 0`.

- [ ] **Step 2: Load the unpacked extension**

In Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `ws_ext` folder. Confirm no manifest errors.

- [ ] **Step 3: Be logged in**

Open `https://chatgpt.com` in a tab and confirm you are logged in (a normal chat loads). Send **one** normal message manually — this primes the page so the interceptor can harvest a full token bundle.

- [ ] **Step 4: Send via the popup**

Click the extension icon → type `2+2 = ?` → **Gửi**.
Expected: status shows `Đang gửi...` then `Xong ✓ (chat đã xoá)`, and the answer text appears in the output box.

- [ ] **Step 5: Verify new-chat + delete**

Refresh `https://chatgpt.com`. Expected: the `2+2` conversation does **not** appear in the sidebar (created new then hidden via PATCH). Check DevTools → Network on the ChatGPT tab: one `POST /backend-api/f/conversation` (200, SSE) and one `PATCH /backend-api/conversation/<id>` returning `{"success":true}`.

- [ ] **Step 6: Verify the NO_TOKENS path**

In a fresh browser profile logged into ChatGPT but where the page has made no requirements request yet, sending immediately may error `NO_TOKENS`. Confirm the popup shows a clear error rather than hanging, and that after sending one manual message it works. *(This documents the harvest dependency; the UI-drive fallback is a v1.1 follow-up noted in the spec §3.3.)*

- [ ] **Step 7: Commit any fixes discovered during verification**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end verification"
```

---

## Notes for the implementer

- **Token harvest dependency:** the interceptor can only forge a send once it has harvested a full token bundle from a real page request (Step 3/6 above). If `cache.has()` is false, it errors `NO_TOKENS`. The spec's UI-drive fallback (§3.3) is intentionally **not** built in v1 — keep the error path clean so v1.1 can add it.
- **Do not log token values.** Tokens and device id are sensitive; never `console.log` the bundle contents.
- **Model:** `model:"auto"` matches the HAR. Do not hardcode a specific `gpt-*` slug.
- **Image/multimodal is out of scope** (spec §7). Do not add `files`/`multimodal_text` code in v1.
