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
  // ChatGPT's f/conversation request bypasses page-world fetch (service worker), so
  // network interception isn't reliable — but its React DOM renders even in a
  // background tab, so DOM read works. Gemini is the opposite (see gemini.js).
  readMode: "dom",

  async isLoggedIn() {
    try { await getAccessToken(); return true; } catch { return false; }
  },

  async startSend(prompt) {
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
  },

  // Read the answer from the DOM (reliable for ChatGPT, incl. background tabs).
  async readAnswer() {
    await waitFor(() => document.querySelector(SEL.stop), { tries: 150 });
    await waitFor(() => !document.querySelector(SEL.stop), { tries: 1200 });
    const answer = await readStable(() => {
      const n = document.querySelectorAll(SEL.assistant);
      return n.length ? n[n.length - 1].innerText.trim() : "";
    });
    // Generated (DALL·E) images render as <img> in the assistant turn; take http(s) srcs.
    const nodes = document.querySelectorAll(SEL.assistant);
    const last = nodes[nodes.length - 1];
    const images = last
      ? [...new Set([...last.querySelectorAll("img")].map((i) => i.src).filter((s) => /^https?:/.test(s)))].map((u) => ({ url: u }))
      : [];
    return { answer, conversationId: parseChatgptConvId(location.href), images };
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
