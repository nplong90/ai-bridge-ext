import { sleep, waitFor, typeInto } from "../shared.js";
import { parseGeminiStream } from "../parsers.js";

const ORIGIN = "https://gemini.google.com";
const SEL = {
  composer: ".ql-editor",
  // Locale-independent: the send button lives inside a `.send-button` container
  // (aria-label is localized — e.g. Japanese "プロンプトを送信" — so never match on it).
  send: ".send-button button, button[aria-label='Send message']",
};

export function scrapeTokens(html) {
  const g = (k) => {
    const m = String(html).match(new RegExp('"' + k + '":"([^"]+)"'));
    return m ? m[1] : null;
  };
  return { at: g("SNlM0e"), bl: g("cfb2h"), fsid: g("FdrFJe") };
}

export function buildGeminiDeleteRequest({ convId, at, bl, fsid, reqid }) {
  const cid = String(convId).startsWith("c_") ? convId : "c_" + convId;
  const freq = JSON.stringify([[["GzXR5e", JSON.stringify([cid]), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq, at }).toString();
  const qs = new URLSearchParams({
    rpcids: "GzXR5e", "source-path": "/app", bl, "f.sid": fsid, hl: "en", _reqid: String(reqid), rt: "c",
  });
  return { url: ORIGIN + "/_/BardChatUi/data/batchexecute?" + qs.toString(), body };
}

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

// Decide whether Path A produced a usable answer. Any failure signal → tell the driver to run
// Path B (drag-drop) instead. Keeps the fallback trigger in one testable place.
export function classifyPathAResult({ tokensOk, uploadOk, generateStatus, answer }) {
  if (!tokensOk) return "fallback";
  if (!uploadOk) return "fallback";
  if (!(generateStatus >= 200 && generateStatus < 300)) return "fallback";
  if (!answer || !String(answer).trim()) return "fallback";
  return "ok";
}

// Circuit breaker: once Path A fails `threshold` times in a row (schema drift), prefer Path B so
// we stop wasting a doomed A attempt on every request. One success flips back to A.
export function createPathPreference({ threshold = 3 } = {}) {
  let consecutiveFails = 0;
  return {
    prefer() { return consecutiveFails >= threshold ? "B" : "A"; },
    recordA(ok) { consecutiveFails = ok ? 0 : consecutiveFails + 1; },
  };
}

export const geminiDriver = {
  id: "gemini",
  hostMatch: (h) => h === "gemini.google.com",
  newChatUrl: ORIGIN + "/app",
  capabilities: { images: true, audio: true },
  // Gemini's SPA doesn't render into a backgrounded tab, but its StreamGenerate XHR
  // is interceptable — so read the answer from the network response, not the DOM.
  readMode: "net",

  async isLoggedIn() {
    return await waitFor(() => !!document.querySelector(SEL.composer), { tries: 100, interval: 100 });
  },

  // UI-drive the send only (tokens can't be forged). The answer is read from the
  // intercepted StreamGenerate response, not the DOM (see matchResponse/parse).
  async startSend(prompt) {
    await waitFor(() => document.querySelector(SEL.composer));
    const editor = document.querySelector(SEL.composer);
    if (!editor) throw new Error("NO_COMPOSER");
    typeInto(editor, prompt);
    await sleep(300);
    const ready = await waitFor(() => document.querySelector(SEL.send));
    const btn = document.querySelector(SEL.send);
    if (!ready || !btn) throw new Error("SEND_DISABLED");
    btn.click();
  },

  // Read the answer from the intercepted StreamGenerate response (works in background).
  async readAnswer(ctx) {
    const raw = await ctx.waitForResponse((url) => /\/StreamGenerate/.test(url), 120000);
    if (!raw) throw new Error("NO_RESPONSE_CAPTURED");
    const parsed = parseGeminiStream(raw); // { answer, conversationId, images:[gg-dl urls] }
    // The stream carries the generated-image CDN url; the background turns it into base64 bytes
    // (SW fetch with credentials — the redirect hosts are in host_permissions — or a page-context
    // canvas fallback). See background.js imagesToOut/urlToDataUrl.
    return {
      answer: parsed.answer,
      conversationId: parsed.conversationId,
      images: parsed.images.map((u) => ({ url: u })),
    };
  },

  // Delete needs the WIZ `at` token (window.WIZ_global_data, MAIN world only). Background
  // runs it via chrome.scripting.executeScript world:MAIN. Best-effort.
  async deleteConversation(id) {
    if (!id) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: "GEMINI-DELETE", conversationId: id });
      console.log("[cgw] gemini delete", id, "→", res && res.result);
    } catch (e) { console.warn("[cgw] gemini delete dispatch failed:", e.message || e); }
  },

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
    console.log("[cgw-diag] PathA tokens:", { at: !!at, bl: !!bl, fsid: !!fsid, tokensOk });
    let uploadOk = false, generateStatus = 0, answer = "", conversationId = null;
    if (tokensOk) {
      const fileToken = await this.uploadFileA(bytes, mime, filename, cfg);
      uploadOk = !!fileToken;
      console.log("[cgw-diag] PathA upload:", { uploadOk, tokenPreview: fileToken ? String(fileToken).slice(0, 40) : null });
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
        console.log("[cgw-diag] PathA generate:", { generateStatus, answerLen: answer.length, rawPreview: String(raw).slice(0, 400) });
      }
    }
    const verdict = classifyPathAResult({ tokensOk, uploadOk, generateStatus, answer });
    console.log("[cgw-diag] PathA verdict:", verdict);
    return { verdict, answer, conversationId };
  },

  // Path B: build a real File and hand it to Gemini's own uploader by setting it on the hidden
  // file input and firing change (the page then runs the exact upload we saw in the HAR and
  // builds its own f.req). Robust to schema changes; needs a foreground tab.
  async attachViaDrop(bytes, mime, filename, cfg) {
    // Gemini has no <input type=file> (verified: count 0); it relies on a drop handler on the
    // input area — that's why a manual OS drag-drop works. Replicate exactly that: build a File,
    // wrap it in a DataTransfer, and dispatch the dragenter/dragover/drop sequence onto the
    // composer so Gemini's own uploader runs (it then does the resumable upload + builds f.req).
    const target = document.querySelector(cfg.selectors.composer)
      || document.querySelector(cfg.selectors.dropTarget || "main")
      || document.body;
    if (!target) { console.log("[cgw-diag] PathB no drop target"); return false; }
    const file = new File([bytes], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    // Some Chrome builds ignore `dataTransfer` in the DragEvent constructor; force it on if so.
    const fire = (type) => {
      let ev;
      try { ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }); }
      catch { ev = new Event(type, { bubbles: true, cancelable: true }); }
      if (!ev.dataTransfer) { try { Object.defineProperty(ev, "dataTransfer", { value: dt }); } catch { /* readonly */ } }
      target.dispatchEvent(ev);
    };
    fire("dragenter"); fire("dragover"); fire("drop");
    console.log("[cgw-diag] PathB dispatched synthetic drop on", target.tagName, "class:", String(target.className).slice(0, 60));
    return true;
  },

  async askWithFileDrop({ bytes, mime, filename, prompt, cfg }, ctx) {
    const attached = await this.attachViaDrop(bytes, mime, filename, cfg);
    if (!attached) throw new Error("DROP_ATTACH_FAILED");
    // Wait for the page's own upload to finish before sending (the composer's send stays disabled
    // until the attachment resolves). Reuse startSend which waits for the send button.
    await sleep(3000);
    console.log("[cgw-diag] PathB post-drop composer text:", (document.querySelector(cfg.selectors.composer) || {}).textContent, "| send btn:", !!document.querySelector(".send-button button, button[aria-label='Send message']"));
    await this.startSend(prompt);
    const raw = await ctx.waitForResponse((url) => /\/StreamGenerate/.test(url), 120000);
    if (!raw) throw new Error("NO_RESPONSE_CAPTURED");
    const parsed = parseGeminiStream(raw);
    return { answer: parsed.answer || "", conversationId: parsed.conversationId };
  },
};
