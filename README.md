# AI Bridge

A Chrome MV3 extension that relays prompts to **ChatGPT** and **Gemini** through your
already-logged-in browser session — usable from a Side Panel UI **or** as a small local HTTP
API that other tools (curl, Python, scripts) can call. No API keys: it drives the real web apps.

> Provider-agnostic "switching station" (*trạm chung chuyển*): one contract, pluggable drivers.
> Returns text, generated **images** (as base64), and **speech** (TTS, base64 audio).

## Why

- **No API keys / no extra cost** — reuses the session you're already logged into.
- **Works in background tabs** — reads answers from the network/DOM without stealing focus.
- **One contract, many providers** — a driver registry; adding a provider is one file.
- **Callable by other tools** — a local HTTP API turns it into a reusable backend.

## Features

| | ChatGPT | Gemini |
|---|---|---|
| Send prompt + read answer | ✅ (DOM) | ✅ (network intercept) |
| Auto-delete the temp chat | ✅ | ✅ |
| Generated image → base64 | ⚠️ untested | ✅ |
| Text-to-speech → base64 audio | — | ✅ (read-aloud) |
| Works while tab is backgrounded | ✅ | ✅ |

- **Side Panel** UI: provider picker, prompt, answer, image preview, 🔊 read-aloud + voice/accent picker. State persists across close/reopen.
- **Local HTTP API** (optional): `POST /ask`, `POST /tts` — see [host/README.md](host/README.md).

## Architecture

```
                         ┌────────────────────────── Chrome ──────────────────────────┐
 curl / Python ─HTTP─▶ host (Node, native msg) ─▶ service worker ─▶ content script ─┐  │
                         (host/)                    (src/background.js)  (src/content.js)│
 Side Panel  ───────────────────────────────────▶ service worker                    │  │
                                                                                     ▼  │
                                              provider driver (src/drivers/*) drives the │
                                              logged-in ChatGPT/Gemini tab (type+click)  │
                         answer read from: Gemini = intercepted StreamGenerate (XHR),    │
                                           ChatGPT = DOM. Images/audio → base64.         │
                         └──────────────────────────────────────────────────────────────┘
```

Key design points (details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **Send is UI-driven** (type + click). Anti-bot tokens can't be forged, so we let the page mint them.
- **Read is per-provider**: Gemini via network interception (survives background throttling),
  ChatGPT via DOM (its request bypasses page-world fetch).
- **Delete** the temp chat after each turn (ChatGPT PATCH; Gemini `batchexecute`).
- **Images**: fetch the CDN url from the response with `credentials:include` (redirect hosts are in
  `host_permissions`), with a page-context `crossOrigin`+canvas fallback for blob-only builds.
- **TTS**: Gemini read-aloud RPC returns Ogg/Opus base64 inline.

## Install

### 1. Extension
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the **Side Panel** (click the toolbar icon). Make sure you're logged into ChatGPT/Gemini.

### 2. Local HTTP API (optional)
Requires Node.js on PATH. The extension ID is pinned in the manifest (`key`), so it's the same on
every machine and `install.ps1` needs no arguments. See [host/README.md](host/README.md):
```powershell
powershell -ExecutionPolicy Bypass -File host\install.ps1
curl http://127.0.0.1:8765/health
```

### Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File host\uninstall.ps1   # removes the host + its generated files
```
Then `chrome://extensions` → **AI Bridge (dev)** → **Remove**, and delete the repo folder if desired.

## Usage (HTTP API)

```bash
curl -s http://127.0.0.1:8765/ask -H "content-type: application/json" \
  -d '{"prompt":"Tạo ảnh một quả táo đỏ","provider":"gemini"}'
# -> { ok, text, images:[{url,dataUrl,mimeType}], conversationId, provider }
```

### File upload (`POST /ask-file`)

Send a file + prompt to Gemini:
```bash
curl -s "http://127.0.0.1:8765/ask-file?prompt=Summarize%20this&mime=application/pdf&filename=document.pdf&path=auto" \
  -H "x-aibridge-key: <key-if-set>" \
  --data-binary "@document.pdf"
# -> { ok, text, conversationId, provider: "gemini" }
```

Full API + Python example: [host/README.md](host/README.md).

## Development

```bash
node --test        # zero-dep unit tests (parsers, drivers, queue, helpers)
```
- No build step, no bundler — plain ES modules.
- Layout: `src/` (extension), `host/` (native-messaging HTTP host), `test/`, `docs/`.

## Security

- **Never commit** `cookies.json`, `*.har`, or `.playwright-mcp/` — they hold **live session tokens**
  and page snapshots. They are gitignored.
- The HTTP API binds to `127.0.0.1` only. Set an API key (`install.ps1 -ApiKey ...`) to require the
  `x-aibridge-key` header.
- This automates *your own* logged-in accounts. Respect each provider's Terms of Service.

## Status

Development build (`v0.2.0`). Gemini path (text/image/TTS/delete) verified live; ChatGPT text/delete
verified; ChatGPT image/TTS wired but untested.
