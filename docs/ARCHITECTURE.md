# Architecture

How AI Bridge drives ChatGPT/Gemini through the logged-in session, and why each piece works the
way it does. Hard-won details are recorded here so they aren't rediscovered.

## Components

| File | World | Role |
|---|---|---|
| `manifest.json` | — | MV3 config, permissions, content-script registration |
| `src/interceptor.js` | MAIN, `document_start` | Patches `XMLHttpRequest` to capture the answer response; posts raw body to the content script |
| `src/content.js` | isolated | Per-turn orchestration: pick driver → login check → send → read → reply → delete |
| `src/drivers/*.js` | isolated | Per-provider behaviour (selectors, read mode, delete) + registry |
| `src/parsers.js` | — (pure) | Parse Gemini StreamGenerate / ChatGPT SSE; extract image urls; parse TTS audio |
| `src/background.js` | service worker | Tab lifecycle, serial queue, image→base64, TTS, Side Panel state, HTTP-API bridge |
| `src/sidepanel.*` | panel | UI; talks to the SW via messages + `chrome.storage` |
| `host/` | Node process | Native-messaging host exposing a local HTTP API |

## Request lifecycle (one `ask`)

1. SW `ask(prompt, provider)` picks the driver, ensures a provider tab, navigates it to a new chat.
2. SW sends `ASK` to the content script; the driver **types the prompt and clicks send**.
3. The driver reads the answer (see read modes), returns `{answer, conversationId, images}`.
4. SW resolves images to base64, optionally runs TTS, returns the result, and the driver **deletes**
   the temp chat (fire-and-forget).
5. Requests are **serialized** through a queue (`src/queue.js`) — one provider turn at a time.

## Why send is UI-driven

Forging the send request fails: ChatGPT returns 403 "Unusual activity" because the page mints
anti-bot tokens (sentinel/turnstile) that can't be reproduced. So we **type into the composer and
click the send button** and let the page build the real request. Selectors are locale-independent
where possible (e.g. Gemini's send button is matched by container, not its localized aria-label).

## Read modes (per provider)

Background tabs are throttled (timers/rendering deferred) but **network is not**. Each provider uses
whichever path survives backgrounding:

- **Gemini → network interception.** `interceptor.js` (MAIN world, installed at `document_start`)
  wraps `XMLHttpRequest` and forwards the raw `StreamGenerate` response to the content script via
  `postMessage`. `parseGeminiStream` extracts the answer (`inner[4][0][1][0]`), conversation id
  (`inner[1][0]`, already `c_…`), and image urls. Works fully in the background.
- **ChatGPT → DOM.** Its `/backend-api/f/conversation` request goes through a service worker, so it
  never hits page-world `fetch` (nothing to intercept). But React renders even in a background tab,
  so we read the last `[data-message-author-role="assistant"]` once the stop-button disappears.

We intentionally **do not wrap `window.fetch`** — it caught nothing useful and put the extension in
the stack trace of the page's own (CSP-blocked) ad/analytics beacons.

## Delete

- **ChatGPT**: `PATCH /backend-api/conversation/{id}` `{is_visible:false}` with
  `Authorization: Bearer <accessToken>` from `GET /api/auth/session`.
- **Gemini**: `batchexecute?rpcids=GzXR5e`, `f.req=[[["GzXR5e","[\"c_<id>\"]",null,"generic"]]]&at=<at>`,
  run in the tab's MAIN world (the WIZ `at` token lives on `window.WIZ_global_data`, falling back to
  scraping `SNlM0e`/`cfb2h`/`FdrFJe` from page HTML). The id already carries the `c_` prefix — do not
  double it.

## Generated images → base64

The hard part. What was learned:

- The response often carries only a **placeholder** (`googleusercontent.com/image_generation_content/N`);
  the real image is at `lh3.googleusercontent.com/(gg|gg-dl)/…` which **302-redirects** to
  `work.fife.usercontent.google.com/rd-gg-dl/…` or `lh3.google.com/rd-gg/…`.
- The image is **auth-gated** (anonymous fetch → 403) and the CDN answers `Access-Control-Allow-Origin: *`,
  which the browser rejects for credentialed requests — **and** the SW loses its CORS exemption when the
  request redirects to a host not in `host_permissions`.
- **Fix**: add the redirect hosts (`*.usercontent.google.com`, `lh3.google.com`) to `host_permissions`
  and fetch with `credentials:"include"`. The SW then reads the bytes directly (`urlToDataUrl`).
- **Fallbacks**: page-context `new Image(crossOrigin="anonymous")` + canvas (for CORS-open forms), and,
  for blob-only builds where the image is a same-origin `blob:` on an `<img>`, briefly activate the tab
  so it renders and canvas-capture the (untainted, same-origin) blob.
- **Image-mode ("thể image") is the same request** as a normal prompt — no special flag; the server
  picks the image model (`imagen_default`/Nano) by intent. Verified against a HAR capture.
- Dead ends: CDP `Network.getResponseBody` (image is fetched internally / doesn't hit the layer we can
  read), and canvas of a cross-origin `<img>` (tainted).

## Text-to-speech → base64 audio

Gemini "read aloud" is `batchexecute?rpcids=XqA3Ic`, payload `[null,"<text>","<lang>",null,2]` + `at`.
The response embeds the audio as a long base64 run (Ogg/Opus — "Google Speech using libopus"); padding
is written as `=`. `parseGeminiTts` scans for the run, re-pads, decodes, and identifies the
container by magic bytes (OggS/ID3/fLaC/MPEG/WAV). Voice selection on the web is limited to
language/accent (the named-voice setting is mobile-only and account-wide).

## Local HTTP API bridge

MV3 extensions cannot open a listening socket, so a tiny zero-dep **native-messaging host**
(`host/aibridge-host.mjs`) is auto-launched by Chrome when the SW calls `connectNative`. It serves
`127.0.0.1` HTTP and relays each request over native-messaging stdio to the SW, which runs it through
the same `ask()`/`ttsGemini()` path (`handleApiOp`). A 20s host→SW ping (toggleable) keeps the SW
alive so the endpoint stays ready; a 30s alarm reconnects if the port drops. See [../host/README.md](../host/README.md).

## Adding a provider

Implement a driver (`id`, `hostMatch`, `newChatUrl`, `capabilities`, `readMode`, `isLoggedIn`,
`startSend`, `readAnswer`, `deleteConversation`) and add it to `src/drivers/index.js`. Nothing else
changes — the registry feeds the Side Panel picker and the API.
