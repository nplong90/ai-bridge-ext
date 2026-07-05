# ChatGPT Web Wrapper Extension — Thiết kế (v1)

**Ngày:** 2026-07-04
**Trạng thái:** ✅ Đã kiểm chứng end-to-end trên tài khoản thật (Playwright + cookies) — 2026-07-04

> **Sửa lớn so với bản draft đầu:** Bản draft chọn hướng "forge fetch trong ngữ cảnh
> trang" cho việc gửi. Kiểm thử thực tế đã **phủ nhận** hướng đó (xem §10). Thiết kế này
> phản ánh kiến trúc **đã verify chạy được**: gửi qua **điều khiển UI**, xoá bằng
> **forge PATCH có Bearer token**.

## 1. Mục tiêu

Xây dựng một extension trình duyệt (Chrome MV3) cho phép gửi một prompt tới ChatGPT
bằng **tài khoản đã đăng nhập sẵn trên trình duyệt** và nhận lại câu trả lời dạng text.

Đây là **v1 / phần lõi**. Mục tiêu cuối (bọc thành API cho Google Apps Script qua
companion app + tunnel) để giai đoạn sau; v1 chỉ cần chứng minh gửi/nhận hoạt động
qua một popup test. Song song với [Gemini Web Wrapper](2026-07-04-gemini-web-wrapper-extension-design.md);
kết cục ChatGPT cũng phải **điều khiển UI để gửi** giống Gemini v1, vì lý do token bên dưới.

## 2. Phạm vi v1

**Trong phạm vi:**
- Extension tự mở & quản lý một tab ChatGPT riêng (dùng phiên đăng nhập sẵn).
- Nhận prompt → tạo chat mới → **gửi qua UI** → đọc câu trả lời từ DOM → **xoá chat** (chống rác).
- Popup để nhập prompt thử và xem kết quả + trạng thái.

**Ngoài phạm vi (để v2):**
- Companion app + Cloudflare Tunnel + API cho Apps Script.
- Multi-session / giữ ngữ cảnh nhiều hội thoại (v1 mỗi prompt là chat mới độc lập rồi xoá).
- Gửi kèm ảnh/file, chọn model, streaming từng phần ra ngoài.

## 3. Xác thực (đã verify)

- **Cookie phiên** (đăng nhập sẵn) — bắt buộc, request cùng origin tự đính kèm.
- **`Authorization: Bearer <accessToken>`** — **bắt buộc cho mọi `backend-api`**.
  Lấy bằng `GET /api/auth/session` → `{ accessToken }`.
  (Bản draft nói "chỉ cookie" là **sai** — forge PATCH không Bearer trả **401
  "Access token is missing"**.)

## 4. Giao thức (đã verify từ HAR + test thật)

### 4.1 Gửi tin nhắn — KHÔNG forge được → điều khiển UI
Endpoint thật: `POST /backend-api/f/conversation` (SSE trả về). Nhưng request bắt buộc 3
token sentinel: `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`
(proof-of-work), `openai-sentinel-turnstile-token` (Cloudflare). **Cả 3 do `sentinel/sdk.js`
của trang tự sinh phía client, không forge được từ ngoài.** Forge thử → **403 "Unusual
activity has been detected from your device"**.

→ **Giải pháp v1: điều khiển UI** để trang tự sinh token & tự gửi:
1. Ghi prompt vào composer `#prompt-textarea` bằng `document.execCommand("insertText", …)`
   (kích hoạt đúng chuỗi sự kiện `beforeinput`/`input` mà ProseMirror/React cần).
2. Bấm nút gửi `[data-testid="send-button"]` (chờ tới khi hết `disabled`).
3. Gửi từ trang `/` (new chat) → trang tự điều hướng sang `/c/<conversation_id>`.

### 4.2 Đọc câu trả lời — từ DOM (không phụ thuộc SSE)
- Vòng đời sinh câu trả lời: `[data-testid="stop-button"]` **xuất hiện** khi đang stream,
  **biến mất** khi xong.
- Sau khi stop-button biến mất: đọc `[data-message-author-role="assistant"]` (node cuối).
- **Lưu ý race (đã gặp & fix):** lúc chuyển route `/` → `/c/<id>`, DOM có thể trống
  chốc lát và text đến sau khi stop-button biến mất. → **Poll tới khi text non-empty
  và ổn định** (không đổi qua 3 lần đọc liên tiếp), không dùng sleep cố định.
- `conversation_id` lấy từ URL: `/c/<id>`.

### 4.3 Xoá chat — forge được (có Bearer)
```
PATCH /backend-api/conversation/<conversation_id>
Headers: authorization: Bearer <accessToken>, content-type: application/json
body: {"is_visible": false}
```
→ **200 `{"success":true}`** (đã verify). Không cần token sentinel.

## 5. Kiến trúc

```
Popup ──ASK──► Background (service worker)
                 │  đảm bảo/ mở tab ChatGPT (pinned); hàng đợi 1-request; timeout
                 │  mỗi request: điều hướng tab về "/" (new chat) + chờ content READY
                 ▼
              Content script (isolated world)
                 │  gõ prompt vào composer + bấm gửi
                 │  chờ stop-button biến mất → poll đọc câu trả lời ổn định
                 │  lấy conversation_id từ URL
                 │  forge PATCH xoá chat (accessToken từ /api/auth/session)
                 ◄── {ok, text, conversationId} ──►
```

Không cần MAIN-world injection / patch fetch (đã bỏ) → tránh luôn vấn đề CSP.

### 5.1 Các thành phần

| File | Vai trò |
|------|---------|
| `manifest.json` | MV3; host_permissions `https://chatgpt.com/*`; permissions `scripting`,`tabs`; content_script `content.js`; web_accessible_resources `shared.js` |
| `background.js` | Điều phối; vòng đời tab; hàng đợi tuần tự; điều hướng new-chat + handshake READY; timeout |
| `content.js` | Isolated world: gõ prompt, bấm gửi, chờ & đọc câu trả lời (poll ổn định), forge xoá; bridge message |
| `shared.js` | Hàm/hằng thuần: `PATHS`, `SELECTORS`, `buildDeleteBody`, `parseConvId` — dùng chung cho content (dynamic import) & Node test |
| `queue.js` | Hàng đợi tuần tự (1 request/lần); test độc lập được |
| `sidepanel.html` / `sidepanel.js` | **Side Panel** (không phải popup — popup đóng khi mất focus). Nhập prompt, hiển thị trả lời + trạng thái; render từ `chrome.storage`, có nút "＋ Mới" |

> **UI = Side Panel + persist state.** Popup mặc định của extension **đóng ngay khi mất
> focus** → mất câu trả lời đang xem. Nên dùng `chrome.sidePanel` (bấm icon mở panel dọc,
> ở nguyên khi duyệt web). Background **sở hữu vòng đời request** và ghi trạng thái vào
> `chrome.storage.local` (`{status,prompt,text,error}`); panel render từ storage + lắng nghe
> `storage.onChanged` → đóng/mở lại vẫn khôi phục nguyên trạng, không mất dữ liệu.
> Cần thêm permission `sidePanel`, `storage`.

## 6. Luồng xử lý một prompt

1. Popup → background `{type:'ASK-FROM-POPUP', prompt}`.
2. Background: `ensureTab()` (mở pinned nếu chưa có) → `navigateNewChat()` (điều hướng "/"
   + chờ content script báo `READY`).
3. Background → content `{channel:'cgw', type:'ASK', prompt}`.
4. Content: gõ prompt → bấm gửi → chờ stop-button hết → poll đọc câu trả lời ổn định →
   lấy `conversation_id` từ URL → trả `{ok, text, conversationId}` về background → popup.
5. Content (fire-and-forget): `GET /api/auth/session` lấy accessToken → forge `PATCH`
   `{is_visible:false}` để **xoá chat**.
6. Background mở khoá hàng đợi cho request kế tiếp.

## 7. Xử lý lỗi & điều kiện biên

- **Chưa đăng nhập**: `/api/auth/session` không có `accessToken` → lỗi `NOT_AUTHENTICATED`.
- **Không thấy composer / nút gửi không bật**: `NO_COMPOSER` / `SEND_DISABLED`.
- **Sinh câu trả lời quá lâu**: vòng chờ stop-button có trần ~120s.
- **Xoá chat thất bại**: log cảnh báo, không chặn kết quả (fire-and-forget).
- **Tab đóng giữa chừng / READY timeout**: request báo lỗi; lần sau tự mở lại tab.
- **Nhiều request cùng lúc**: hàng đợi tuần tự trong background.

## 8. Tiêu chí hoàn thành v1

- Nhập prompt trong popup → nhận đúng text trả lời của ChatGPT. ✅ (verify: "4", "PONG-77")
- Chat được tạo mới mỗi lần và bị xoá sau khi xong. ✅ (verify: PATCH 200)
- Selector, path API, tên field tập trung trong `shared.js`, dễ cập nhật khi OpenAI đổi UI.

## 9. Rủi ro đã biết

- **Phụ thuộc UI ChatGPT** (selector composer/send/stop-button, cấu trúc DOM câu trả lời) —
  OpenAI đổi bất kỳ lúc nào. Đã cô lập vào `SELECTORS` trong `shared.js`.
- **accessToken hết hạn**: lấy tươi mỗi lần xoá qua `/api/auth/session`.
- Gửi tự động qua tài khoản web nằm trong vùng xám điều khoản OpenAI; rủi ro giới hạn/khoá
  nếu tần suất cao. v1 dùng cá nhân, tuần tự.

## 10. Vì sao KHÔNG dùng "forge fetch" cho send (bằng chứng thực tế)

Kiểm thử trên tài khoản thật (Playwright) cho thấy hướng forge fetch bất khả thi:

| Thử nghiệm | Kết quả |
|---|---|
| Patch `window.fetch` để harvest token (10s) | Chỉ bắt **2/nhiều** request → traffic API **bỏ qua `window.fetch`** |
| chat-requirements token | Nằm ở **response body** của `finalize`, **không** ở request header → harvest sai nguồn |
| Forge SEND (thiếu sentinel) | **403** "Unusual activity" — sentinel bắt buộc |
| Forge DELETE (thiếu Bearer) | **401** "Access token is missing" |
| **Gửi qua UI** | ✅ được câu trả lời + `conversation_id` |
| Forge DELETE (+ Bearer) | ✅ **200** |

## 11. (Tham khảo) Giao thức gửi kèm ảnh — cho v2

Upload 3 bước rồi gửi message multimodal:
1. `POST /backend-api/files` `{file_name,file_size,use_case:"multimodal",mime_type,...}`
   → `{upload_url, file_id}`.
2. `PUT <upload_url>` (Content-Type ảnh) body = nhị phân → `201`.
3. `POST /backend-api/files/process_upload_stream` → chờ `file.processing.completed`
   (`extra.metadata_object_id = libfile_...`).
4. Gửi message `content_type:"multimodal_text"`, `parts:[{content_type:"image_asset_pointer",
   asset_pointer:"sediment://file_...",width,height,size_bytes}, "<text>"]`,
   `metadata.attachments:[{id:file_...,mime_type,width,height,source:"local",library_file_id:libfile_...}]`.
   (Bước gửi vẫn cần điều khiển UI như §4.1 — chỉ khác là đính ảnh vào composer trước khi gửi.)
