// Isolated-world content script. Drives the UI to send, then reads the answer from the
// response captured by interceptor.js (MAIN world) — not from the DOM. This works even
// when the tab is backgrounded (network completes; only rendering is throttled).
console.log("[cgw] content script loaded on", location.host);
const registry = import(chrome.runtime.getURL("src/drivers/index.js"));
const geminiModule = import(chrome.runtime.getURL("src/drivers/gemini.js"));

// Lazy-init: content scripts aren't ES modules, so top-level await isn't available here.
// Initialized on first ASK-FILE request; one instance per tab lifetime (remembers across
// requests within the same tab so repeated Path A failures make later requests skip to B).
let pathPref;

// Buffer intercepted network responses forwarded by interceptor.js.
const netBuffer = [];
let netNotify = null;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.source !== "cgw-net") return;
  netBuffer.push({ url: m.url, body: m.body });
  if (netNotify) netNotify();
});

// Resolve with the body of the most recent buffered response whose URL matches, or null
// on timeout. Passed to net-mode drivers so they can await their answer response.
function waitForResponse(matchFn, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (body) => { if (!done) { done = true; netNotify = null; clearTimeout(timer); resolve(body); } };
    const check = () => {
      for (let i = netBuffer.length - 1; i >= 0; i--) {
        if (matchFn(netBuffer[i].url)) { finish(netBuffer[i].body); return; }
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    netNotify = check;
    check(); // in case it already arrived
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "ASK") return;
  (async () => {
    try {
      const { pickDriver } = await registry;
      const driver = pickDriver(location.host);
      if (!driver) throw new Error("NO_DRIVER");
      if (!(await driver.isLoggedIn())) throw new Error("NOT_AUTHENTICATED");
      netBuffer.length = 0; // drop anything from before this turn
      await driver.startSend(msg.prompt, msg.images);
      const { answer, conversationId, images } = await driver.readAnswer({ waitForResponse });
      sendResponse({ ok: true, text: answer || "", conversationId, images: images || [], provider: driver.id });
      // Gemini: delete the temp chat now (its TTS reads arbitrary text, not a conversation).
      // ChatGPT: DON'T delete now — read-aloud (synthesize) 404s once the chat is hidden. The
      // background schedules a delayed hide (see scheduleChatgptDelete) so it's cleaned up later.
      if (driver.id !== "chatgpt") driver.deleteConversation(conversationId); // fire-and-forget cleanup
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e), provider: null });
    }
  })();
  return true; // async response
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "ASK-FILE") return;
  (async () => {
    try {
      const { pickDriver } = await registry;
      const driver = pickDriver(location.host);
      if (!driver || driver.id !== "gemini") throw new Error("NO_GEMINI_DRIVER");
      if (!(await driver.isLoggedIn())) throw new Error("NOT_AUTHENTICATED");
      const cfg = await (await fetch(chrome.runtime.getURL("src/config/gemini-upload.json"))).json();
      let bytes;
      if (msg.blobUrl) {
        const r = await fetch(msg.blobUrl);
        if (!r.ok) throw new Error("BLOB_FETCH_FAILED:" + r.status);
        bytes = new Uint8Array(await r.arrayBuffer());
      } else if (msg.bytesB64) {
        const bin = atob(msg.bytesB64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        throw new Error("NO_FILE_BYTES");
      }
      netBuffer.length = 0;
      pathPref ??= (await geminiModule).createPathPreference();
      const forced = msg.path === "A" || msg.path === "B" ? msg.path : null;
      const wantB = forced ? forced === "B" : pathPref.prefer() === "B";
      let out = null;
      if (!wantB) {
        const a = await driver.askWithFile({ bytes, mime: msg.mime, filename: msg.filename, prompt: msg.prompt, cfg }, { waitForResponse });
        if (a.verdict === "ok") out = { answer: a.answer, conversationId: a.conversationId };
      }
      if (!wantB) pathPref.recordA(out != null);
      if (!out && msg.path === "A") throw new Error("PATH_A_FAILED");
      if (!out) {
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

// ChatGPT "Read aloud": synthesize the last assistant message into audio (cookie'd fetch,
// runs in the chatgpt.com content script). Gemini TTS goes a different route (background MAIN world).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "cgw" || msg.type !== "TTS-CHATGPT") return;
  (async () => {
    try {
      const { pickDriver } = await registry;
      const driver = pickDriver(location.host);
      if (!driver || driver.id !== "chatgpt") throw new Error("NO_CHATGPT_DRIVER");
      const audio = await driver.synthesizeLast(msg.voice);
      sendResponse({ ok: true, ...audio });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

chrome.runtime.sendMessage({ channel: "cgw", type: "READY" }).catch(() => {});
