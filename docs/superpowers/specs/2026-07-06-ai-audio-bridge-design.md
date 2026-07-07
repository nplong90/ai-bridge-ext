# AI Media Bridge — Thiết kế (Extension + Native Host)

**Ngày:** 2026-07-06
**Phạm vi:** CHỈ extension + native host. Cắt/nén file (FFmpeg) và TTS post-processing là tool ngoài, chỉ gọi HTTP API. Chúng KHÔNG nằm trong spec này.

## 1. Mục tiêu

Bổ sung cho AI Bridge extension một năng lực: nhận **một file bất kỳ định dạng Gemini nhận (audio/video/ảnh/PDF/text...) + prompt** qua HTTP API local, đẩy lên Gemini Web (dùng phiên đăng nhập sẵn), và trả về **text kết quả** do Gemini sinh (thường là JSON dịch + timestamp). Extension **không parse** kết quả — tool ngoài lo. Mỗi request xử lý một file.

**Nguyên tắc format-agnostic:** extension KHÔNG hardcode định dạng. MIME type do caller truyền vào, pass-through nguyên vẹn vào header upload + `f.req`. Gemini server là bên quyết định chấp nhận. Việc nén/làm nhẹ file do tool ngoài (FFmpeg) lo — ngoài phạm vi spec này.

Đã được người dùng kiểm chứng thủ công: upload `audio/ogg` (Opus) lên gemini.google.com, Gemini transcribe + trả nội dung được.

## 2. Định dạng hỗ trợ

Extension chuyển tiếp MIME của caller; danh sách chấp nhận nằm trong config (`supportedMime`) để validate và báo lỗi thân thiện, KHÔNG hardcode trong logic. Nguồn quyết định cuối cùng vẫn là Gemini server.

Seed mặc định (điều chỉnh trong config khi cần):

- **Audio:** `audio/ogg`, `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/aac`, `audio/flac`, `audio/aiff`
- **Video:** `video/mp4`, `video/mpeg`, `video/quicktime`, `video/webm`, `video/x-msvideo`, `video/3gpp`
- **Ảnh:** `image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif`
- **Tài liệu:** `application/pdf`, `text/plain`

Nếu MIME không nằm trong allowlist: vẫn cho phép qua nhưng gắn cảnh báo (allowlist chỉ để cảnh báo sớm, không chặn cứng).

## 3. Bằng chứng luồng upload (từ HAR thật)

Trace `gemini.google.com.har` xác nhận upload là luồng HTTP resumable chuẩn của Google, KHÔNG cần thao tác DOM:

1. **Start** — `POST https://push.clients6.google.com/upload/`
   - Headers chính: `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`, `X-Goog-Upload-Header-Content-Length: <byte size>`, `X-Tenant-Id: bard-storage`, `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`
   - Body: `File name: <tên file>`
   - Response header `X-Goog-Upload-URL` = URL upload có `upload_id`.
2. **Upload + finalize** — `POST <X-Goog-Upload-URL>`
   - Headers: `X-Goog-Upload-Command: upload, finalize`, `X-Goog-Upload-Offset: 0`
   - Body: **bytes file thô**
   - Response body (text): file token dạng `/contrib_service/ttl_1d/<id>_<hash>` (TTL 1 ngày).
3. **Generate** — chính `StreamGenerate` (batchexecute) mà extension ĐÃ intercept sẵn, với `f.req` nhúng tham chiếu file (mime là tham số, không cố định):

   ```text
   [[[ "<contrib_token>", 4, null, "<mime>" ], "<filename>"]]
   ```

   cộng với prompt.

## 4. Chiến lược 2 đường (A chính, B fallback)

Vì Path A bám protocol nội bộ của Google (có thể đổi), thiết kế có Path B làm lưới an toàn.

### Path A — Replicate mạng (primary, chạy nền được)

Extension tự thực hiện 3 bước ở §3 bằng `fetch` có credential (chạy trong ngữ cảnh gemini.google.com để mang cookie):

- start upload → finalize → lấy contrib token
- scrape token phiên (`SNlM0e`/at, `cfb2h`/bl, `FdrFJe`/fsid — đã có trong `scrapeTokens`)
- tự dựng `f.req` StreamGenerate (prompt + file token + mime) và POST `batchexecute`, theo đúng pattern `buildGeminiDeleteRequest` sẵn có.
- **Ưu:** không phụ thuộc UI, chạy khi tab ở background. **Nhược:** phải bám cấu trúc `f.req`.

### Path B — Mô phỏng kéo-thả (fallback, bền với thay đổi schema)

- Tạo `File` từ bytes → `DataTransfer` → `dispatchEvent('drop')` vào khung chat để **trang tự upload + tự dựng f.req**.
- Gõ prompt vào composer + click Send (tái dùng `startSend`).
- Đọc kết quả từ network (`readMode: "net"` sẵn có).
- **Ưu:** không "forge" f.req, bền với đổi schema. **Nhược:** cần tab foreground, phụ thuộc selector.

### Cơ chế phát hiện A hỏng → chuyển B

Nhiều tín hiệu, xếp theo thời điểm:

1. **Pre-check (trước khi thử A):** nếu `scrapeTokens` không lấy được `SNlM0e`/`cfb2h`/`FdrFJe` → trang đã đổi → **bỏ qua A, vào thẳng B**.
2. **Upload fail:** status ≠ 2xx hoặc thiếu `X-Goog-Upload-URL` → thử lại A một lần, rồi B.
3. **Payload lỗi cấp Gemini:** batchexecute trả HTTP 200 nhưng nội dung là lỗi (file không hỗ trợ / quota / từ chối) hoặc không parse được token/answer → đọc mã lỗi trong response, chuyển B.
4. **Circuit breaker:** A hỏng liên tiếp N lần (state nhẹ trong bộ nhớ) → tự ưu tiên B một thời gian, tránh phí cú A hỏng mỗi request.
5. **B fail:** trả lỗi rõ ràng về caller.

**Override thủ công:** request nhận param `path: "A" | "B" | "auto"` (mặc định `auto`) để ép đường đi — phục vụ test từng mốc độc lập và debug.

## 5. Thành phần & luồng dữ liệu

```text
FFmpeg (ngoài) → POST 127.0.0.1:8765 → native host → extension → Gemini → text về ngược lại
```

### 5a. Native host (`host/aibridge-host.mjs`)

- Thêm endpoint `POST /ask-file` nhận: file bytes + `{prompt, lang?, filename?, mime?, path?}`.
- **Giới hạn native messaging ~1MB (host→extension):** KHÔNG nhồi bytes qua stdio frame. Host **giữ bytes trong bộ nhớ theo request-id** và gửi extension một frame nhỏ:
  `{ id, op: "askfile", prompt, blobUrl: "http://127.0.0.1:8765/blob/<id>", mime, filename, path }`
- Thêm route `GET /blob/<id>` trả bytes đã giữ (xóa sau khi phục vụ hoặc theo TTL ngắn).

### 5b. Lấy bytes vào ngữ cảnh Gemini

- Content script trên gemini.google.com `fetch(blobUrl)` lấy bytes (localhost là secure context, không bị chặn mixed-content). Bytes dùng chung cho A và B.

### 5c. Driver Gemini (`src/drivers/gemini.js`)

- `uploadFile(bytes, mime, filename)` → contrib token (Path A).
- `buildGeminiGenerateRequest({prompt, fileToken, mime, filename, at, bl, fsid})` → request batchexecute (Path A) — theo mẫu `buildGeminiDeleteRequest`.
- `attachViaDrop(file)` + dùng lại `startSend(prompt)` (Path B).
- Điều phối A→B (theo §4) + đọc kết quả.

### 5d. Manifest

- Thêm `host_permissions`: `https://push.clients6.google.com/*`.

## 6. Config tách rời (`src/config/gemini-upload.json`)

Chứa mọi thứ hay đổi theo Google, để sửa config thay vì build lại logic:

- **Upload:** URL `push.clients6.google.com/upload/`, `X-Tenant-Id: bard-storage`, các header `X-Goog-Upload-*`.
- **Generate:** đường `batchexecute`, `rpcids` của StreamGenerate, `bl`/`hl`.
- **Scrape token:** regex/key cho `SNlM0e`/`cfb2h`/`FdrFJe` (tên key này có đổi).
- **f.req:** template + cấu trúc con đính file `[[[token,4,null,mime],filename]]` (kể cả magic `4`).
- **Parse response:** anchor để lấy answer/conversationId.
- **Selectors Path B:** drop-zone, composer, send, dấu hiệu render xong.
- **`supportedMime`:** allowlist định dạng (§2).
- **`capturedOn`:** ngày trích config (để biết độ cũ).

## 7. Xử lý lỗi

- Timeout: tái dùng `REQUEST_TIMEOUT_MS` của host.
- Mỗi request dùng **chat mới** (`newChatUrl`) để tránh lẫn ngữ cảnh giữa các file/chunk.
- Fallback A→B như §4.
- Lỗi cuối trả JSON `{ ok:false, error }` đúng format hiện có của host.

## 8. Chiến lược verify theo mốc

- **Mốc 0 — smoke test đường ống (code sẵn có):** `POST /ask {prompt}` từ tool ngoài → nhận text. Xác nhận toàn bộ đường ống dùng chung (external → HTTP → native messaging → extension → Gemini → về). Lỗi sau mốc này chắc chắn nằm ở phần file mới.
- **Mốc 1 — Path A:** thêm nhận file + upload + f.req (dùng `path:"A"` để ép). Đối chiếu kết quả với lần thử tay trên gemini.google.com.
- **Mốc 2 — Path B fallback:** thêm mô phỏng kéo-thả (`path:"B"` để test riêng) + cơ chế A hỏng → chuyển B (`auto`).

Mỗi mốc chạy và test được độc lập.

## 9. Ngoài phạm vi (không làm trong spec này)

- Cắt/nén file bằng FFmpeg.
- Điều phối nhiều chunk (hàng đợi, ghép kết quả).
- TTS + time-stretch.
- Parse/validate JSON kết quả (do tool ngoài lo).
