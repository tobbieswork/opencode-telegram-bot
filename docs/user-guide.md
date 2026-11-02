# 🤖 OpenCode Telegram Bot — Hướng dẫn sử dụng

Bot này điều khiển [OpenCode](https://opencode.ai) chạy trên máy của bạn, qua Telegram:
gõ một tin nhắn, OpenCode thực thi, bot gửi kết quả về. Gõ `/` để hiện menu lệnh bất
kỳ lúc nào, hoặc `/help` để xem danh sách lệnh + nút bấm.

---

## 1. Bắt đầu

- Mở bot (hoặc nhóm có bot) và gửi `/help` — bot trả về thẻ hướng dẫn + lưới nút bấm.
- **Chat chính (General)** là nơi bạn nói chuyện với **Manager** — nó tự trả lời,
  hoặc chia việc cho các **worker**.
- Mỗi **topic** trong nhóm là một cuộc hội thoại độc lập: session riêng, thư mục
  riêng, `/stop` riêng. Nhiều agent làm việc song song.
- Gửi một tin nhắn thường = một prompt. Khi xong, bot gửi kết quả kèm dòng
  `kết quả · thời gian` (vd `succeeded · 42.3s`).
- Bot trả lời bằng **ngôn ngữ bạn dùng** (Việt thì Việt, Anh thì Anh).

## 2. Cách bot phản hồi

| Tình huống | Bạn thấy gì |
|---|---|
| Đang xử lý | Trả lời **hiện dần** (streaming); ở đầu General bot gửi tin **⏳ Đang xử lý…** (tự xoá khi xong) |
| Agent cần bạn quyết định | Thẻ **câu hỏi** với nút chọn (hoặc gõ tự do) — mỗi lần một câu |
| Tool cần quyền | Thẻ **permission**: `✅ Duyệt 1 lần` / `♾️ Duyệt luôn` / `❌ Từ chối` |
| Kết thúc ở chế độ plan | Nút `🔨 Sang build & thực thi` — 1 chạm để chuyển sang build và chạy kế hoạch |
| Một lượt chạy **thất bại** | Lỗi thật (thường là context tràn) + nút `⏯ Chạy tiếp` (nếu có thể) |
| Câu hỏi/quyền chưa trả lời | Bot **nhắc lại** trên chính thẻ đó (dòng `⏰ Nhắc (n/4)`), tối đa 4 lần — hoặc gõ `/stop` để bỏ |
| Worker xong | Bot gắn 🎉 vào báo cáo và tự chuyển báo cáo về Manager |

## 3. Tương tác bằng reaction

| Reaction | Vào đâu | Kết quả |
|---|---|---|
| 🔥 | **Tin của bot** (báo cáo, kết quả, nghiên cứu) | Manager đọc ngữ cảnh, **soạn task + spawn worker** (cần `/manager on`) |
| 👍 | **Báo cáo DONE** của worker | Duyệt: xoá topic + session + worktree (nhánh git **chưa merge vẫn giữ**) |
| 👎 | **Báo cáo DONE** của worker | Bác: gửi lại Manager để xử lý tiếp |

> ⚠️ 🔥 vào **tin của chính bạn** không spawn (tin đó đã được xử lý rồi) — bot
> trả lời "đã nhận rồi, không spawn trùng".

## 4. Session & thư mục

| Lệnh | Ý nghĩa |
|---|---|
| `/new` | Thẻ 3 nút (xem bên dưới) |
| `/ls` | Liệt kê 15 phiên gần đây (phiên hiện tại đánh dấu ▶️) |
| `/use [id]` | Chuyển sang một phiên — không gõ id: hiện nút chọn 10 phiên mới nhất |
| `/dir [path]` | Xem / đặt thư mục làm việc của chat này |
| `/browse [path]` (alias `/b`) | Duyệt thư mục bằng nút bấm — an toàn hơn gõ đường dẫn tay |

### `/new` — thẻ 3 nút

`/new` là lệnh phá huỷ ngữ cảnh, nên bot luôn cho chọn (không tự xoá):

| Nút | Làm gì |
|---|---|
| `🗑️ Clear` | Phiên mới hoàn toàn — bỏ toàn bộ ngữ cảnh cũ |
| `💾 Clear + giữ ngữ cảnh` | Phiên mới **+ kế thừa**: bot tóm tắt quyết định/việc đang dở của phiên cũ (≤ ~4000 ký tự) và nạp vào phiên mới |
| `↩️ Huỷ` | Giữ nguyên phiên hiện tại |

> Tip: phiên đang dài (xem `/usage`) → dùng **Clear + giữ ngữ cảnh** để vừa sạch
> context vừa không mất mạch.

## 5. Mode & model

| Lệnh | Ý nghĩa |
|---|---|
| `/mode [tên]` | Chọn mode: **build** (mặc định, viết/sửa code) · **plan** (chỉ phân tích & lên kế hoạch) · **general** (đa dụng, chạy song song) · **explore** (duyệt codebase nhanh). Không gõ tên: hiện nút chọn |
| `/models` · `/model [id]` | Liệt kê / đặt model (chấp nhận cả `provider/id`). Không gõ id: hiện nút chọn |
| `/agents` · `/agent <id>` | Liệt kê / đặt agent |
| `/variants [tên]` · `/variant <tên>` | Xem / đặt reasoning variant (mặc định `xhigh`) |

Chưa có session thì mode/model **áp dụng khi tạo phiên** (sau `/new` hoặc tin
nhắn kế tiếp).

## 6. Worker (Manager)

| Lệnh | Ý nghĩa |
|---|---|
| `/spawn <tên> [dir]` | Tạo worker: topic + session riêng (vd `/spawn api-fix ~/Code/app`) |
| `/board` (alias `/workers`) | Trạng thái mọi worker + trạng thái manager/auto |
| `/kill [tên]` | Dừng một worker — không gõ tên: nút chọn (trong topic worker: không cần tên) |
| `/stopall` | Dừng mọi worker đang chạy |
| `/manager on\|off` | Bật/tắt Manager ở chat chính. Tắt: General quay về session bình thường, worker giữ nguyên |
| `/auto on\|off` | Manager **tự giao việc** (on), hay chờ bạn duyệt bằng thẻ `✅ Giao` / `❌ Huỷ` / `⚡ Giao + bật auto` (off) |
| `/wt` | Trong topic worker có git worktree: `📄 Diff` / `🔀 Merge` / `🗑 Xoá worktree` |
| `/prune [số_ngày]` | Dọn topic worker đã xong, im ≥ N ngày (mặc định 7) — ở chat chính, xác nhận bằng nút |

**Trạng thái topic worker** (cũng hiện trong `/board`):
💤 idle · 🟢 đang chạy · 🟡 chờ bạn · ✅ xong · ❌ lỗi · ⏹ đã dừng.
Topic xong/lỗi được **tự đóng** để nhóm không bị lấp — nhắn vào là tự mở lại.

**Song song trên 1 repo:** worker cần ghi chung checkout với worker khác đang bận
tự nhận **git worktree + branch riêng** (`tg/<tên>`); xong việc dùng `/wt` để
diff/merge. Merge chỉ chạy khi nhánh gốc sạch.

**Worker bị tràn context** (thất bại do context overflow) tự được **respawn**
trong worktree cũ dưới tên mới, làm tiếp và tự báo cáo.

Report của worker chuyển tự động về Manager khi xong — không cần bạn can thiệp.
Xin quyền / câu hỏi của worker **luôn gửi cho bạn** trong topic của worker —
Manager không tự trả lời thay.

## 7. Context, rotation & theo dõi

| Lệnh | Ý nghĩa |
|---|---|
| `/context` (alias `/ctx`) | "Ảnh chụp" phiên hiện tại: id, model/agent, tokens, cost, số tin, files đã sửa, prompt gần nhất |
| `/usage [--all]` | Mức dùng context của **mọi** session bot đang theo dõi (manager, worker, chat thường), sắp theo áp lực; phiên ≥ 80% cửa sổ có dấu cảnh báo |
| `/rotation` | Sức khoẻ **xoay phiên Manager**: nền context hiện tại, xu hướng 7 ngày, lịch sử xoay — chỉ đọc, không tự xoay |
| `/history` | 6 tin nhắn gần nhất của phiên hiện tại |
| `/clear` | Xoá toàn bộ state của chat này (session/dir/model/agent) — tin kế tiếp tạo phiên mới |

### Xoay phiên Manager (tự động)

Session Manager phình dần theo ngày. Bot đo **nền context** (giá trị nhỏ nhất đã
gửi trong 24h) mỗi 10 phút và xoay phiên khi:

- **nền ≥ ~110K** → xoay **tự động** (bot báo trước/sau khi xoay);
- **nền ≥ ~90K** → bot hỏi bằng nút: `🔄 Xoay ngay` / `↩️ Giữ phiên cũ` — bỏ qua
  thì được hỏi lại (tối đa 12 giờ/lần).

Khi xoay: phiên cũ được yêu cầu **brief bàn giao** (≤ 300 từ), bot tạo phiên mới
và nạp brief + **memory/notes giữ nguyên** — mạch làm việc không đứt.
Xoay thất bại → phiên cũ giữ nguyên, bot báo lỗi. Muốn chủ động: `/new`.

## 8. Gửi file cho bot

| Gửi | Kết quả |
|---|---|
| **Ảnh** (kèm hoặc không kèm caption) | Bot lưu file, kèm đường dẫn vào prompt — agent **xem được ảnh** |
| **File văn bản** (PDF, code, text, zip…) ≤ 20MB | Lưu + kèm đường dẫn vào prompt; **caption = chỉ dẫn** cho agent |
| File không kèm caption | Prompt mặc định: "hãy xem nội dung file đó" |
| Caption bắt đầu bằng `/` | Được hiểu là **lệnh** — file bị bỏ qua |
| Video / audio / voice / sticker | Chưa hỗ trợ — bot xin lỗi nhẹ |

- Giới hạn 20MB/file (giới hạn của Telegram Bot API).
- File lưu trong `data/uploads/<chat>/` và **tự xoá sau 7 ngày** khi bot khởi động lại.
- Trong **topic cố vấn** (`/ask`): không nhận file — chỉ hỏi bằng chữ.

## 9. `/ask` — cố vấn thứ hai (Claude / Gemini)

`/ask` hỏi một **model khác** (Claude Code hoặc Gemini) chạy trên máy khác của
bạn (qua Tailscale) — ý kiến tham khảo, **chỉ đọc**: không chạy code, không sửa
file, trả lời từ ngữ cảnh được cung cấp.

```
/ask <câu hỏi>                 → mở thread mới với agent mặc định (Claude)
/ask gemini <câu hỏi>          → chọn Gemini (cũng được: "agy")
/ask                           → liệt kê các thread cố vấn đang mở
```

- Mỗi thread là một **topic riêng** (`🧠 Claude: <tiêu đề>`); trả lời hiện trong
  topic đó. **Nhắn tiếp trong topic để hỏi thêm** — agent nhớ ngữ cảnh của thread.
- Tối đa **10 lượt** mỗi thread (hết thì mở thread mới).
- Thread im **24 giờ** → session agent hết hạn, lượt kế tiếp mở session mới
  (mất ngữ cảnh các câu trước).

> Nếu chưa cài advisor daemon, bot báo "Cố vấn chưa bật". Cài đặt một lần trên
> máy có `claude`/`agy`: `cd advisor-daemon && ./install.sh` → ghi
> `ADVISOR_URL` + `ADVISOR_TOKEN` vào `.env` của bot (chi tiết:
> [advisor-daemon/README.md](../advisor-daemon/README.md)).

## 10. `/btw` & `/review`

**`/btw <câu hỏi>`** — hỏi nhanh "nhân tiện" trên một **phiên tạm**:

- Chạy **song song**, không xếp hàng sau lượt đang chạy — dùng được cả khi
  manager đang bận.
- Trả lời hiện ngay trong chat này, rồi phiên tạm bị **xoá** — không lẫn vào
  ngữ cảnh của manager.
- Giới hạn 3 phút — câu hỏi lớn nên 🔥 hoặc `/spawn` thành task thật.

**`/review [đích]`** — review code **chỉ đọc** (chạy skill `review-code`):

- Đích (tuỳ chọn, một từ): số PR (`84`), branch, commit, `a..b`, hoặc `staged`.
- Bỏ trống = thay đổi chưa commit; nếu sạch thì branch hiện tại so với main.
- Không sửa file, không commit, không restart. (Không dùng trong chat Manager —
  ở đó không có repo; dùng trong topic worker hoặc session thường.)

## 11. `/schedule` — chạy prompt tự động theo lịch

Bot **tự chạy một prompt** (đọc/phân tích + báo cáo) trong **worker riêng**
(topic `sch-<id>`), không cần ai bấm.

```
/schedule <spec> <prompt> [dir=<đường dẫn> agent=<tên>]
```

| spec | Ví dụ | Ý nghĩa |
|---|---|---|
| `daily HH:MM` | `/schedule daily 08:00 Review commit 24h qua` | Mỗi ngày lúc 08:00 |
| `weekdays HH:MM` | `/schedule weekdays 08:00 ...` | Thứ 2–6 lúc 08:00 |
| `weekly <thứ> HH:MM` | `/schedule weekly fri 17:00 ...` | Mỗi tuần (mon…sun) |
| `every <N>h` | `/schedule every 6h Kiểm tra CI` | Mỗi N giờ (1–168), chạy theo mốc giờ cố định (6h → 00/06/12/18) |
| `once YYYY-MM-DD HH:MM` | `/schedule once 2026-12-01 09:00 Nhắc việc X` | 1 lần, mốc tương lai |

- **`dir=`** — thư mục worker chạy; ở chat chính **bắt buộc** (không chạy trong
  thư mục Manager). `agent=` — mặc định `build` (cho phép: build, general, explore, plan).
- **Thời gian** theo **giới giờ của máy bot** (Asia/Saigon).
- Chạy trễ trong ≤ 60 phút vẫn chạy bù 1 lần; trễ hơn thì bỏ qua.
- **An toàn:** worker vẫn gửi thẻ permission **cho bạn** — không tự duyệt.
- Trạng thái mỗi lần chạy: `ok` · `skipped-busy` · `skipped-late` · `timeout` · `error`.

### Quản lý lịch

| Lệnh / nút | Ý nghĩa |
|---|---|
| `/schedule` | Liệt kê lịch của chat + nút điều khiển từng lịch |
| `/schedule help` | Hiện lại hướng dẫn |
| `/schedule pause <id>` / `resume <id>` | Tạm dừng / bật lại (nút ⏸ / ▶) |
| `/schedule run <id>` | Chạy ngay (nút ▶▶) |
| `/schedule rm <id>` (alias `del`, `delete`) | Xoá — 2 bước xác nhận (nút 🗑) |

`rm` xoá lịch nhưng **giữ topic + lịch sử** — dọn bằng `/prune` hoặc 👍.
Lịch lưu **độc lập** với `/clear`. Tối đa 10 lịch.

## 12. Điều khiển chung

| Lệnh | Ý nghĩa |
|---|---|
| `/stop` | Dừng task đang chạy của chat này |
| `/note [ghi chú]` | Ghi chú khi agent bận — agent đọc ở **lượt tiếp theo** (giữ 2 lượt). Không nội dung: xem ghi chú đang chờ. Tin đang bận còn có nút `📝 Thêm vào note` (1 chạm) |
| `/status` | Trạng thái kết nối: phiên bản bot, OpenCode, URL, dir, session, model, variant, mode, agent, busy/idle |
| `/reboot` | Reboot **máy** — xác nhận 2 nút, đếm ngược ~15 giây; bot tự chạy lại sau (linger). Khi máy chạy liên tục ~30 ngày bot cũng tự nhắc (có nút `🔕 Nhắc lại sau`) |

## 13. Bảng tra nhanh

**📁 Phiên & thư mục**
`/new` · `/ls` · `/use <id>` · `/dir [path]` · `/browse [path]`

**🎛 Mode & model**
`/mode` · `/models` · `/model <id>` · `/agents` · `/agent <id>` · `/variants` · `/variant <tên>`

**🧩 Worker (Manager)**
`/spawn <tên> [dir]` · `/board` · `/kill <tên>` · `/stopall` · `/manager on|off` · `/auto on|off` · `/wt` · `/prune [số_ngày]`

**⚙️ Điều khiển**
`/stop` · `/note [ghi chú]` · `/btw <câu hỏi>` · `/ask [claude|gemini] <câu hỏi>` · `/review [PR|branch|commit]` · `/context` · `/usage` · `/rotation` · `/history` · `/status` · `/reboot` · `/clear` · `/schedule` · `/help`

**💡 Mẹo**
- Gõ `/` để hiện menu · khi bot cần hỏi, chọn đáp án bằng **nút** hoặc tự gõ.
- 🔥 vào tin của bot để tách worker · 👍/👎 vào báo cáo DONE để duyệt/bác.
- Phiên dài: `/usage` để xem, `/new` → **Clear + giữ ngữ cảnh** để làm mới.
- Muốn hỏi nhanh mà không bẩn ngữ cảnh manager: `/btw`.

## 14. FAQ / sự cố thường gặp

- **Bot không trả lời?** — ID Telegram của bạn có trong allowlist
  (`TELEGRAM_ALLOWED_USER_IDS`) không? Tin nhắn có bị bot hiểu là lệnh lạ không
  (gõ `/help` để kiểm tra bot còn sống)?
- **"⛔ Not authorized."** — tài khoản của bạn không nằm trong allowlist.
- **Lượt chạy lỗi, nghi context tràn** — xem `/usage`; làm mới bằng `/new`
  → **Clear + giữ ngữ cảnh** (hoặc `/clear` nếu muốn bỏ hẳn). Lượt lỗi có nút
  `⏯ Chạy tiếp` khi có thể tiếp tục.
- **Bot nhắc mãi một câu hỏi/quyền mà không trả lời** — bấm nút trên thẻ, hoặc
  `/stop` để bỏ lượt đó.
- **"⚠️ Không thể nối tới OpenCode"** — OpenCode service đang restart/chưa chạy;
  bot tự nối lại. Kiểm tra `opencode service status` trên máy.
- **Worker kẹt** — `/kill <tên>` (hoặc `/stopall`); topic xong dùng 👍 hoặc
  `/prune` để dọn.
- **Muốn bot dừng reboot tự động** — bấm `🔕 Nhắc lại sau` để hoãn; `/reboot`
  luôn có nút `❌ Huỷ`.
- **Tin tiếng Việt trả lời tiếng Anh?** — bot theo ngôn ngữ đầu tin nhắn của
  bạn; cứ gõ tiếp bằng tiếng Việt.
