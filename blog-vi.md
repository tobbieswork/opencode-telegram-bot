# Đưa một AI coding agent vào Telegram — và những cú bug dạy tôi làm applied AI

## Tại sao lại làm cái này?

**OpenCode** là một AI coding agent chạy local khá "đỉnh": nó đọc được cả codebase, tự sửa code, chạy lệnh, tự gọi tool. Nhưng nó sống trong terminal. Còn tôi thì 80% thời gian ở trên điện thoại. Câu hỏi rất thực tế: **làm sao gọi được một coding agent mạnh ngay từ một tin nhắn, không cần bật laptop?**

Tôi viết một bản *bridge* nhỏ bằng Node.js. Kết quả là một con bot Telegram: bạn nhắn gì, nó đưa vào OpenCode như một prompt, rồi trả kết quả — code, bảng, thậm chí *tự quay lại hỏi bạn* — ngay trong khung chat. Toàn bộ chạy local, không qua cloud.

## Kiến trúc — nhỏ tới mức buồn cười

Không framework, chỉ vài file:

- **Bên Telegram:** long-polling `getUpdates` — không cần public IP.
- **Bên OpenCode:** HTTP client + stream event (SSE).
- **Điểm nối:** mỗi chat gắn với một session OpenCode, lưu trong một file nhỏ → cuộc trò chuyện giữ được ngữ cảnh.
- **Relay câu hỏi:** khi agent muốn hỏi lại (tool `question`), OpenCode phát ra một "form" đang chờ; bot nhận event, render thành **nút bấm** trên Telegram, và câu trả lời của bạn được đưa ngược vào session.

## Bốn bug "đau" nhất (phần hay nhất)

Agent càng mạnh, **chiếc glue code** quanh nó càng là nơi vỡ. Đây là 4 cú ngã giá nhất:

### 1. Nhắn câu mới, nhận câu trả lời của lượt trước

Triệu chứng: tôi nhắn một việc, bot trả lời đúng chủ đề… nhưng đó là câu trả lời của lượt **trước đó**.

Nguyên nhân: tôi đọc kết quả qua API `message.list` — API này **phân trang, mặc định trả 50 tin gần nhất, sắp "mới ở đầu"**. Code cũ cứ gán `reply = text` lặp qua hết, nên rốt cuộc giữ lại tin **cũ nhất** trong trang. Session càng dài, càng hay ra câu cũ.

Cách sửa — chỉ nhận tin *mới* tạo ra sau khi gửi prompt:

```ts
// chụp danh sách ID đã tồn tại TRƯỚC khi gửi prompt
const before = new Set((await listMessages(sid, 200)).map(m => m.id));
// ... gửi prompt, chờ session về idle ...
// chỉ lấy tin assistant MỚI tạo, và lấy cái mới nhất
const fresh = (await listMessages(sid, 200))
  .filter(m => m.id && !before.has(m.id));
```

Bài học: **"mục cuối" ≠ "mới nhất"** khi API trả về theo kiểu newest-first.

### 2. Dòng trạng thái hiện y nguyên chữ `<i>`

Footer nhỏ `succeeded · 2.3s` (định dạng *in nghiêng*) bị **escape hai lần**: `<i>` thành `&lt;i&gt;`, rồi gửi ở chế độ HTML nên hiện ra đúng `<i>…</i>`. Sửa: chỉ escape phần text động, giữ nguyên tag HTML thật.

### 3. Tự restart bot giữa lượt → mất luôn câu trả lời

Đang sửa code trong phiên do *chính bot* điều khiển, tôi **kill process bot** — tức là kill luôn đứa đang chờ để gửi trả lời. Kill xong, mất luôn bước gửi: tin nhắn đã được sinh ra trong OpenCode nhưng **không còn ai đưa lên Telegram**.

Bài học: **đừng tự restart một service từ chính request của nó.** (Về sau tôi định thêm cơ chế "phục hồi" — nhớ tin đã gửi, tự gửi lại nếu bị gián đoạn giữa chừng.)

### 4. Chia trang Markdown dài mà không gãy tag

Reply dài bị cắt thành nhiều tin Telegram (giới hạn 4096 ký tự). Cắt trúng giữa một tag → Telegram reject cả tin (lỗi 400 "can't parse entities"). Cách làm: một converter Markdown→HTML chỉ phát ra tag Telegram hỗ trợ, và **luôn giữ tag "cân bằng" trong từng message** (tách theo code block / dòng / từ).

## Bài học cho người làm applied AI

- Agent mạnh không đảm bảo hệ thống ổn — **layer nối** mới quyết định trải nghiệm.
- Đọc kỹ **thứ tự + phân trang** của mọi API bạn lấy kết quả từ nó.
- Thiết kế cho **headless**: agent phải có cách *hỏi lại* người dùng, không thì nó treo chờ câu trả lời.
- Tự động hóa rất tiện, nhưng phải có **cơ chế phục hồi** khi bị gián đoạn giữa chừng.

## Muốn tự làm?

Bạn cần: 1 token bot Telegram, 1 instance OpenCode, và khoảng vài trăm dòng Node.js để nối. Tôi đã mở rộng thêm lệnh `/browse` (chọn thư mục project), `/model` (đổi model), `/ls` (xem các session cũ).

_(Source là một repo Node.js nhỏ; nếu bạn muốn mình gửi link.)_
