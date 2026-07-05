# Gemini Web Wrapper Extension — Thiết kế (v1)

**Ngày:** 2026-07-04
**Trạng thái:** Draft chờ review

## 1. Mục tiêu

Xây dựng một extension trình duyệt (Chrome MV3) cho phép gửi một prompt tới Gemini
bằng **tài khoản đã đăng nhập sẵn trên trình duyệt** và nhận lại câu trả lời dạng text —
nhanh, không phải chờ giao diện render.

Đây là **v1 / phần lõi**. Mục tiêu cuối (bọc thành API cho Google Apps Script qua
companion app + tunnel) để giai đoạn sau; v1 chỉ cần chứng minh gửi/nhận hoạt động
qua một popup test.

## 2. Phạm vi v1

**Trong phạm vi:**
- Extension tự mở & quản lý một tab Gemini riêng (dùng phiên đăng nhập sẵn).
- Nhận prompt → mở chat mới → gửi → bắt câu trả lời → xoá chat (chống rác).
- Popup để nhập prompt thử và xem kết quả + trạng thái.

**Ngoài phạm vi (để sau):**
- Companion app + Cloudflare Tunnel + API cho Apps Script.
- Multi-session / giữ ngữ cảnh nhiều cuộc hội thoại (v1 mỗi prompt là chat mới độc lập rồi xoá).
- Gửi kèm ảnh/file, chọn model, streaming từng phần ra ngoài.

## 3. Giao thức Gemini (đã reverse-engineer từ HAR)

### 3.1 Gửi tin nhắn — `StreamGenerate`
```
POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
     ?bl=<build>&f.sid=<session>&hl=<lang>&_reqid=<n>&rt=c
Content-Type: application/x-www-form-urlencoded
body: f.req=<json>&at=<token>
```
`f.req = [null, "<innerJSON>"]`, với innerJSON:
```
[ ["<PROMPT>",0,null,null,null,null,0],
  ["<lang>"],
  ["c_...","r_...","rc_...",null,...,"<ctx>"],   // rỗng "" khi chat mới
  "!<blob>" ]                                      // token chống bot do trang tự sinh
```
> **`!blob` không tái tạo được từ ngoài** → v1 **gửi qua UI** để trang tự sinh token.

### 3.2 Response StreamGenerate
Dạng chunk: `)]}'` rồi lặp lại `<độ dài>\n<dòng JSON>`. Mỗi dòng:
`[["wrb.fr", null, "<innerJSON>"]]`. Trong innerJSON:
- `inner[1] = ["c_<id>", "r_<id>"]` — ID hội thoại (dùng để xoá).
- `inner[4][0][0] = "rc_<id>"` — id lựa chọn trả lời.
- `inner[4][0][1][0]` — **text câu trả lời** (tích lũy dần; lấy bản đầy đủ nhất / cuối cùng).

Promise `response.text()` resolve khi stream đóng → tín hiệu "trả lời xong".

### 3.3 Xoá chat — `GzXR5e` (batchexecute, forge được)
```
POST /_/BardChatUi/data/batchexecute?rpcids=GzXR5e&...
body: f.req=[[["GzXR5e","[\"<c_id>\"]",null,"generic"]]]&at=<token>
```
Response `[["wrb.fr","GzXR5e","[]",...]]` = thành công.
Kèm best-effort `qWymEb` (`["<c_id>",[1,null,0,1]]`) để dọn hoạt động liên quan.

### 3.4 Token cần scrape từ trang
Từ `window.WIZ_global_data` (đọc trong MAIN world):
- `SNlM0e` → `at`
- `cfb2h`  → `bl` (build label)
- `FdrFJe` → `f.sid`

## 4. Kiến trúc

```
Popup ──prompt──► Background (service worker)
                     │  đảm bảo/ mở tab Gemini (pinned), hàng đợi 1-request
                     ▼
                  Content script (isolated world)  ── inject ──► Interceptor (MAIN world)
                     │  bấm New chat, điền prompt, trigger gửi        │ patch fetch/XHR
                     │                                                 │ bắt StreamGenerate
                     ◄──────── kết quả {text, c_id} qua postMessage ───┘ forge xoá chat
```

### 4.1 Các thành phần

| File | Vai trò |
|------|---------|
| `manifest.json` | MV3; host_permissions `https://gemini.google.com/*`; permissions `scripting`, `tabs` |
| `background.js` | Điều phối; quản lý vòng đời tab Gemini; hàng đợi tuần tự (1 request/lần); timeout |
| `content.js` | Inject interceptor; bấm "New chat"; điền prompt + kích hoạt gửi; chuyển tiếp message |
| `interceptor.js` | MAIN world: patch fetch/XHR bắt `StreamGenerate`; đọc token WIZ; forge xoá chat |
| `parser.js` | Thuần hàm: parse chunk response → `{ text, c_id, r_id }`; test độc lập được |
| `selectors.js` | Tập trung mọi CSS selector UI (ô input, nút New chat, nút gửi) để dễ cập nhật |
| `popup.html` / `popup.js` | Nhập prompt, hiển thị trả lời + trạng thái |

## 5. Luồng xử lý một prompt

1. Popup gửi `{type:'ASK', prompt}` cho background.
2. Background: nếu chưa có tab Gemini → mở (pinned) & chờ content script báo `READY`;
   nếu đang bận → xếp hàng.
3. Background gửi `ASK` cho content script của tab.
4. Content script: bấm **New chat** (đảm bảo hội thoại trống) → điền prompt → kích hoạt gửi.
5. Interceptor bắt response `StreamGenerate`, đọc hết body (stream đóng = xong),
   `parser.js` tách `{text, c_id}` → gửi về content script.
6. Content script trả `{text}` về background → popup hiển thị.
7. Interceptor forge `GzXR5e` (+`qWymEb`) với `c_id` để **xoá chat**.
8. Background mở khoá hàng đợi cho request kế tiếp.

## 6. Xử lý lỗi & điều kiện biên

- **Chưa đăng nhập**: trang chuyển hướng login → phát hiện & báo lỗi rõ ràng lên popup.
- **Không bắt được response trong N giây** (mặc định 60s): timeout, báo lỗi; nếu đã có
  `c_id` thì vẫn cố xoá chat.
- **Nút gửi chưa bật** (React chưa nhận input): dispatch chuỗi sự kiện `input`/`beforeinput`,
  thử selector/cách dự phòng; nếu thất bại → báo lỗi.
- **Xoá chat thất bại**: log cảnh báo, không chặn kết quả (rác được dọn ở lần chạy sau nếu cần).
- **Tab bị đóng giữa chừng**: request hiện tại báo lỗi; lần sau tự mở lại tab.
- **Nhiều request cùng lúc**: hàng đợi tuần tự trong background (v1).

## 7. Tiêu chí hoàn thành v1

- Nhập prompt trong popup → nhận đúng text trả lời của Gemini.
- Câu trả lời lấy qua interceptor (không phụ thuộc render DOM).
- Chat được tạo mới mỗi lần và bị xoá sau khi xong (kiểm chứng trong lịch sử Gemini).
- Selector & RPC id tập trung, có thể cập nhật khi Google đổi UI.

## 8. Rủi ro đã biết

- Phụ thuộc UI Gemini (selector) và định dạng response nội bộ (RPC id, đường dẫn field) —
  Google có thể đổi bất kỳ lúc nào. Đã cô lập vào `selectors.js` và `parser.js`.
- Gửi tự động qua tài khoản web nằm trong vùng xám điều khoản Google; có rủi ro giới hạn/khoá
  nếu tần suất cao. v1 dùng cá nhân, tuần tự.
