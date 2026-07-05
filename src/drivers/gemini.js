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
};
