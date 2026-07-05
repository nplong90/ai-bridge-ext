# ChatGPT Web Wrapper v2 — Ảnh + Relay gọi từ code (Thiết kế)

**Ngày:** 2026-07-04
**Trạng thái:** Draft chờ review
**Tiền đề:** Xây trên v1 đã verify ([v1 design](2026-07-04-chatgpt-web-wrapper-extension-design.md)).
Cơ chế attach ảnh đã spike thực tế trên tài khoản thật (paste ClipboardEvent) — model đọc
được đúng nội dung ảnh đã upload.

## 1. Mục tiêu

- Gửi **prompt kèm ảnh** (một hoặc nhiều) tới ChatGPT qua phiên đăng nhập sẵn.
- Thiết kế thành **trạm chung chuyển gọi được từ code**: một contract thống nhất nhận
  **base64 / data URL**, dùng chung cho UI, code trong trình duyệt, và (sau này) HTTP companion.

## 2. Phạm vi v2

**Trong phạm vi:**
- Contract request thống nhất (text + images base64) — §3.
- Kênh **`externally_connectable`**: code chạy trong trình duyệt (trang whitelist) gọi trực tiếp.
- Side Panel UI: đính ảnh bằng **chọn file / dán / kéo-thả**, **nhiều ảnh**, có preview + xoá.
- Gửi multimodal qua **điều khiển UI** (paste ảnh vào composer) → đọc trả lời → xoá chat.

**Ngoài phạm vi (v3+):**
- HTTP companion + tunnel (cho caller NGOÀI trình duyệt như Google Apps Script). Contract v2
  thiết kế sẵn để v3 bọc lại, không phải sửa lõi.
- Giữ ngữ cảnh nhiều lượt / lịch sử nhiều câu hỏi; chọn model; streaming từng phần ra ngoài.

## 3. Contract request (lõi của "trạm chung chuyển")

Transport-agnostic — mọi kênh (UI / code / HTTP sau này) đều dùng đúng shape này:

```jsonc
// request
{
  "type": "ASK",
  "prompt": "string",                     // có thể rỗng nếu có images
  "images": [                             // optional
    { "data": "data:image/png;base64,…",  // data URL HOẶC base64 thô
      "mimeType": "image/png",            // optional nếu data là data URL
      "name": "photo.png" }               // optional
  ]
}
// response
{ "ok": true,  "text": "…", "conversationId": "…" }
{ "ok": false, "error": "…" }
```

Ràng buộc: `prompt` rỗng **chỉ** hợp lệ khi `images` không rỗng. `images` tối đa `MAX_IMAGES`
(mặc định 8). Vượt → lỗi rõ ràng.

## 4. Kênh & luồng

```
[Side Panel UI] ─ chrome.runtime.sendMessage ─┐
[Code trong browser] ─ sendMessage(EXT_ID,…) ─┤ (onMessageExternal)
                                              ▼
                              Background: validate → ask(prompt, images)
                                              │ queue tuần tự; điều hướng new-chat; READY
                                              ▼
                              Content script: paste ảnh → gõ text → chờ upload xong
                                              → bấm gửi → đọc trả lời ổn định → forge xoá
```

**`externally_connectable`** (manifest): mặc định `["*://localhost/*", "*://127.0.0.1/*"]`.
Người dùng tự thêm origin của mình. **Cảnh báo bảo mật:** bất kỳ trang nào thuộc origin đã
whitelist đều có thể gửi prompt bằng phiên ChatGPT của bạn → chỉ whitelist origin tin cậy.

## 5. Cơ chế đính ảnh (đã verify)

1. Content nhận `images[]` (base64/dataURL).
2. Với mỗi ảnh: `parseImageData` → `{bytes, mime, name}` → dựng `File`.
3. Gom tất cả File vào **một `DataTransfer`** → dispatch `ClipboardEvent("paste", {clipboardData})`
   lên `#prompt-textarea`. (Đã spike: ChatGPT hiện thumbnail `blob:` và upload thật.)
4. Gõ prompt bằng `execCommand("insertText")` (nếu có).
5. **Chờ nút gửi bật lại** = ảnh upload xong (timeout dài hơn khi có ảnh, mặc định 90s).
6. Bấm gửi → chờ `stop-button` biến mất → poll đọc câu trả lời ổn định → lấy `conversation_id`.
7. Forge `PATCH is_visible:false` (Bearer) để xoá chat.

> Vì sao không upload ảnh qua API rồi forge send: bước `POST /backend-api/files` + `PUT raw`
> forge được (có Bearer), nhưng **bước gửi message vẫn là `f/conversation` bị sentinel chặn**
> → vẫn phải gửi qua UI. Do đó đính ảnh qua UI (paste) là đường đơn giản & chắc chắn nhất.

## 6. Thành phần

| File | Thay đổi |
|------|----------|
| `shared.js` | + `parseImageData(data, {mimeType,name})` → `{bytes, mime, name}` (thuần, test Node được); + `MAX_IMAGES=8` |
| `content.js` | `driveSend(prompt, images)`: paste File ảnh → chờ upload → gửi; enable-timeout dài hơn khi có ảnh |
| `background.js` | `ask(prompt, images)`; `onMessageExternal` (validate contract, trả `{ok,…}`); state lưu thêm `imageCount` (KHÔNG lưu base64) |
| `manifest.json` | + `externally_connectable.matches` (localhost mặc định) |
| `sidepanel.html`/`sidepanel.js` | Nút đính kèm + paste + kéo-thả; **dải thumbnail nhiều ảnh có nút ×**; đọc file → dataURL → contract |

`queue.js` giữ nguyên. Không thêm permission (ảnh nằm trong bộ nhớ, không cần `downloads`/`clipboard`).

## 7. `parseImageData` — hành vi (đơn vị test được)

- Input là data URL `data:<mime>;base64,<b64>` → tách `mime` + giải mã `<b64>` → `bytes` (Uint8Array),
  `name` = opts.name || `image.<ext(mime)>`.
- Input là base64 thô → `mime` = opts.mimeType || `image/png`; giải mã → `bytes`.
- base64 sai định dạng → ném lỗi `BAD_IMAGE_DATA`.
- Dùng `atob` + `Uint8Array` (có sẵn ở Node ≥16 và trong extension). Dựng `File` để ở content.js
  (browser-only), không nằm trong hàm thuần.

## 8. Side Panel UI

- **Nút đính kèm** (📎): `input[type=file][accept=image/*][multiple]` → đọc mỗi file bằng
  `FileReader.readAsDataURL` → thêm vào danh sách ảnh.
- **Paste**: nghe `paste` trên panel; nếu clipboard có ảnh → thêm.
- **Kéo-thả**: vùng thả (toàn panel); `dragover`/`drop` → đọc file ảnh.
- **Dải thumbnail**: hiện các ảnh đã chọn, mỗi ảnh có nút **×** để bỏ; đếm số ảnh.
- Khi gửi: đóng gói `{prompt, images:[{data:dataURL, name, mimeType}]}` gửi background.
- Trạng thái khôi phục: panel vẫn khôi phục prompt + câu trả lời + `imageCount` từ storage
  (không khôi phục lại chính ảnh — ảnh chỉ sống trong lần soạn).

## 9. Xử lý lỗi & điều kiện biên

- `images` vượt `MAX_IMAGES` → lỗi `TOO_MANY_IMAGES`.
- `prompt` rỗng và không có ảnh → `EMPTY_REQUEST`.
- Ảnh không upload xong trong timeout → `UPLOAD_TIMEOUT` (vẫn cố xoá chat nếu đã có id).
- `parseImageData` lỗi → `BAD_IMAGE_DATA`.
- Gọi external từ origin ngoài whitelist → Chrome chặn ở tầng nền tảng (tài liệu hoá).
- Còn lại kế thừa v1: chưa đăng nhập, NO_COMPOSER, timeout stream, xoá best-effort, hàng đợi tuần tự.

## 10. Tiêu chí hoàn thành v2

- Gửi 1 ảnh + text từ Side Panel → nhận trả lời đúng; chat bị xoá. (verify Playwright)
- Gửi **nhiều ảnh** cùng lúc → OK.
- Gọi từ code trong browser: `chrome.runtime.sendMessage(EXT_ID, {type:"ASK", prompt, images:[{data:base64}]})`
  → `{ok:true, text}`. (verify Playwright)
- `parseImageData` có unit test (dataURL + base64 thô + lỗi).

## 11. Dùng từ code (ví dụ)

```js
// Trang web thuộc origin đã whitelist trong externally_connectable
const EXT_ID = "akilipcdhadhdifaganehalkgbdhfafb"; // id extension
chrome.runtime.sendMessage(EXT_ID, {
  type: "ASK",
  prompt: "Mô tả ảnh này",
  images: [{ data: "data:image/png;base64,iVBORw0KGgo…", name: "a.png" }],
}, (resp) => {
  if (resp.ok) console.log(resp.text); else console.error(resp.error);
});
```
