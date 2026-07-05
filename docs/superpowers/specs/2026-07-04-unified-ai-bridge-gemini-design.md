# Unified AI Bridge — Kiến trúc đa nhà cung cấp + Gemini core (Thiết kế)

**Ngày:** 2026-07-04
**Trạng thái:** Draft chờ review
**Tiền đề:** Gộp v1 ChatGPT đã ship ([ChatGPT design](2026-07-04-chatgpt-web-wrapper-extension-design.md))
thành kiến trúc "driver theo provider" + thêm Gemini. Toàn bộ cơ chế Gemini core đã
**verify sống** trên tài khoản Pro thật (Playwright) — xem §8.

## 1. Mục tiêu

Biến extension thành **cầu nối trung gian (bridge) đa nhà cung cấp**: một contract công khai
ổn định, mỗi AI/công cụ là một **driver** cắm vào. Thêm provider mới về sau (vd "fast AI",
công cụ khác) = **viết 1 file driver + đăng ký 1 dòng**, không sửa lõi.

Lần này làm **lõi**: refactor ChatGPT thành driver, thêm **Gemini driver**, **driver registry**,
và **bộ chọn provider** trong Side Panel. Kênh gọi từ code (`externally_connectable`) và ảnh
**thiết kế sẵn contract/interface nhưng triển khai sau**.

## 2. Nguyên tắc thiết kế (xương sống mở rộng)

1. **Contract ổn định = API công khai.** Mọi caller (Side Panel, code, HTTP sau này) dùng
   đúng một shape, không đổi khi thêm provider.
2. **Driver = điểm mở rộng duy nhất.** Lõi provider-agnostic; kiến thức riêng từng site nằm
   gọn trong driver.
3. **Transport-agnostic.** Hôm nay message nội bộ; mai `externally_connectable`; mốt HTTP
   companion — cùng contract.
4. **Isolation & test được.** Hàm thuần (contract helpers, parser id) test bằng Node; phần
   DOM/site verify bằng Playwright.

## 3. Contract công khai

```jsonc
// request
{
  "type": "ASK",
  "prompt": "string",                 // rỗng chỉ hợp lệ khi có images
  "images": [ { "data": "<dataURL|base64>", "mimeType?": "...", "name?": "..." } ], // v-sau
  "provider": "chatgpt" | "gemini"    // optional; thiếu → provider mặc định
}
// response
{ "ok": true,  "text": "…", "conversationId": "…", "provider": "gemini" }
{ "ok": false, "error": "…", "provider": "gemini" }
```

## 3b. Read-path: NETWORK INTERCEPT (cập nhật quan trọng — đã verify)

> Bản đầu đọc câu trả lời từ **DOM**. Thực tế: **tab chạy nền bị Chrome throttle → trang
> không render → đọc DOM rỗng/kẹt** (Gemini). Đã chuyển sang đọc từ **response mạng** —
> chạy được cả khi tab ẩn, và **bền hơn với đổi UI/ngôn ngữ** (không phụ thuộc selector đọc).

- **SEND**: vẫn UI-drive (gõ + bấm) vì token không forge được. Selector chỉ còn dùng cho
  composer + nút gửi.
- **READ theo từng provider** (`driver.readMode`):
  - **Gemini = `net`**: `interceptor.js` (MAIN world, `document_start`) vá `XMLHttpRequest`
    bắt `StreamGenerate`, forward body thô về content; parse `inner[4][0][1][0]`=answer,
    `inner[1][0]`=`c_id`. ✅ chạy nền.
  - **ChatGPT = `dom`**: traffic `f/conversation` **đi qua service worker, không bắt được ở
    page-world fetch**; nhưng React của ChatGPT **vẫn render khi tab nền** → đọc DOM ổn.
- **interceptor.js** (MAIN world) là bộ bắt "câm": chỉ vá fetch/XHR, forward body thô qua
  `postMessage`; **parse nằm ở isolated world** (`parsers.js`, test Node được).
- Đã bỏ hack "foreground tab" (không cần nữa).

## 4. Interface Driver (điểm cắm)

```js
// Mỗi provider export một object đúng shape này.
Driver = {
  id: "gemini",                        // khớp giá trị contract.provider
  hostMatch: (host) => boolean,        // chọn driver theo location.host
  newChatUrl: "https://gemini.google.com/app",
  capabilities: { images: false },
  readMode: "net" | "dom",             // net = đọc response mạng; dom = đọc DOM
  isLoggedIn: async () => boolean,
  startSend: async (prompt, images) => void,          // UI-drive (gõ + bấm)
  readAnswer: async (ctx) => ({ answer, conversationId }), // ctx.waitForResponse cho net-mode
  deleteConversation: async (conversationId) => void,      // forge, best-effort
}
```

**Registry:** `drivers/index.js` export mảng `[chatgptDriver, geminiDriver]`. `content.js`
chọn driver đầu tiên có `hostMatch(location.host)` true. Thêm provider = thêm file + 1 dòng
vào mảng. `sidepanel` đọc registry (id + capabilities) để render bộ chọn provider.

## 5. Kiến trúc

```
Popup/SidePanel ─(ASK, provider)─► Background (service worker)
   [code sau này] ─externally_connectable─┘   │ chọn provider → đảm bảo tab provider đó
                                              │ queue tuần tự; điều hướng new-chat; READY; timeout
                                              │ persist state vào chrome.storage
                                              ▼
                               Content script (isolated world)
                                 host → chọn driver → driver.send()/deleteConversation()
                                 ◄── {ok,text,conversationId,provider} ──►
```

Background **provider-aware**: giữ tab riêng cho mỗi provider (tra bằng `driver.hostMatch`),
route request tới đúng tab. Còn lại (queue, state, timeout) provider-agnostic — dùng lại nguyên
từ ChatGPT v1.

## 6. Thành phần

| File | Vai trò |
|------|---------|
| `shared.js` | Contract helpers (validate), `parseImageData` (v-sau), tiện ích thuần — test Node |
| `drivers/index.js` | Registry: mảng driver + `pickDriver(host)` |
| `drivers/chatgpt.js` | Driver ChatGPT: send UI-drive, delete forge PATCH + Bearer (`/api/auth/session`) |
| `drivers/gemini.js` | Driver Gemini: send UI-drive, delete forge batchexecute `GzXR5e` + `at` (scrape HTML) |
| `content.js` | Chọn driver theo host; nhận ASK → gọi driver; bridge message; báo READY |
| `background.js` | Điều phối provider-aware: tab theo provider, queue, new-chat nav, timeout, persist state |
| `queue.js` | Hàng đợi tuần tự (giữ nguyên) |
| `sidepanel.html`/`sidepanel.js` | Bộ chọn provider (từ registry) + prompt + trả lời + trạng thái + "Mới"; render từ storage |
| `manifest.json` | host_permissions cả `chatgpt.com` + `gemini.google.com`; content_scripts match cả hai; permissions `tabs`,`scripting`,`storage`,`sidePanel` |

## 7. Gemini driver — chi tiết (đã verify §8)

- **Tokens (isolated world, KHÔNG cần MAIN world):** regex từ `document.documentElement.outerHTML`:
  `"SNlM0e":"<at>"`, `"cfb2h":"<bl>"`, `"FdrFJe":"<fsid>"`.
- **Send (UI-drive):** `#… .ql-editor` (contenteditable) → `document.execCommand("insertText", …)`
  → bấm `button[aria-label="Send message"]`.
- **Đọc trả lời:** node cuối `.model-response-text`; hoàn tất khi `button[aria-label*="Stop"]`
  biến mất; poll tới khi text non-empty & ổn định (3 lần đọc giống nhau).
- **conversationId:** từ URL `/app/<id>`.
- **Xoá (forge):** `POST /_/BardChatUi/data/batchexecute?rpcids=GzXR5e&bl=<bl>&f.sid=<fsid>&_reqid=<n>&rt=c`
  body `f.req=[[["GzXR5e","[\"c_<id>\"]",null,"generic"]]]&at=<at>` → `[["wrb.fr","GzXR5e","[]"…]]` = OK.

**Khác ChatGPT:** xoá bằng batchexecute+`at` (không Bearer); token scrape HTML (không
`/api/auth/session`). **Giống:** send UI-drive, đọc DOM, Side Panel + persist + serial queue.

## 8. Bằng chứng verify (Playwright, tài khoản Pro thật — 2026-07-04)

| Test | Kết quả |
|---|---|
| Đăng nhập Gemini (Google cookies) | ✅ có `at`/`bl`/`f.sid` |
| Token scrape từ HTML | ✅ cả 3 |
| Send UI-drive (`.ql-editor` + "Send message") | ✅ trả lời "GEM-1", URL `/app/0443c4404c0e00c0` |
| Đọc DOM `.model-response-text` + stop-button | ✅ |
| Xoá forge `GzXR5e` + `at` | ✅ 200 `[["wrb.fr","GzXR5e","[]"…]]`, chat biến mất |

## 9. Luồng xử lý một prompt

1. Side Panel gửi `{type:"ASK-FROM-PANEL", prompt, provider}` cho background (mặc định provider
   nếu thiếu).
2. Background: chọn driver theo provider → đảm bảo tab provider (mở pinned nếu chưa) →
   điều hướng new-chat + chờ content `READY`.
3. Background → content `{channel:"cgw", type:"ASK", prompt}`.
4. Content: `pickDriver(location.host)` → `driver.send(prompt)` (UI-drive, đọc DOM) → trả
   `{ok,text,conversationId,provider}`; rồi `driver.deleteConversation(conversationId)` (best-effort).
5. Background persist `{status,prompt,text,error,provider}` vào storage → panel render.

## 10. Xử lý lỗi & điều kiện biên

- Chưa đăng nhập (`isLoggedIn()` false) → `NOT_AUTHENTICATED`.
- Không thấy composer / nút gửi → `NO_COMPOSER` / `SEND_DISABLED`.
- Trả lời quá lâu → timeout (trần ~120s), vẫn cố xoá nếu đã có id.
- Xoá thất bại → cảnh báo, không chặn kết quả.
- Provider không có driver / tab đóng giữa chừng → lỗi rõ ràng; lần sau mở lại tab.
- Nhiều request → hàng đợi tuần tự.

## 11. Tiêu chí hoàn thành (core lần này)

- Chọn "Gemini" trong Side Panel → gửi prompt → nhận trả lời đúng; chat bị xoá. (verify Playwright)
- Chọn "ChatGPT" → vẫn chạy như cũ (không hồi quy).
- Thêm driver mới chỉ cần 1 file + 1 dòng registry (được phản ánh trong cấu trúc code).
- Hàm thuần (contract validate, pick driver) có unit test.

## 12. Ngoài phạm vi (làm sau, contract đã sẵn)

- Kênh `externally_connectable` (gọi từ code) + `onMessageExternal`.
- Gửi ảnh (paste vào composer; ChatGPT đã spike, Gemini để sau).
- HTTP companion + tunnel cho caller ngoài trình duyệt (Apps Script…).
- Chọn model, giữ ngữ cảnh nhiều lượt, streaming ra ngoài.

## 13. Rủi ro đã biết

- Phụ thuộc UI/RPC nội bộ mỗi site (selector, rpcid, field path) — nhà cung cấp đổi bất kỳ lúc
  nào. Cô lập trong từng driver.
- Token cào từ HTML/`/api/auth/session` có thể đổi khoá/định dạng — cô lập trong driver.
- Tự động qua tài khoản web nằm vùng xám điều khoản — dùng cá nhân, tuần tự.
- `cookies.json` / `google_cookíe.json` / `*.har` chứa token còn sống — đã gitignore; scrub
  lịch sử trước khi push.
