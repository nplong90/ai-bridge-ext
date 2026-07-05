// Pure response parsers for the network-intercept read path. Verified against live
// responses 2026-07-04. These take the raw response body captured by interceptor.js.

// Gemini StreamGenerate: chunked `)]}'` + length lines + [["wrb.fr", null, "<innerJSON>"]].
// answer = inner[4][0][1][0]; conversationId (c_id) = inner[1][0].
// Generated-image URLs (Imagen) appear in the StreamGenerate body as escaped
// lh3.googleusercontent.com/gg-dl links. Extract + de-duplicate them.
export function extractGeminiImages(raw) {
  const out = [];
  const seen = new Set();
  // Known path forms carrying a generated image: /gg-dl/, /rd-gg-dl/, /gg/, /rd-gg/ (image-mode
  // uses /gg/), and the /image_generation_content/N placeholder. Longer alternatives first so
  // e.g. "gg-dl" wins over "gg". NOTE: in image-mode the host+token are sometimes split across
  // JSON fields (no contiguous url) — those are recovered later via the DOM/canvas fallback.
  const re = /https?:\\?\/\\?\/[a-z0-9.-]*googleusercontent\.com\\?\/(?:rd-gg-dl|gg-dl|rd-gg|gg|image_generation_content)\\?\/[^"\\\s]+/gi;
  for (const m of String(raw).matchAll(re)) {
    const url = m[0].replace(/\\\//g, "/");
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

export function parseGeminiStream(raw) {
  let answer = null;
  let conversationId = null;
  for (const line of String(raw).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let arr;
    try { arr = JSON.parse(t); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!Array.isArray(item) || item[0] !== "wrb.fr" || typeof item[2] !== "string") continue;
      let inner;
      try { inner = JSON.parse(item[2]); } catch { continue; }
      if (inner && inner[4] && inner[4][0] && Array.isArray(inner[4][0][1])) {
        answer = inner[4][0][1][0];
      }
      if (inner && Array.isArray(inner[1]) && inner[1][0]) {
        conversationId = inner[1][0]; // already "c_..."
      }
    }
  }
  return { answer, conversationId, images: extractGeminiImages(raw) };
}

// Gemini TTS (rpcid XqA3Ic) batchexecute response embeds the synthesized audio as a long
// base64 run. Scan for it, decode, and identify the container by magic bytes (AIBG's approach).
// Returns { dataUrl, mimeType } or null. Pure — atob is available in SW and Node 18+.
function audioMimeFromMagic(bin) {
  const c = (i) => bin.charCodeAt(i) & 0xff;
  if (bin.startsWith("OggS")) return "audio/ogg";
  if (bin.startsWith("fLaC")) return "audio/flac";
  if (bin.startsWith("ID3")) return "audio/mpeg";
  if (c(0) === 0xff && (c(1) & 0xe0) === 0xe0) return "audio/mpeg"; // MPEG frame sync
  if (bin.startsWith("RIFF") && bin.slice(8, 12) === "WAVE") return "audio/wav";
  return null;
}

export function parseGeminiTts(raw) {
  const matches = String(raw).match(/[A-Za-z0-9+/_-]{1000,}={0,2}/g);
  if (!matches) return null;
  for (const m of matches) {
    let b64 = m.replace(/-/g, "+").replace(/_/g, "/"); // normalize url-safe → standard
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    let bin;
    try { bin = atob(b64); } catch { continue; }
    const mimeType = audioMimeFromMagic(bin);
    if (mimeType) return { dataUrl: `data:${mimeType};base64,${b64}`, mimeType };
  }
  return null;
}

// ChatGPT /backend-api/f/conversation SSE (delta_encoding v1): accumulate append ops on
// /message/content/parts/0; conversationId from the resume_conversation_token event.
export function parseChatgptSse(raw) {
  let text = "";
  let conversationId = null;
  const apply = (op) => {
    if (!op || typeof op !== "object") return;
    if (op.o === "patch" && Array.isArray(op.v)) { op.v.forEach(apply); return; }
    if (op.o === "append" && op.p === "/message/content/parts/0" && typeof op.v === "string") { text += op.v; return; }
    if (op.o === "add" && (op.p === "" || op.p == null) && op.v && op.v.message) {
      const parts = op.v.message?.content?.parts;
      const role = op.v.message?.author?.role;
      if (role === "assistant" && Array.isArray(parts) && typeof parts[0] === "string") text = parts[0];
    }
  };
  for (const line of String(raw).split("\n")) {
    const s = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!s || s === "[DONE]") continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type === "resume_conversation_token" && obj.conversation_id) conversationId = obj.conversation_id;
    else if (obj.conversation_id && !conversationId) conversationId = obj.conversation_id;
    apply(obj);
  }
  return { answer: text, conversationId };
}
