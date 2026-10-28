# 🤖 OpenCode Telegram Bot — Hướng dẫn sử dụng

Gửi tin nhắn cho bot — bot chạy bằng OpenCode và trả kết quả. Gõ `/` để hiện menu lệnh bất kỳ lúc nào, hoặc `/help` để xem danh sách + nút bấm.

---

## 1. Cách hoạt động

- **Manager** = chat chính (General). Bạn nói chuyện với manager: nó tự trả lời, hoặc giao việc cho worker.
- **Worker** = mỗi task được tách thành **topic riêng** + session riêng (không lẫn vào ngữ cảnh manager).
- **Streaming:** trả lời hiện dần theo thời gian thực. Khi bắt đầu xử lý ở General, bot gửi tin **⏳ Đang xử lý…** (tự xoá khi có kết quả).
- **Khi cần bạn quyết định:** bot gửi **nút chọn** (câu hỏi) hoặc **thẻ permission** (xin quyền công cụ) ngay trong topic — bấm nút là trả lời, không cần terminal.
- **Khi worker xong:** report hiện trong topic của worker, bot gắn 🎉; manager được thông báo tự động.

## 2. Tương tác cơ bản

| Hành động | Cách |
|---|---|
| Giao việc | Gõ thẳng nội dung task vào chat manager |
| Tách worker cho 1 tin cụ thể | Bấm **🔥** vào **tin của bot** (báo cáo, kết quả…) — manager sẽ soạn task + spawn worker (cần `/manager on`) |
| Duyệt + dọn worker | Bấm **👍** vào báo cáo DONE của worker → xoá topic + session (branch git chưa merge vẫn giữ) |
| Bác bỏ | Bấm **👎** vào báo cáo DONE → gửi lại manager để xử lý tiếp |
| Dừng task đang chạy | `/stop` (trong topic đang chạy) |
| Agent đang bận | Bot trả lời ngay "⏳ đang xử lý tin trước" + nút **📝 Thêm vào note** (1 tap), hoặc gõ `/note <ghi chú>` — manager đọc ghi chú khi bạn nhắn tin kế tiếp. Muốn cắt ngang: `/stop` |

> ⚠️ **🔥 vào tin của chính bạn** sẽ không spawn (tin đó đã được xử lý) — bot trả lời "đã nhận rồi, không spawn trùng".
> 🎉 do **bot** gắn vào báo cáo DONE — không phải hành động của bạn.

## 3. Quản lý worker

| Lệnh | Ý nghĩa |
|---|---|
| `/spawn <tên> [dir]` | Tạo worker: topic + session riêng |
| `/board` (alias `/workers`) | Trạng thái mọi worker |
| `/kill <tên>` | Dừng 1 worker |
| `/stopall` | Dừng mọi worker |
| `/manager on\|off` | Bật/tắt: manager nhận việc ở chat chính và giao cho worker |
| `/auto on\|off` | Manager tự giao việc, hay chờ bạn duyệt trước |
| `/wt` | Worktree: diff / merge / xoá (chạy **trong topic worker**) |
| `/prune [số_ngày]` | Dọn topic worker đã xong, im ≥ số ngày (mặc định 7). Worker đang chạy/idle **không** bị dọn |

Report của worker được chuyển tự động về manager khi xong — không cần bạn can thiệp.

## 4. Phiên & context

| Lệnh | Ý nghĩa |
|---|---|
| `/new` | Phiên mới — bỏ toàn bộ ngữ cảnh cũ |
| `/new --keep` | Phiên mới **+** kế thừa: bot tóm tắt quyết định/việc đang dở của phiên cũ và nạp vào phiên mới |
| `/ls` (alias `/sessions`) | Liệt kê phiên gần đây |
| `/use <id>` | Chuyển sang một phiên |
| `/context` (alias `/ctx`) | Ảnh chụp phiên hiện tại (usage + files) |
| `/usage` | Mức dùng context theo phiên + cảnh báo khi gần tràn |
| `/history` | Xem tin nhắn gần đây |
| `/clear` | Xoá state của chat này |

## 5. Mode & model

| Lệnh | Ý nghĩa |
|---|---|
| `/mode` | Chọn mode: **build / plan / general / explore** |
| `/models` · `/model <id>` | Liệt kê / đặt model cho phiên |
| `/agents` · `/agent <id>` | Liệt kê / đặt agent (build, general, explore, plan) |
| `/variants [tên]` · `/variant <tên>` | Xem/đặt reasoning variant (vd `xhigh`) |

## 6. Thư mục làm việc

| Lệnh | Ý nghĩa |
|---|---|
| `/dir [path]` | Xem/đặt thư mục làm việc hiện tại |
| `/browse [path]` (alias `/b`) | Duyệt thư mục bằng nút bấm — an toàn hơn gõ đường dẫn tay |

## 7. ⏰ `/schedule` — chạy prompt tự động theo lịch

Đặt lịch để bot **tự chạy một prompt** (đọc/phân tích + báo cáo về chat) trong **worker riêng** (topic `sch-<id>`), không cần ai bấm.

### Cú pháp

```
/schedule <spec> <prompt> [dir=<đường dẫn> agent=<tên>]
```

### 5 loại spec

| spec | Ví dụ | Ý nghĩa |
|---|---|---|
| `daily HH:MM` | `/schedule daily 08:00 Review commit 24h qua` | Mỗi ngày lúc 08:00 |
| `weekdays HH:MM` | `/schedule weekdays 08:00 ...` | Thứ 2–6 lúc 08:00 |
| `weekly <thứ> HH:MM` | `/schedule weekly fri 17:00 ...` | Mỗi tuần (thứ tiếng Anh: mon/tue/wed/thu/fri/sat/sun, hoặc viết đầy đủ) |
| `every <N>h` | `/schedule every 6h Kiểm tra CI` | Mỗi N giờ (1–168) — chạy theo mốc giờ cố định (vd 6h → 00/06/12/18) |
| `once YYYY-MM-DD HH:MM` | `/schedule once 2026-12-01 09:00 Nhắc việc X` | Chạy 1 lần, phải là mốc tương lai; quá giờ > 60 phút thì bỏ qua |

### Token tuỳ chọn

- **`dir=<đường dẫn>`** — thư mục worker chạy. Bỏ trống = dùng thư mục của chat hiện tại; ở chat chính đó là thư mục của Manager nên **bị chặn** (lỗi kèm gợi ý) — muốn đặt lịch từ chat chính thì phải ghi `dir=` trỏ ra ngoài `data/manager`.
- **`agent=<tên>`** — mặc định `build` (cho phép: build, general, explore, plan).

### Quản lý lịch

| Lệnh / nút | Ý nghĩa |
|---|---|
| `/schedule` | Liệt kê lịch của chat + nút điều khiển từng lịch |
| `/schedule help` | Hiện lại hướng dẫn này |
| `/schedule pause <id>` / `resume <id>` | Tạm dừng / bật lại |
| `/schedule run <id>` | Chạy ngay bây giờ |
| `/schedule rm <id>` (alias `del`, `delete`) | Xoá lịch |
| Nút **⏸ / ▶** | Tạm dừng / bật lại |
| Nút **▶▶** | Chạy ngay |
| Nút **🗑** | Xoá — 2 bước xác nhận |

### Điều cần biết

- **Thời gian** theo **giới giờ của máy bot** (Asia/Ho_Chi_Minh).
- **An toàn (v1):** lịch chỉ chạy đọc/phân tích + báo cáo. Thẻ permission của worker **vẫn gửi cho bạn** — không tự approve.
- **Trạng thái** mỗi lần chạy hiện trong danh sách: `ok` · `skipped-busy` (worker đang bận) · `skipped-late` (quá trễ) · `timeout` · `error`.
- **`rm`** xoá lịch nhưng **giữ topic + lịch sử** — dọn topic mồ côi bằng `/prune` hoặc 👍.
- Lịch lưu **độc lập** với `/clear` — xoá state chat không làm mất lịch.

## 8. Bảng tra nhanh

**📁 Phiên & thư mục**
`/new` · `/new --keep` · `/ls` · `/use <id>` · `/dir [path]` · `/browse [path]`

**🎛 Mode & model**
`/mode` · `/models` · `/model <id>` · `/agents` · `/agent <id>` · `/variants` · `/variant <tên>`

**🧩 Worker (Manager)**
`/spawn <tên> [dir]` · `/board` · `/kill <tên>` · `/stopall` · `/manager on|off` · `/auto on|off` · `/wt` · `/prune [số_ngày]`

**⚙️ Điều khiển**
`/stop` · `/note [ghi chú]` · `/context` · `/usage` · `/history` · `/status` · `/reboot` · `/clear` · `/schedule` · `/help`

**💡 Mẹo**
- Gõ `/` để hiện menu · khi bot cần hỏi, chọn đáp án bằng **nút** hoặc tự gõ.
- 🔥 vào tin của bot để tách worker · 👍/👎 vào báo cáo DONE để duyệt/bác.
- `/status` — trạng thái kết nối · `/reboot` — reboot máy (2 bước xác nhận).
