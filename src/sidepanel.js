import { DRIVER_META } from "./drivers/index.js";

const $ = (id) => document.getElementById(id);

const promptEl = $("prompt");
const sendBtn = $("send");
const sendLabel = sendBtn.querySelector(".send-label");
const statusEl = $("status");
const statusText = $("status-text");
const answerEl = $("answer");
const answerBody = $("answer-body");
const copyBtn = $("copy");
const ttsBtn = $("tts");
const voiceEl = $("voice");
const audioEl = $("audio");
const newBtn = $("new");

// Which providers can synthesize speech (from the driver registry).
const AUDIO_PROVIDERS = new Set(DRIVER_META.filter((d) => d.capabilities && d.capabilities.audio).map((d) => d.id));

// TTS "voice" = language/accent (Gemini web read-aloud has no per-request voice; the named-voice
// setting is mobile-only + account-wide). "auto" lets the background detect vi vs en.
const VOICES = [
  ["auto", "Tự động"], ["vi", "Tiếng Việt"], ["en-US", "English (US)"], ["en-GB", "English (UK)"],
  ["en-AU", "English (AU)"], ["en-IN", "English (IN)"], ["ja-JP", "日本語"], ["ko-KR", "한국어"],
  ["zh-CN", "中文"], ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["es-ES", "Español"],
  ["hi-IN", "हिन्दी"], ["id-ID", "Indonesia"], ["th-TH", "ไทย"],
];
const VOICE_KEY = "cgw_voice";
for (const [val, label] of VOICES) {
  const opt = document.createElement("option");
  opt.value = val; opt.textContent = label;
  voiceEl.appendChild(opt);
}
chrome.storage.local.get(VOICE_KEY, (d) => { if (d[VOICE_KEY]) voiceEl.value = d[VOICE_KEY]; });
voiceEl.addEventListener("change", () => chrome.storage.local.set({ [VOICE_KEY]: voiceEl.value }));

const providerEl = document.getElementById("provider");
const PROVIDER_KEY = "cgw_provider";

const STATE_KEY = "cgw_state";

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

if (navigator.platform.toLowerCase().includes("mac")) $("kbd-hint").textContent = "⌘";

function setStatus(kind, text) {
  if (!kind) { statusEl.classList.remove("show"); return; }
  statusEl.dataset.kind = kind;
  statusText.textContent = text;
  statusEl.classList.add("show");
}

function setLoading(on) {
  sendBtn.disabled = on;
  promptEl.disabled = on;
  sendBtn.classList.toggle("is-loading", on);
  sendLabel.textContent = on ? "Đang gửi" : "Gửi";
}

const imagesEl = $("images");

function renderImages(images) {
  imagesEl.textContent = "";
  for (const img of images || []) {
    const el = document.createElement("img");
    el.src = img.dataUrl || img.url;
    el.alt = "generated image";
    imagesEl.appendChild(el);
  }
}

function resetAudio() {
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.hidden = true;
  ttsBtn.disabled = false;
  ttsBtn.textContent = "🔊 Đọc";
}

function showAnswer(text, images, provider) {
  answerBody.textContent = text || (images && images.length ? "" : "(trống)");
  renderImages(images);
  resetAudio();
  const canTts = !!(text && AUDIO_PROVIDERS.has(provider));
  ttsBtn.hidden = !canTts;
  voiceEl.hidden = !canTts;
  answerEl.classList.add("show");
}

// Single source of truth: render whatever the background persisted.
function render(state) {
  if (!state || !state.status) {
    setLoading(false);
    setStatus(null);
    answerEl.classList.remove("show");
    return;
  }
  if (typeof state.prompt === "string" && state.prompt) promptEl.value = state.prompt;

  if (state.status === "sending") {
    setLoading(true);
    setStatus("info", "Đang tạo chat mới và gửi…");
    answerEl.classList.remove("show");
  } else if (state.status === "ok") {
    setLoading(false);
    setStatus("ok", "Xong — chat tạm đã được xoá");
    showAnswer(state.text, state.images, state.provider);
  } else if (state.status === "error") {
    setLoading(false);
    setStatus("err", "Lỗi: " + (state.error || "không rõ"));
    answerEl.classList.remove("show");
  }
}

// Restore on open.
chrome.storage.local.get(STATE_KEY, (data) => render(data[STATE_KEY]));

// Stay in sync while open (background writes each transition).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATE_KEY]) render(changes[STATE_KEY].newValue);
});

function send() {
  const prompt = promptEl.value.trim();
  if (!prompt) { promptEl.focus(); return; }
  // Optimistic; the background confirms via storage.
  setLoading(true);
  setStatus("info", "Đang tạo chat mới và gửi…");
  answerEl.classList.remove("show");
  chrome.runtime.sendMessage({ type: "ASK-FROM-PANEL", prompt, provider: providerEl.value }, () => void chrome.runtime.lastError);
}

sendBtn.addEventListener("click", send);

promptEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
});

newBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR-STATE" }, () => void chrome.runtime.lastError);
  promptEl.value = "";
  setLoading(false);
  setStatus(null);
  resetAudio();
  ttsBtn.hidden = true;
  voiceEl.hidden = true;
  answerEl.classList.remove("show");
  promptEl.focus();
});

ttsBtn.addEventListener("click", () => {
  const text = answerBody.textContent.trim();
  if (!text) return;
  ttsBtn.disabled = true;
  ttsBtn.textContent = "Đang tạo…";
  const lang = voiceEl.value && voiceEl.value !== "auto" ? voiceEl.value : undefined;
  chrome.runtime.sendMessage({ type: "TTS-FROM-PANEL", text, provider: providerEl.value, lang }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      ttsBtn.disabled = false;
      ttsBtn.textContent = "🔊 Lỗi, thử lại";
      return;
    }
    audioEl.src = res.dataUrl;
    audioEl.hidden = false;
    audioEl.play().catch(() => {});
    ttsBtn.disabled = false;
    ttsBtn.textContent = "🔊 Đọc lại";
  });
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(answerBody.textContent);
    const prev = copyBtn.textContent;
    copyBtn.textContent = "Đã chép ✓";
    setTimeout(() => { copyBtn.textContent = prev; }, 1500);
  } catch {
    copyBtn.textContent = "Không chép được";
  }
});
