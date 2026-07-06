// Isolated-world content script. Drives the UI to send, then reads the answer from the
// response captured by interceptor.js (MAIN world) — not from the DOM. This works even
// when the tab is backgrounded (network completes; only rendering is throttled).
console.log("[cgw] content script loaded on", location.host);
const registry = import(chrome.runtime.getURL("src/drivers/index.js"));

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
      driver.deleteConversation(conversationId); // fire-and-forget cleanup
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
      const bytes = new Uint8Array(await (await fetch(msg.blobUrl)).arrayBuffer());
      netBuffer.length = 0;
      const wantB = msg.path === "B";
      let out = null;
      if (!wantB) {
        const a = await driver.askWithFile({ bytes, mime: msg.mime, filename: msg.filename, prompt: msg.prompt, cfg }, { waitForResponse });
        if (a.verdict === "ok") out = { answer: a.answer, conversationId: a.conversationId };
      }
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

chrome.runtime.sendMessage({ channel: "cgw", type: "READY" }).catch(() => {});
