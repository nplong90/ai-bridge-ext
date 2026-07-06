# AI Audio Bridge — Thiết kế (Extension + Native Host)

**Ngày:** 2026-07-06
**Phạm vi:** CHỈ extension + native host. Cắt audio (FFmpeg) và TTS post-processing là tool ngoài, chỉ gọi HTTP API. Chúng KHÔNG nằm trong spec này.

## 1. Mục tiêu

Bổ sung cho AI Bridge extension một năng lực: nhận **một file audio + prompt** qua HTTP API local, đẩy lên Gemini Web (dùng phiên đăng nhập sẵn), và trả về **text kết quả** do Gemini sinh (thường là JSON dịch + timestamp). Extension **không parse** kết quả — tool ngoài lo. Mỗi request xử lý một file.

Kết quả này đã được người dùng kiểm chứng thủ công: upload file `audio/ogg` (Opus) lên gemini.google.com và Gemini transcribe + trả nội dung được.

## 2. Bằng chứng luồng upload (từ HAR thật)

Trace `gemini.google.com.har` xác nhận upload là luồng HTTP resumable chuẩn của Google, KHÔNG cần thao tác DOM:

1. **Start** — `POST https://push.clients6.google.com/upload/`
   - Headers chính: `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`, `X-Goog-Upload-Header-Content-Length: <byte size>`, `X-Tenant-Id: bard-storage`, `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`
   - Body: `File name: <tên file>`
   - Response header `X-Goog-Upload-URL` = URL upload có `upload_id`.
2. **Upload + finalize** — `POST <X-Goog-Upload-URL>`
   - Headers: `X-Goog-Upload-Command: upload, finalize`, `X-Goog-Upload-Offset: 0`
   - Body: **bytes file thô**
   - Response body (text): file token dạng `/contrib_service/ttl_1d/<id>_<hash>` (TTL 1 ngày).
3. **Generate** — chính `StreamGenerate` (batchexecute) mà extension ĐÃ intercept sẵn, với `f.req` nhúng tham chiếu file:
   ```
   [[[ "<contrib_token>", 4, null, "audio/ogg" ], "<filename>"]]
   ```
   cộng với prompt.

## 3. Chiến lược 2 đường (A chính, B fallback)

Vì Path A bám protocol nội bộ của Google (có thể đổi), thiết kế có Path B làm lưới an toàn.

### Path A — Replicate mạng (primary, chạy nền được)
Extension tự thực hiện 3 bước ở §2 bằng `fetch` có credential (chạy trong ngữ cảnh gemini.google.com để mang cookie):
- start upload → finalize → lấy contrib token
- scrape token phiên (`SNlM0e`/at, `cfb2h`/bl, `FdrFJe`/fsid — đã có trong `scrapeTokens`)
- tự dựng `f.req` StreamGenerate (prompt + file token) và POST `batchexecute`, theo đúng pattern `buildGeminiDeleteRequest` sẵn có.
- **Ưu:** không phụ thuộc UI, chạy khi tab ở background. **Nhược:** phải bám cấu trúc `f.req`.

### Path B — Mô phỏng kéo-thả (fallback, bền với thay đổi schema)
- Tạo `File` từ bytes → `DataTransfer` → `dispatchEvent('drop')` vào khung chat để **trang tự upload + tự dựng f.req**.
- Gõ prompt vào composer + click Send (tái dùng `startSend`).
- Đọc kết quả từ network (`readMode: "net"` sẵn có).
- **Ưu:** không "forge" f.req. **Nhược:** cần tab foreground, phụ thuộc selector.

### Chuyển A → B
Driver thử A trước. Chuyển sang B khi:
1. Upload fail (status ≠ 2xx hoặc không có `X-Goog-Upload-URL`) → thử lại A một lần, rồi B.
2. `batchexecute` lỗi hoặc response không parse được (không lấy được conversationId/answer) → B.
3. B cũng fail → trả lỗi rõ ràng về caller.

## 4. Thành phần & luồng dữ liệu

```
FFmpeg (ngoài) → POST 127.0.0.1:8765 → native host → extension → Gemini → text về ngược lại
```

### 4a. Native host (`host/aibridge-host.mjs`)
- Thêm endpoint `POST /ask-audio` nhận: audio bytes + `{prompt, lang?, filename?, mime?}` (multipart hoặc body nhị phân + query/header cho meta).
- **Giới hạn native messaging ~1MB (host→extension):** KHÔNG nhồi bytes qua stdio frame. Thay vào đó host **giữ bytes trong bộ nhớ theo request-id** và gửi extension một frame nhỏ:
  `{ id, op: "askaudio", prompt, blobUrl: "http://127.0.0.1:8765/blob/<id>", mime, filename }`
- Thêm route `GET /blob/<id>` trả bytes đã giữ (xóa sau khi phục vụ hoặc theo TTL ngắn).

### 4b. Lấy bytes vào ngữ cảnh Gemini
- Content script trên gemini.google.com `fetch(blobUrl)` lấy bytes (localhost là secure context nên không bị chặn mixed-content). Bytes dùng chung cho A và B.

### 4c. Driver Gemini (`src/drivers/gemini.js`)
- `uploadAudio(bytes, mime, filename)` → contrib token (Path A).
- `buildGeminiGenerateRequest({prompt, fileToken, mime, filename, at, bl, fsid})` → request batchexecute (Path A) — theo mẫu `buildGeminiDeleteRequest`.
- `attachViaDrop(file)` + dùng lại `startSend(prompt)` (Path B).
- Điều phối A→B + đọc kết quả.

### 4d. Manifest
- Thêm `host_permissions`: `https://push.clients6.google.com/*`.

## 5. Config tách rời

File `src/config/gemini-upload.json`:
- Template `f.req` StreamGenerate (trích từ HAR).
- Headers upload (`X-Tenant-Id`, `X-Goog-Upload-*`, ...).
- Selectors Path B (khung chat / drop-zone / composer / send).

Mục đích: khi Google đổi UI/schema, sửa config, không phải build lại logic.

## 6. Xử lý lỗi

- Timeout: tái dùng `REQUEST_TIMEOUT_MS` của host.
- Mỗi request dùng **chat mới** (`newChatUrl`) để tránh lẫn ngữ cảnh giữa các file/chunk.
- Fallback A→B như §3.
- Lỗi cuối cùng trả JSON `{ ok:false, error }` đúng format hiện có của host.

## 7. Chiến lược verify theo mốc

- **Mốc 0 — smoke test đường ống (code sẵn có):** `POST /ask {prompt}` từ tool ngoài → nhận text. Xác nhận toàn bộ đường ống dùng chung (external → HTTP → native messaging → extension → Gemini → về). Lỗi sau mốc này chắc chắn nằm ở phần audio mới.
- **Mốc 1 — Path A:** thêm nhận file + upload + f.req. Đối chiếu kết quả với lần thử tay trên gemini.google.com.
- **Mốc 2 — Path B fallback:** thêm mô phỏng kéo-thả + cơ chế A hỏng → chuyển B.

Mỗi mốc chạy và test được độc lập.

## 8. Ngoài phạm vi (không làm trong spec này)

- Cắt/nén audio bằng FFmpeg.
- Điều phối nhiều chunk (hàng đợi, ghép kết quả).
- TTS + time-stretch.
- Parse/validate JSON kết quả (do tool ngoài lo).
