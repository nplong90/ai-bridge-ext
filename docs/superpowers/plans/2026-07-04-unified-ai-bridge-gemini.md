# Unified AI Bridge (Gemini core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the ChatGPT extension into a pluggable multi-provider "bridge" (driver per site) and add a verified Gemini driver, selectable from the Side Panel.

**Architecture:** A provider-agnostic core (background queue + tab management + Side Panel + persisted state) talks to per-site **drivers** behind one interface. `content.js` picks the driver by `location.host`; a registry lists drivers so adding a provider = one file + one line. Send is UI-driven (tokens can't be forged); read is from the DOM; delete is forged per-provider (ChatGPT: PATCH+Bearer; Gemini: batchexecute `GzXR5e`+`at`). All mechanics verified live on real accounts.

**Tech Stack:** Chrome MV3 (service worker `type:module`, ES modules), vanilla JS, `node --test` (zero deps).

## Global Constraints

- Chrome MV3 only; vanilla JS ES modules; no bundler/npm runtime deps.
- Tests: `node --test`; test files `*.test.js`.
- Auth: rely on the browser's existing logged-in session cookies; never store credentials.
- Send is text-only this round (images/relay deferred — spec §12); the contract already carries `images`/`provider` fields.
- One in-flight request at a time (serial queue).
- Driver interface (exact): `{ id, hostMatch(host)->bool, newChatUrl, capabilities:{images}, isLoggedIn()->bool, send(prompt, images)->{text, conversationId}, deleteConversation(conversationId) }`.
- Public contract: request `{type:"ASK-FROM-PANEL", prompt, images?, provider?}`; internal to content `{channel:"cgw", type:"ASK", prompt}`; response `{ok, text?, conversationId?, provider, error?}`.
- Default provider when unspecified: `chatgpt`.
- Verified Gemini facts: composer `.ql-editor`; send `button[aria-label="Send message"]`; streaming `button[aria-label*="Stop" i]`; answer `.model-response-text`; conv id from URL `/app/<id>`; tokens regex from page HTML `"SNlM0e"`=at,`"cfb2h"`=bl,`"FdrFJe"`=f.sid; delete `POST /_/BardChatUi/data/batchexecute?rpcids=GzXR5e` body `f.req=[[["GzXR5e","[\"c_<id>\"]",null,"generic"]]]&at=<at>`.
- Verified ChatGPT facts: composer `#prompt-textarea`; send `[data-testid="send-button"]`; streaming `[data-testid="stop-button"]`; answer `[data-message-author-role="assistant"]`; conv id from URL `/c/<id>`; token `GET /api/auth/session`→`accessToken`; delete `PATCH /backend-api/conversation/<id>` `{is_visible:false}` + `Authorization: Bearer`.

## File Structure

```
src/
  shared.js            # generic helpers: validateAsk, waitFor, readStable, typeInto, sleep (pure/DOM utils)
  drivers/
    index.js           # registry: DRIVERS[], pickDriver(host), driverById(id), DRIVER_META
    chatgpt.js         # ChatGPT driver + parseChatgptConvId
    gemini.js          # Gemini driver + scrapeTokens, parseGeminiConvId, buildGeminiDeleteRequest
  content.js           # host -> pickDriver -> driver.send/deleteConversation; bridge; READY
  background.js        # provider-aware tab mgmt + serial queue + new-chat nav + persisted state
  queue.js             # unchanged
  sidepanel.html/js    # provider <select> from DRIVER_META + prompt + answer + persisted state
  manifest.json        # both hosts; content_scripts both; WAR for shared+drivers
test/
  shared.test.js       # rewritten: validateAsk, waitFor, readStable
  drivers.test.js      # pickDriver/driverById + per-driver pure helpers
  queue.test.js        # unchanged
```

Old `shared.js` (ChatGPT `PATHS/SELECTORS/parseConvId/buildDeleteBody`) is superseded: its ChatGPT-specifics move into `drivers/chatgpt.js`; `shared.js` becomes provider-agnostic.

---

### Task 1: `shared.js` — provider-agnostic helpers

**Files:**
- Modify: `src/shared.js` (replace entire contents)
- Test: `test/shared.test.js` (replace entire contents)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sleep(ms) -> Promise`
  - `validateAsk(req) -> { prompt, images, provider }` (throws `EMPTY_REQUEST`/`BAD_REQUEST`)
  - `waitFor(predicate, {tries,interval}) -> Promise<boolean>`
  - `readStable(readFn, {tries,interval,stable}) -> Promise<string>`
  - `typeInto(editor, text) -> void` (DOM; focus + `execCommand insertText`)

- [ ] **Step 1: Replace `test/shared.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAsk, waitFor, readStable } from "../src/shared.js";

test("validateAsk accepts prompt", () => {
  assert.deepEqual(validateAsk({ prompt: "hi" }), { prompt: "hi", images: [], provider: null });
});

test("validateAsk passes provider + images through", () => {
  const r = validateAsk({ prompt: "", images: [{ data: "x" }], provider: "gemini" });
  assert.equal(r.provider, "gemini");
  assert.equal(r.images.length, 1);
});

test("validateAsk rejects empty prompt with no images", () => {
  assert.throws(() => validateAsk({ prompt: "   " }), /EMPTY_REQUEST/);
});

test("validateAsk rejects non-object", () => {
  assert.throws(() => validateAsk(null), /BAD_REQUEST/);
});

test("waitFor returns true when predicate satisfied", async () => {
  let n = 0;
  const ok = await waitFor(() => ++n >= 2, { tries: 5, interval: 1 });
  assert.equal(ok, true);
});

test("waitFor returns false on timeout", async () => {
  const ok = await waitFor(() => false, { tries: 3, interval: 1 });
  assert.equal(ok, false);
});

test("readStable returns value once stable", async () => {
  const val = await readStable(() => "done", { tries: 10, interval: 1, stable: 3 });
  assert.equal(val, "done");
});

test("readStable returns empty when readFn never yields", async () => {
  const val = await readStable(() => "", { tries: 3, interval: 1, stable: 3 });
  assert.equal(val, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shared.test.js`
Expected: FAIL — `validateAsk is not a function` (old shared.js has no such export).

- [ ] **Step 3: Replace `src/shared.js`**

```js
// Provider-agnostic helpers shared by all drivers (browser) and Node tests.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Validate + normalize the public ASK contract.
export function validateAsk(req) {
  if (!req || typeof req !== "object") throw new Error("BAD_REQUEST");
  const prompt = typeof req.prompt === "string" ? req.prompt : "";
  const images = Array.isArray(req.images) ? req.images : [];
  if (!prompt.trim() && images.length === 0) throw new Error("EMPTY_REQUEST");
  return { prompt, images, provider: req.provider || null };
}

// Poll predicate() until truthy; resolve true, or false after `tries`.
export async function waitFor(predicate, { tries = 100, interval = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return false;
}

// Poll readFn() until it returns a non-empty value unchanged across `stable` reads.
export async function readStable(readFn, { tries = 100, interval = 100, stable = 3 } = {}) {
  let last = "";
  let count = 0;
  for (let i = 0; i < tries; i++) {
    const cur = readFn();
    if (cur && cur === last) { if (++count >= stable) return cur; }
    else count = 0;
    last = cur;
    await sleep(interval);
  }
  return last;
}

// Insert text into a contenteditable composer, firing the input events React/Quill need.
export function typeInto(editor, text) {
  editor.focus();
  document.execCommand("insertText", false, text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shared.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared.js test/shared.test.js
git commit -m "refactor: shared.js becomes provider-agnostic helpers (validateAsk/waitFor/readStable)"
```

---

### Task 2: `drivers/chatgpt.js` — ChatGPT driver

**Files:**
- Create: `src/drivers/chatgpt.js`
- Test: `test/drivers.test.js` (create; extended in Tasks 3–4)

**Interfaces:**
- Consumes: `sleep, waitFor, readStable, typeInto` from `../shared.js`.
- Produces: `chatgptDriver` (Driver shape) and pure `parseChatgptConvId(url) -> string|null`.

- [ ] **Step 1: Write the failing test** `test/drivers.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptDriver, parseChatgptConvId } from "../src/drivers/chatgpt.js";

test("chatgpt driver identity + host match", () => {
  assert.equal(chatgptDriver.id, "chatgpt");
  assert.equal(chatgptDriver.hostMatch("chatgpt.com"), true);
  assert.equal(chatgptDriver.hostMatch("gemini.google.com"), false);
  assert.equal(chatgptDriver.newChatUrl, "https://chatgpt.com/");
});

test("parseChatgptConvId extracts /c/<id>", () => {
  assert.equal(parseChatgptConvId("https://chatgpt.com/c/abc-123"), "abc-123");
  assert.equal(parseChatgptConvId("https://chatgpt.com/"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — cannot find module `../src/drivers/chatgpt.js`.

- [ ] **Step 3: Create `src/drivers/chatgpt.js`**

```js
import { sleep, waitFor, readStable, typeInto } from "../shared.js";

const ORIGIN = "https://chatgpt.com";
const SEL = {
  composer: "#prompt-textarea",
  send: '[data-testid="send-button"]',
  stop: '[data-testid="stop-button"]',
  assistant: '[data-message-author-role="assistant"]',
};

export function parseChatgptConvId(url) {
  const m = String(url).match(/\/c\/([0-9a-f-]+)/i);
  return m ? m[1] : null;
}

async function getAccessToken() {
  const s = await fetch("/api/auth/session", { credentials: "include" });
  if (!s.ok) throw new Error("SESSION_" + s.status);
  const d = await s.json().catch(() => ({}));
  if (!d.accessToken) throw new Error("NOT_AUTHENTICATED");
  return d.accessToken;
}

export const chatgptDriver = {
  id: "chatgpt",
  hostMatch: (h) => h === "chatgpt.com",
  newChatUrl: ORIGIN + "/",
  capabilities: { images: false },

  async isLoggedIn() {
    try { await getAccessToken(); return true; } catch { return false; }
  },

  async send(prompt) {
    await waitFor(() => document.querySelector(SEL.composer));
    const editor = document.querySelector(SEL.composer);
    if (!editor) throw new Error("NO_COMPOSER");
    typeInto(editor, prompt);
    await sleep(150);
    const ready = await waitFor(() => {
      const b = document.querySelector(SEL.send);
      return b && !b.disabled;
    });
    const btn = document.querySelector(SEL.send);
    if (!ready || !btn) throw new Error("SEND_DISABLED");
    btn.click();
    await waitFor(() => document.querySelector(SEL.stop), { tries: 150 });
    await waitFor(() => !document.querySelector(SEL.stop), { tries: 1200 });
    const text = await readStable(() => {
      const n = document.querySelectorAll(SEL.assistant);
      return n.length ? n[n.length - 1].innerText.trim() : "";
    });
    return { text, conversationId: parseChatgptConvId(location.href) };
  },

  async deleteConversation(id) {
    if (!id) return;
    try {
      const token = await getAccessToken();
      await fetch(ORIGIN + "/backend-api/conversation/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ is_visible: false }),
        credentials: "include",
      });
    } catch (e) { console.warn("[cgw] chatgpt delete failed:", e.message || e); }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/chatgpt.js test/drivers.test.js
git commit -m "feat: extract ChatGPT logic into drivers/chatgpt.js (Driver interface)"
```

---

### Task 3: `drivers/gemini.js` — Gemini driver

**Files:**
- Create: `src/drivers/gemini.js`
- Test: `test/drivers.test.js` (append)

**Interfaces:**
- Consumes: `sleep, waitFor, readStable, typeInto` from `../shared.js`.
- Produces: `geminiDriver` (Driver shape); pure `scrapeTokens(html)->{at,bl,fsid}`, `parseGeminiConvId(url)->string|null`, `buildGeminiDeleteRequest({convId,at,bl,fsid,reqid})->{url,body}`.

- [ ] **Step 1: Append failing tests to `test/drivers.test.js`**

```js
import { geminiDriver, scrapeTokens, parseGeminiConvId, buildGeminiDeleteRequest } from "../src/drivers/gemini.js";

test("gemini driver identity + host match", () => {
  assert.equal(geminiDriver.id, "gemini");
  assert.equal(geminiDriver.hostMatch("gemini.google.com"), true);
  assert.equal(geminiDriver.hostMatch("chatgpt.com"), false);
  assert.equal(geminiDriver.newChatUrl, "https://gemini.google.com/app");
});

test("scrapeTokens pulls WIZ tokens from HTML", () => {
  const html = 'x"SNlM0e":"AT_TOK",y"cfb2h":"BL_TOK",z"FdrFJe":"SID_TOK"w';
  assert.deepEqual(scrapeTokens(html), { at: "AT_TOK", bl: "BL_TOK", fsid: "SID_TOK" });
});

test("parseGeminiConvId extracts /app/<id>", () => {
  assert.equal(parseGeminiConvId("https://gemini.google.com/app/0443c4404c0e00c0"), "0443c4404c0e00c0");
  assert.equal(parseGeminiConvId("https://gemini.google.com/app"), null);
});

test("buildGeminiDeleteRequest forms GzXR5e batchexecute call", () => {
  const { url, body } = buildGeminiDeleteRequest({ convId: "ID1", at: "AT", bl: "BL", fsid: "SID", reqid: 12345 });
  assert.ok(url.includes("/_/BardChatUi/data/batchexecute"));
  assert.ok(url.includes("rpcids=GzXR5e"));
  assert.ok(url.includes("bl=BL"));
  assert.ok(body.includes("GzXR5e"));
  assert.ok(body.includes("c_ID1"));
  assert.ok(body.includes("at=AT"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — cannot find module `../src/drivers/gemini.js`.

- [ ] **Step 3: Create `src/drivers/gemini.js`**

```js
import { sleep, waitFor, readStable, typeInto } from "../shared.js";

const ORIGIN = "https://gemini.google.com";
const SEL = {
  composer: ".ql-editor",
  send: 'button[aria-label="Send message"]',
  stop: 'button[aria-label*="Stop" i]',
  response: ".model-response-text",
};

export function scrapeTokens(html) {
  const g = (k) => {
    const m = String(html).match(new RegExp('"' + k + '":"([^"]+)"'));
    return m ? m[1] : null;
  };
  return { at: g("SNlM0e"), bl: g("cfb2h"), fsid: g("FdrFJe") };
}

export function parseGeminiConvId(url) {
  const m = String(url).match(/\/app\/([0-9a-f]+)/i);
  return m ? m[1] : null;
}

export function buildGeminiDeleteRequest({ convId, at, bl, fsid, reqid }) {
  const cid = "c_" + convId;
  const freq = JSON.stringify([[["GzXR5e", JSON.stringify([cid]), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq, at }).toString();
  const qs = new URLSearchParams({
    rpcids: "GzXR5e", "source-path": "/app", bl, "f.sid": fsid, hl: "en", _reqid: String(reqid), rt: "c",
  });
  return { url: ORIGIN + "/_/BardChatUi/data/batchexecute?" + qs.toString(), body };
}

export const geminiDriver = {
  id: "gemini",
  hostMatch: (h) => h === "gemini.google.com",
  newChatUrl: ORIGIN + "/app",
  capabilities: { images: false },

  isLoggedIn() {
    return !!scrapeTokens(document.documentElement.outerHTML).at;
  },

  async send(prompt) {
    await waitFor(() => document.querySelector(SEL.composer));
    const editor = document.querySelector(SEL.composer);
    if (!editor) throw new Error("NO_COMPOSER");
    typeInto(editor, prompt);
    await sleep(300);
    const ready = await waitFor(() => document.querySelector(SEL.send));
    const btn = document.querySelector(SEL.send);
    if (!ready || !btn) throw new Error("SEND_DISABLED");
    btn.click();
    await waitFor(() => document.querySelector(SEL.stop), { tries: 150 });
    await waitFor(() => !document.querySelector(SEL.stop), { tries: 1200 });
    const text = await readStable(() => {
      const n = document.querySelectorAll(SEL.response);
      return n.length ? n[n.length - 1].innerText.trim() : "";
    });
    return { text, conversationId: parseGeminiConvId(location.href) };
  },

  async deleteConversation(id) {
    if (!id) return;
    try {
      const t = scrapeTokens(document.documentElement.outerHTML);
      if (!t.at) return;
      const reqid = 100000 + (Math.floor(performance.now()) % 800000);
      const { url, body } = buildGeminiDeleteRequest({ convId: id, at: t.at, bl: t.bl, fsid: t.fsid, reqid });
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body, credentials: "include",
      });
    } catch (e) { console.warn("[cgw] gemini delete failed:", e.message || e); }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS — 6 tests (2 chatgpt + 4 gemini).

- [ ] **Step 5: Commit**

```bash
git add src/drivers/gemini.js test/drivers.test.js
git commit -m "feat: gemini driver (UI-drive send, DOM read, batchexecute delete)"
```

---

### Task 4: `drivers/index.js` — registry

**Files:**
- Create: `src/drivers/index.js`
- Test: `test/drivers.test.js` (append)

**Interfaces:**
- Consumes: `chatgptDriver`, `geminiDriver`.
- Produces: `DRIVERS` (array), `pickDriver(host)->Driver|null`, `driverById(id)->Driver|null`, `DRIVER_META` (`[{id,capabilities}]`).

- [ ] **Step 1: Append failing tests to `test/drivers.test.js`**

```js
import { DRIVERS, pickDriver, driverById, DRIVER_META } from "../src/drivers/index.js";

test("registry picks driver by host", () => {
  assert.equal(pickDriver("chatgpt.com").id, "chatgpt");
  assert.equal(pickDriver("gemini.google.com").id, "gemini");
  assert.equal(pickDriver("example.com"), null);
});

test("driverById + meta", () => {
  assert.equal(driverById("gemini").id, "gemini");
  assert.equal(driverById("nope"), null);
  assert.equal(DRIVERS.length, 2);
  assert.deepEqual(DRIVER_META.map((d) => d.id).sort(), ["chatgpt", "gemini"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers.test.js`
Expected: FAIL — cannot find module `../src/drivers/index.js`.

- [ ] **Step 3: Create `src/drivers/index.js`**

```js
import { chatgptDriver } from "./chatgpt.js";
import { geminiDriver } from "./gemini.js";

// Add a provider = import its driver and add it here. Nothing else changes.
export const DRIVERS = [chatgptDriver, geminiDriver];

export function pickDriver(host) {
  return DRIVERS.find((d) => d.hostMatch(host)) || null;
}

export function driverById(id) {
  return DRIVERS.find((d) => d.id === id) || null;
}

export const DRIVER_META = DRIVERS.map((d) => ({ id: d.id, capabilities: d.capabilities }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/index.js test/drivers.test.js
git commit -m "feat: driver registry (pickDriver/driverById/DRIVER_META)"
```

---

### Task 5: `content.js` rewire + `manifest.json`

**Files:**
- Modify: `src/content.js` (replace entire contents)
- Modify: `manifest.json` (replace entire contents)

**Interfaces:**
- Consumes: `pickDriver` from `drivers/index.js` (dynamic import via `chrome.runtime.getURL`).
- Produces: handles `{channel:"cgw", type:"ASK", prompt}` → `{ok, text, conversationId, provider}`; emits `{channel:"cgw", type:"READY"}`.

- [ ] **Step 1: Replace `src/content.js`**

```js
// Isolated-world content script. Picks the driver for this site and runs it.
console.log("[cgw] content script loaded on", location.host);
const registry = import(chrome.runtime.getURL("src/drivers/index.js"));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "ASK") return;
  (async () => {
    try {
      const { pickDriver } = await registry;
      const driver = pickDriver(location.host);
      if (!driver) throw new Error("NO_DRIVER");
      if (!(await driver.isLoggedIn())) throw new Error("NOT_AUTHENTICATED");
      const { text, conversationId } = await driver.send(msg.prompt, msg.images);
      sendResponse({ ok: true, text, conversationId, provider: driver.id });
      driver.deleteConversation(conversationId); // fire-and-forget cleanup
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e), provider: null });
    }
  })();
  return true; // async response
});

chrome.runtime.sendMessage({ channel: "cgw", type: "READY" }).catch(() => {});
```

- [ ] **Step 2: Replace `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "AI Bridge (dev)",
  "version": "0.2.0",
  "description": "Bridge to ChatGPT/Gemini via the logged-in web session; pluggable providers.",
  "permissions": ["scripting", "tabs", "storage", "sidePanel"],
  "host_permissions": ["https://chatgpt.com/*", "https://gemini.google.com/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "action": { "default_title": "AI Bridge" },
  "side_panel": { "default_path": "src/sidepanel.html" },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://gemini.google.com/*"],
      "js": ["src/content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/shared.js", "src/drivers/index.js", "src/drivers/chatgpt.js", "src/drivers/gemini.js"],
      "matches": ["https://chatgpt.com/*", "https://gemini.google.com/*"]
    }
  ]
}
```

- [ ] **Step 3: Verify syntax**

Run: `node --check src/content.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/content.js manifest.json
git commit -m "feat: content.js dispatches to driver by host; manifest covers both providers"
```

---

### Task 6: `background.js` — provider-aware core

**Files:**
- Modify: `src/background.js` (replace entire contents)

**Interfaces:**
- Consumes: `createSerialQueue` (queue.js); `driverById` (drivers/index.js).
- Produces: handles `{type:"ASK-FROM-PANEL", prompt, provider}` → `{ok, text, provider}`; `{type:"CLEAR-STATE"}`; writes `cgw_state` `{status,prompt,text,error,provider}` to `chrome.storage.local`.

- [ ] **Step 1: Replace `src/background.js`**

```js
import { createSerialQueue } from "./queue.js";
import { driverById } from "./drivers/index.js";

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

const DEFAULT_PROVIDER = "chatgpt";
const NAV_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 120000;
const STATE_KEY = "cgw_state";

const queue = createSerialQueue();
const readyWaiters = new Map(); // tabId -> resolve

function writeState(state) {
  return chrome.storage.local.set({ [STATE_KEY]: { ...state, ts: Date.now() } });
}
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(label || "TIMEOUT")), ms))]);
}
function resolveDriver(provider) {
  return driverById(provider) || driverById(DEFAULT_PROVIDER);
}
async function ensureTab(driver) {
  const host = new URL(driver.newChatUrl).host;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => { try { return new URL(t.url).host === host; } catch { return false; } });
  if (existing) return existing.id;
  const tab = await chrome.tabs.create({ url: driver.newChatUrl, pinned: true, active: false });
  return tab.id;
}
function waitForReady(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { readyWaiters.delete(tabId); reject(new Error("READY_TIMEOUT")); }, NAV_TIMEOUT_MS);
    readyWaiters.set(tabId, () => { clearTimeout(timer); resolve(); });
  });
}
async function navigateNewChat(tabId, driver) {
  const ready = waitForReady(tabId);
  await chrome.tabs.update(tabId, { url: driver.newChatUrl });
  await ready;
}
async function sendAsk(tabId, prompt) {
  const resp = await withTimeout(
    chrome.tabs.sendMessage(tabId, { channel: "cgw", type: "ASK", prompt }),
    REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT",
  );
  if (!resp || !resp.ok) throw new Error(resp ? resp.error : "NO_RESPONSE");
  return resp;
}
function ask(prompt, provider) {
  return queue.enqueue(async () => {
    const driver = resolveDriver(provider);
    const tabId = await ensureTab(driver);
    await navigateNewChat(tabId, driver);
    return await sendAsk(tabId, prompt);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.channel === "cgw" && msg.type === "READY" && sender.tab) {
    const resolve = readyWaiters.get(sender.tab.id);
    if (resolve) { readyWaiters.delete(sender.tab.id); resolve(); }
    return;
  }
  if (msg && msg.type === "ASK-FROM-PANEL") {
    const provider = msg.provider || DEFAULT_PROVIDER;
    writeState({ status: "sending", prompt: msg.prompt, text: "", error: "", provider });
    ask(msg.prompt, provider).then(
      (r) => { writeState({ status: "ok", prompt: msg.prompt, text: r.text, error: "", provider }); sendResponse({ ok: true, text: r.text, provider }); },
      (e) => { const error = String(e.message || e); writeState({ status: "error", prompt: msg.prompt, text: "", error, provider }); sendResponse({ ok: false, error, provider }); },
    );
    return true;
  }
  if (msg && msg.type === "CLEAR-STATE") { chrome.storage.local.remove(STATE_KEY); return; }
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/background.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "feat: provider-aware background (per-provider tab, routing, persisted state)"
```

---

### Task 7: `sidepanel` — provider selector

**Files:**
- Modify: `src/sidepanel.html` (add a `<select>` before the composer)
- Modify: `src/sidepanel.js` (populate select from `DRIVER_META`, persist choice, send `provider`)

**Interfaces:**
- Consumes: `DRIVER_META` (static import from `./drivers/index.js`); background `ASK-FROM-PANEL`/`CLEAR-STATE`; `cgw_state` storage.
- Produces: sends `{type:"ASK-FROM-PANEL", prompt, provider}`.

- [ ] **Step 1: Add the selector to `src/sidepanel.html`** — insert this block immediately after the `</header>` line

```html
    <label class="provider-row">
      <span>Nhà cung cấp</span>
      <select id="provider"></select>
    </label>
```

- [ ] **Step 2: Add styling** — insert into the `<style>` block (before `/* Composer */`)

```css
    .provider-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .provider-row select {
      flex: 1; padding: 7px 9px; border-radius: 9px; border: 1px solid var(--border);
      background: var(--field-bg); color: var(--fg); font: inherit;
    }
```

- [ ] **Step 3: Wire the selector in `src/sidepanel.js`** — add at the top, after the existing `const … = $("…")` element lookups

```js
import { DRIVER_META } from "./drivers/index.js";

const providerEl = document.getElementById("provider");
const PROVIDER_KEY = "cgw_provider";

// Populate provider options from the registry (auto-includes new drivers).
for (const d of DRIVER_META) {
  const opt = document.createElement("option");
  opt.value = d.id;
  opt.textContent = d.id;
  providerEl.appendChild(opt);
}

// Restore last-used provider.
chrome.storage.local.get(PROVIDER_KEY, (data) => {
  if (data[PROVIDER_KEY]) providerEl.value = data[PROVIDER_KEY];
});
providerEl.addEventListener("change", () => {
  chrome.storage.local.set({ [PROVIDER_KEY]: providerEl.value });
});
```

- [ ] **Step 4: Include `provider` in the send message** — in `src/sidepanel.js`, change the `send()` body's `sendMessage` call

Replace:
```js
  chrome.runtime.sendMessage({ type: "ASK-FROM-POPUP", prompt }, () => void chrome.runtime.lastError);
```
With:
```js
  chrome.runtime.sendMessage({ type: "ASK-FROM-PANEL", prompt, provider: providerEl.value }, () => void chrome.runtime.lastError);
```

- [ ] **Step 5: Verify syntax**

Run: `node --check src/sidepanel.js`
Expected: no output. *(chrome/DOM/imports are runtime-only; `--check` validates syntax.)*

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel.html src/sidepanel.js
git commit -m "feat: side panel provider selector (from registry) + persisted choice"
```

---

### Task 8: End-to-end verification (Playwright, live accounts)

No new files. Confirm no ChatGPT regression and Gemini works, through the reloaded extension.

**Files:** none.

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all pass (`shared`, `drivers`, `queue`), `fail 0`.

- [ ] **Step 2: Load/reload the unpacked extension**

`chrome://extensions` → reload "AI Bridge (dev)". Confirm no manifest errors and the service worker loads.

- [ ] **Step 3: ChatGPT no-regression**

Be logged in at `chatgpt.com`. Open the side panel → provider `chatgpt` → send `Reply with exactly: REG-1`. Expect status `Xong…` and answer `REG-1`; verify the temp chat is gone (`GET /backend-api/conversation/<id>` → 404).

- [ ] **Step 4: Gemini happy path**

Be logged in at `gemini.google.com`. Side panel → provider `gemini` → send `Reply with exactly: GEM-2`. Expect answer `GEM-2`; the tab navigates to `/app/<id>` then the chat is deleted (sidebar no longer lists it).

- [ ] **Step 5: Provider persistence**

Change provider to `gemini`, close & reopen the panel → the selector still shows `gemini`.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from unified-bridge end-to-end verification"
```

---

## Notes for the implementer

- **Driver isolation:** all site-specific selectors/RPCs live in the driver file. Adding a provider is a new `drivers/<id>.js` + one line in `drivers/index.js` — do not touch the core.
- **No MAIN world:** Gemini tokens are scraped from `document.documentElement.outerHTML` in the isolated world; do not add MAIN-world injection.
- **Do not log token values** (`at`, `accessToken`, cookies).
- **Message name change:** the panel now sends `ASK-FROM-PANEL` (was `ASK-FROM-POPUP`); background matches the new name. Grep to ensure nothing still sends the old name.
- **Deferred (spec §12):** `externally_connectable`/`onMessageExternal`, images (paste), HTTP companion. Contract fields exist but stay unused this round.
```
