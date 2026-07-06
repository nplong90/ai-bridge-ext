# AI Bridge — Local HTTP API

Turns the extension into a tiny local HTTP API so any tool (curl, Python, Node, …) can drive
ChatGPT/Gemini through your logged-in browser session.

```
tool ──HTTP──▶ host (Node, this folder) ──native messaging──▶ extension SW ──▶ ChatGPT/Gemini
     ◀─JSON──                            ◀───────────────────
```

The host is launched automatically by Chrome when the extension starts — no server to babysit.
It idles cheaply and exits when the browser/extension goes away. Zero npm dependencies.

## Install (Windows, one time)

1. Load the extension (`chrome://extensions` → Developer mode → Load unpacked → this repo).
   The ID is pinned by the manifest `key` (`pfjfedifpkebijefjfoliofcjkipkpnd`), same on every machine.
2. Register the host (no ID needed — it defaults to the pinned ID):

   ```powershell
   powershell -ExecutionPolicy Bypass -File host\install.ps1
   ```

3. Reload the extension (so it connects to the freshly-registered host).
4. Verify:

   ```bash
   curl http://127.0.0.1:8765/health
   # {"ok":true,"service":"ai-bridge","port":8765}
   ```

Requires Node.js on PATH. Uninstall: `powershell -ExecutionPolicy Bypass -File host\uninstall.ps1`.

## Config (options on install)

```powershell
# custom port + require an API key + let the service worker sleep (lower idle cost)
powershell -ExecutionPolicy Bypass -File host\install.ps1 -ExtensionId <id> -Port 8899 -ApiKey "s3cret" -NoKeepAlive
```
Re-run `install.ps1` any time to change these, then reload the extension.

- **`-ApiKey`** — if set, every `/ask` and `/tts` call must send header `x-aibridge-key: <key>`
  (otherwise `401`). Without it the API is open to any local process (bound to `127.0.0.1` only).
- **`-NoKeepAlive`** — don't hold the extension's service worker awake. Saves idle CPU/RAM, but the
  first call after it sleeps may be slow or need one retry (it reconnects within ~30s). Default:
  keepalive on = always instantly ready.
- **`-Port`** — HTTP port (default `8765`).

(These are baked into the generated `aibridge-host.bat` as env vars.)

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File host\uninstall.ps1
```
Removes the registry key and the generated `com.aibridge.host.json` + `aibridge-host.bat`.
Then remove the extension at `chrome://extensions` → **AI Bridge (dev)** → **Remove**, and delete the
repo folder if you no longer need it. (Node.js is left untouched.)

## API

### `POST /ask`
```jsonc
// request
{ "prompt": "Tạo ảnh một quả táo đỏ", "provider": "gemini", "tts": false, "lang": "vi" }
// response
{ "ok": true, "text": "...", "conversationId": "c_...",
  "images": [{ "url": "...", "dataUrl": "data:image/png;base64,...", "mimeType": "image/png" }],
  "audio":  { "dataUrl": "data:audio/ogg;base64,...", "mimeType": "audio/ogg" },  // only if tts:true
  "provider": "gemini" }
```
- `provider`: `"gemini"` or `"chatgpt"` (default `chatgpt`).
- `tts`: if true, also synthesize speech of the answer (Gemini).
- `lang`: TTS voice/accent (`vi`, `en-US`, …); omit to auto-detect.

### `POST /tts`
```jsonc
{ "text": "Xin chào", "lang": "vi" }   // -> { ok, audio:{dataUrl,mimeType} }
```

### `POST /ask-file`

Upload a file to Gemini with an optional prompt. Raw file bytes go in the request body; metadata in the query string.

- **Query params:**
  - `mime` (required): MIME type (e.g., `application/pdf`, `image/png`). See [src/config/gemini-upload.json](../src/config/gemini-upload.json) for the full list of supported formats.
  - `prompt` (optional): text prompt to accompany the file.
  - `filename` (optional): display name of the file (default: `upload.bin`).
  - `lang` (optional): language/accent for the response.
  - `path` (optional): upload strategy — `A` (direct), `B` (drag-drop fallback), or `auto` (try A, fall back to B; default).
- **Body:** raw file bytes (via `--data-binary @file`).
- **Response:** `{ ok, text, conversationId, provider: "gemini" }` — caller parses the JSON result, not the host.
- **Header:** if `AIBRIDGE_KEY` is set, include `x-aibridge-key: <key>`.

Note: the host holds uploaded bytes for ~3 minutes, then discards them. When Gemini's upload UI or schema changes, edit the `selectors` and `supportedMime` in `src/config/gemini-upload.json` — do not modify the host code.

### `GET /health`
Liveness check.

## Examples

```bash
# text
curl -s http://127.0.0.1:8765/ask -H "content-type: application/json" \
  -d '{"prompt":"2+2?","provider":"gemini"}'

# image (dataUrl is base64 PNG bytes)
curl -s http://127.0.0.1:8765/ask -H "content-type: application/json" \
  -d '{"prompt":"tạo ảnh con mèo","provider":"gemini"}'
```

```python
import requests
r = requests.post("http://127.0.0.1:8765/ask",
                  json={"prompt": "Viết haiku về biển", "provider": "gemini", "tts": True, "lang": "vi"})
data = r.json()
print(data["text"])
if data.get("audio"):
    import base64
    b64 = data["audio"]["dataUrl"].split(",", 1)[1]
    open("out.ogg", "wb").write(base64.b64decode(b64))
```

## Notes
- Requests are queued serially in the extension (one provider turn at a time).
- The browser must be open and logged into the provider. Temp chats are auto-deleted.
- Only `127.0.0.1` binds; not exposed to the network.
