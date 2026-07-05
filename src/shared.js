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

// Build a data URL from a CDP Network.getResponseBody result. Returns null if the body
// isn't base64 (only base64 responses carry raw bytes we can embed).
export function cdpImageDataUrl(res, mime) {
  if (!res || !res.base64Encoded || !res.body) return null;
  return `data:${mime || "image/png"};base64,${res.body}`;
}

// Insert text into a contenteditable composer, firing the input events React/Quill need.
export function typeInto(editor, text) {
  editor.focus();
  document.execCommand("insertText", false, text);
}
