import { createSerialQueue } from "./queue.js";
import { driverById } from "./drivers/index.js";
import { sleep } from "./shared.js";
import { parseGeminiTts } from "./parsers.js";

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

// Convert generated-image URLs to base64 data URLs. The SW (with host_permissions)
// can fetch cross-origin CDN images that the page's CSP blocks. Best-effort: on any
// failure keep the url so the caller still has something usable.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}
// Runs in the provider tab's MAIN world (page context, like AIBG's page.evaluate).
// Some Gemini builds expose the generated image only as a same-origin `blob:` URL on an
// <img> (not reachable by SW fetch). Because the blob is same-origin, drawing the <img> to a
// canvas is NOT tainted, so toDataURL() yields the bytes. For cross-origin <img> (e.g. a
// public CDN url) the canvas taints and throws → we hand back the url for a SW fetch instead.
// Returns [{ dataUrl?, url?, mimeType? }]. Self-contained — no imports.
function captureImagesInPage() {
  const out = [];
  const seen = new Set();
  const bad = /gstatic\.com|\/images\/branding|googleusercontent\.com\/(?:a[\/-]|fife\/)|=w\d{1,3}-h\d{1,3}|=s\d{1,3}(-|$)|\.svg|\.ico/;
  const sel = "single-image.generated-image img, img.image, img[src^='blob:'], img[src^='http']";
  for (const img of document.querySelectorAll(sel)) {
    const src = img.currentSrc || img.src || "";
    if (!src || seen.has(src)) continue;
    const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (w && w < 200) continue; // avatar/icon
    if (h && h < 100) continue;
    if (!src.startsWith("blob:") && bad.test(src)) continue;
    seen.add(src);
    if (!img.complete || !w) { if (/^https?:/.test(src)) out.push({ url: src }); continue; }
    try {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0);
      out.push({ dataUrl: c.toDataURL("image/png"), mimeType: "image/png" });
    } catch {
      if (/^https?:/.test(src)) out.push({ url: src }); // tainted cross-origin → SW-fetch it
    }
  }
  return out;
}

async function captureImages(tabId) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: captureImagesInPage });
    return (res && res[0] && res[0].result) || [];
  } catch { return []; }
}

// Poll until the generated <img> has rendered + decoded, then canvas-capture its bytes.
// The tab must be the active (visible) tab to render — callers activateTab() first.
// Imagen is slow, so wait up to ~60s. Returns [{dataUrl?, url?, mimeType?}].
async function collectRenderedImages(tabId) {
  for (let i = 0; i < 120; i++) {
    const items = await captureImages(tabId);
    if (items.some((it) => it.dataUrl)) return items;
    await sleep(500);
  }
  return await captureImages(tabId); // last look (may be url-only for cross-origin)
}

// Runs in the provider tab's MAIN world. Loads a URL as an Image with crossOrigin="anonymous"
// and draws it to a canvas → dataURL. The CDN answers Access-Control-Allow-Origin:* so an
// anonymous (cookie-less) load is CORS-clean and the canvas is NOT tainted. This works where a
// SW fetch fails: the redirect chain (lh3 → work.fife) blocks credentialed/cross-site fetches,
// but an <img> follows redirects fine, and no page layout is needed (offscreen canvas) so it
// runs even in a backgrounded tab. Returns a data: URL or null. Self-contained — no imports.
function loadImageDataUrlInPage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const t = setTimeout(() => resolve(null), 20000);
    img.onload = () => {
      clearTimeout(t);
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch { resolve(null); }
    };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

// Turn one image url into base64. The SW is CORS-exempt for hosts in host_permissions — which
// now include the whole redirect chain (googleusercontent.com → usercontent.google.com /
// lh3.google.com) — so a direct fetch reads the bytes. credentials:"include" is needed because
// the generated-image CDN 403s anonymous requests (it's gated to the logged-in session, same as
// how the <img> loads it). Fall back to a page-context canvas load for blob: urls (page-scoped,
// unreachable from the SW) or if the fetch still fails.
async function urlToDataUrl(tabId, url) {
  if (/^https?:/.test(url)) {
    for (const credentials of ["include", "omit"]) {
      try {
        const r = await fetch(url, { credentials });
        if (r.ok) { const b = await r.blob(); if (b.size) return { dataUrl: await blobToDataUrl(b), mimeType: b.type || "image/png" }; }
      } catch { /* try next mode, then page canvas */ }
    }
  }
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: loadImageDataUrlInPage, args: [url] });
    const dataUrl = res && res[0] && res[0].result;
    if (dataUrl) return { dataUrl, mimeType: "image/png" };
  } catch { /* tab gone */ }
  return null;
}

// items: [{ url?, dataUrl?, mimeType? }]. Keep any dataUrl already produced (canvas capture);
// for url-only items resolve to base64 via urlToDataUrl (falls back to url on failure).
async function imagesToOut(tabId, items) {
  const out = [];
  for (const item of (items || []).slice(0, 8)) {
    if (item && item.dataUrl) { out.push(item); continue; }
    const url = item && item.url;
    if (!url) continue;
    // image_generation_content/N is a non-fetchable placeholder — the real url is elsewhere.
    if (/image_generation_content/.test(url)) continue;
    const got = await urlToDataUrl(tabId, url);
    out.push(got ? { url, ...got } : { url });
  }
  return out;
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
// Make tabId the active (visible) tab in its window so it renders; return the id of the tab
// that was active before (to restore later), or null if tabId was already active / on error.
async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const cur = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    const prev = cur && cur.id !== tabId ? cur.id : null;
    await chrome.tabs.update(tabId, { active: true });
    return prev;
  } catch { return null; }
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
async function sendAskFile(tabId, payload) {
  const resp = await withTimeout(
    chrome.tabs.sendMessage(tabId, { channel: "cgw", type: "ASK-FILE", ...payload }),
    REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT",
  );
  if (!resp || !resp.ok) throw new Error(resp ? resp.error : "NO_RESPONSE");
  return resp;
}
function ask(prompt, provider) {
  return queue.enqueue(async () => {
    const driver = resolveDriver(provider);
    const tabId = await ensureTab(driver);
    // Text answer is read from the intercepted network response (works backgrounded).
    await navigateNewChat(tabId, driver);
    const resp = await sendAsk(tabId, prompt); // { text, conversationId, images:[{url}], provider }
    let images = resp.images || [];
    if (images.length) {
      // An image was generated. Two forms exist depending on Gemini's build:
      // (a) a public CDN url (lh3.googleusercontent.com/gg-dl/…) present in the stream, and
      // (b) a same-origin blob: url only reachable from the rendered DOM.
      // 1) Resolve the CDN url from the stream to bytes (SW fetch, then page crossOrigin+canvas).
      //    No tab disruption.
      let out = await imagesToOut(tabId, images);
      // 2) If still no bytes (blob-only build with no usable url in the stream), the image lives
      //    only in the DOM: activate the tab so it renders the <img> (a backgrounded tab won't),
      //    canvas-capture the same-origin blob, then restore the user's previous tab.
      if (!out.some((it) => it.dataUrl)) {
        const prevActive = await activateTab(tabId);
        try {
          const rendered = await collectRenderedImages(tabId);
          if (rendered.length) out = await imagesToOut(tabId, rendered);
        } finally {
          if (prevActive != null) { try { await chrome.tabs.update(prevActive, { active: true }); } catch { /* gone */ } }
        }
      }
      images = out;
      chrome.storage.local.set({ cgw_img_debug: { images: images.map((it) => (it.dataUrl ? "dataUrl:" + Math.round(it.dataUrl.length / 1024) + "KB" : "url:" + String(it.url).slice(0, 50))) } });
    }
    return { ...resp, images };
  });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.channel === "cgw" && msg.type === "READY" && sender.tab) {
    const resolve = readyWaiters.get(sender.tab.id);
    if (resolve) { readyWaiters.delete(sender.tab.id); resolve(); }
    return;
  }
  if (msg && msg.type === "ASK-FROM-PANEL") {
    const provider = msg.provider || DEFAULT_PROVIDER;
    writeState({ status: "sending", prompt: msg.prompt, text: "", error: "", provider, images: [] });
    ask(msg.prompt, provider).then(
      (r) => {
        const images = r.images || []; // already resolved (CDP bytes or url) inside ask()
        writeState({ status: "ok", prompt: msg.prompt, text: r.text, error: "", provider, images });
        sendResponse({ ok: true, text: r.text, images, provider });
      },
      (e) => { const error = String(e.message || e); writeState({ status: "error", prompt: msg.prompt, text: "", error, provider, images: [] }); sendResponse({ ok: false, error, provider }); },
    );
    return true;
  }
  if (msg && msg.type === "CLEAR-STATE") { chrome.storage.local.remove(STATE_KEY); return; }

  // Gemini TTS: synthesize speech for `text` and return audio bytes as a data: URL.
  if (msg && msg.type === "TTS-FROM-PANEL") {
    ttsGemini(msg.text, msg.lang).then(
      (audio) => sendResponse(audio ? { ok: true, ...audio } : { ok: false, error: "NO_AUDIO" }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) }),
    );
    return true;
  }

  // Gemini delete: run in the tab's MAIN world where window.WIZ_global_data (the `at`
  // token) is readable. Best-effort cleanup.
  if (msg && msg.type === "GEMINI-DELETE" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: geminiDeleteInPage,
      args: [msg.conversationId],
    }).then(
      (res) => sendResponse({ ok: true, result: res && res[0] && res[0].result }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) }),
    );
    return true;
  }
});

// Pick the TTS voice language: Vietnamese-specific letters → "vi", else "en".
function detectLang(text) {
  return /[ĂăÂâĐđÊêÔôƠơƯưẠ-ỹ]/.test(String(text)) ? "vi" : "en";
}

// Gemini "read aloud" (rpcid XqA3Ic) synthesizes speech server-side and returns the audio as
// base64 inline in the batchexecute response. Trigger it in the tab's MAIN world (needs the WIZ
// `at` token, like delete), read the raw response, and parse out the audio bytes.
async function ttsGemini(text, lang) {
  const t = String(text || "").trim();
  if (!t) return null;
  const tabId = await ensureTab(driverById("gemini"));
  const voice = lang || detectLang(t);
  let r = null;
  for (let i = 0; i < 20; i++) { // a freshly-created tab may not have WIZ tokens yet
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: geminiTtsInPage, args: [t.slice(0, 5000), voice],
    });
    r = res && res[0] && res[0].result;
    if (r && r.ok) break;
    if (r && r.error === "NO_AT") { await sleep(500); continue; }
    break;
  }
  if (!r || !r.ok || !r.raw) return null;
  return parseGeminiTts(r.raw); // { dataUrl, mimeType } | null
}

// Runs in the Gemini tab's MAIN world (self-contained — no imports allowed).
function geminiTtsInPage(text, lang) {
  const w = window.WIZ_global_data || {};
  const html = document.documentElement.innerHTML;
  const g = (k, v) => v || ((html.match(new RegExp('"' + k + '":"([^"]+)"')) || [])[1]);
  const at = g("SNlM0e", w.SNlM0e), bl = g("cfb2h", w.cfb2h), fsid = g("FdrFJe", w.FdrFJe);
  if (!at) return { ok: false, error: "NO_AT" };
  const inner = JSON.stringify([null, text, lang || "en", null, 2]);
  const freq = JSON.stringify([[["XqA3Ic", inner, null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq, at }).toString();
  const qs = new URLSearchParams({
    rpcids: "XqA3Ic", "source-path": "/app", bl, "f.sid": fsid, hl: "en",
    _reqid: String(100000 + Math.floor(Math.random() * 800000)), rt: "c",
  });
  return fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?" + qs.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body, credentials: "include",
  }).then((r) => r.text()).then((raw) => ({ ok: true, raw })).catch((e) => ({ ok: false, error: String(e) }));
}

// Runs in the Gemini tab's MAIN world (self-contained — no imports allowed).
function geminiDeleteInPage(conversationId) {
  const w = window.WIZ_global_data || {};
  const html = document.documentElement.innerHTML;
  const g = (k, v) => v || ((html.match(new RegExp('"' + k + '":"([^"]+)"')) || [])[1]);
  const at = g("SNlM0e", w.SNlM0e), bl = g("cfb2h", w.cfb2h), fsid = g("FdrFJe", w.FdrFJe);
  if (!at) return { ok: false, error: "NO_AT" };
  // parseGeminiStream already returns the id WITH the "c_" prefix — don't double it.
  const cid = String(conversationId).startsWith("c_") ? String(conversationId) : "c_" + conversationId;
  const freq = JSON.stringify([[["GzXR5e", JSON.stringify([cid]), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq, at }).toString();
  const qs = new URLSearchParams({
    rpcids: "GzXR5e", "source-path": "/app", bl, "f.sid": fsid, hl: "en",
    _reqid: String(100000 + Math.floor(Math.random() * 800000)), rt: "c",
  });
  return fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?" + qs.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body, credentials: "include",
  }).then((r) => ({ ok: r.ok, status: r.status }));
}

// ── Local HTTP API bridge (via the native-messaging host in ./host) ──────────
// The host exposes 127.0.0.1 HTTP for external tools and forwards each request here over
// native messaging; we run it through the same ask()/ttsGemini() path and reply. See host/.
const NATIVE_HOST = "com.aibridge.host";
let nativePort = null;

function handleApiOp(msg) {
  const provider = msg.provider || DEFAULT_PROVIDER;
  if (msg.op === "tts") {
    return ttsGemini(msg.text, msg.lang).then((a) => (a ? { ok: true, audio: a } : { ok: false, error: "NO_AUDIO" }));
  }
  if (msg.op === "askfile") {
    return askFile(msg).then((r) => ({ ok: true, text: r.text, conversationId: r.conversationId, provider: r.provider }));
  }
  if (msg.op === "ask" || !msg.op) {
    return ask(msg.prompt, provider).then(async (r) => {
      const out = { ok: true, text: r.text, conversationId: r.conversationId, images: r.images || [], provider: r.provider };
      if (msg.tts) { const a = await ttsGemini(r.text, msg.lang).catch(() => null); if (a) out.audio = a; }
      return out;
    });
  }
  return Promise.resolve({ ok: false, error: "UNKNOWN_OP" });
}

function safeNativePost(obj) { try { if (nativePort) nativePort.postMessage(obj); } catch { nativePort = null; } }

function onNativeMessage(msg) {
  if (!msg || msg.id == null) return;
  if (msg.op === "ping") { safeNativePost({ id: msg.id, op: "pong" }); return; } // host keepalive
  if (msg.op === "hosterror") { console.warn("[cgw] native host error:", msg.error); return; }
  handleApiOp(msg).then(
    (res) => safeNativePost({ id: msg.id, ...res }),
    (e) => safeNativePost({ id: msg.id, ok: false, error: String(e.message || e) }),
  );
}

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener(onNativeMessage);
    nativePort.onDisconnect.addListener(() => { nativePort = null; }); // host not installed / exited
  } catch { nativePort = null; }
}

connectNative();
chrome.runtime.onStartup?.addListener(connectNative);
chrome.alarms?.create("cgw-native-keepalive", { periodInMinutes: 0.5 }); // reconnect if dropped
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === "cgw-native-keepalive") connectNative(); });
