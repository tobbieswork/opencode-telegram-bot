# Đánh giá khả năng scale — `opencode-telegram-bot`

> **Ngày:** 2026-11-19 · **Phiên bản được audit:** v1.49.0 (HEAD `0499a9f`, package.json:3)
> **Phương pháp:** đọc code thật + đo trực tiếp (du/ps/wc); mỗi claim có `file:line` hoặc giá trị đo.
> Repo được đọc **chỉ-một-way (read-only)**, không đổi gì.
> Bản brief `docs/project-brief.md` (270 dòng, 2026-11-19) được dùng làm chỉ dẫn; các claim then chốt được verify lại ở đây. Chỗ brief nói lệch với code hiện tại được ghi rõ.

**Bối cảnh vận hành (từ thực tế khai báo):** 1 người sở hữu, 1 máy Ubuntu single-user, 1 OpenCode server,
~1 manager session + 1–4 spec worker song song. Worker tiêu 100–570K LLM tokens/giờ khi chạy nặng,
manager ~1K/h. Context window model 200K, auto-compaction ~170K.

---

## 1. Hiện trạng

### 1.1 State sống ở đâu: in-memory vs on-disk

**In-memory (mất khi crash không graceful):**
- Toàn bộ per-conversation state (session id, directory, model, agent, worker info, user prefs) nằm trong
  `StateManager` — giữ trong RAM, ghi đĩa bằng **tmp-file + rename** (atomic, mode 0600)
  (`src/state.ts:521-522`; write-tmp helper ở `src/state.ts:441-442`). Theo brief §6.2, bot ghi lại
  **khi SIGTERM** — nên file trên đĩa là stale trong suốt thời gian chạy; sửa file khi bot đang chạy
  sẽ bị ghi đè.
- Dispatch budget của Manager: `Map<ConvKey, number>` in-memory (`src/orchestrator.ts:281`).
- Queue tin khi agent bận: in-memory, cap **3/conversation**, hết hạn **30 phút**
  (`src/queue.ts:11`, `DEFAULT_EXPIRY_MS` ở `src/queue.ts:26`).
- Callback token ngắn hạn (fallback cho callback_data >64B): in-memory, TTL 24h, cap 2048
  (brief §4.4; cap byte ở `src/callbacks.ts:40`).
- Snapshot pr-watch (dedup PR/comments/CI): in-memory (brief §2.11).

**On-disk (sống qua restart):**

| File | Kích thước (đo 2026-11-19) | Ghi chú |
|---|---|---|
| `data/state.json` | **485 KB** | mapping conversation→session/dir/model/agent; atomic write; corrupt → rename `*.corrupt-<ts>` giữ evidence (`src/state.ts:360-372`) |
| `data/audit.log` | **341 KB** | JSONL 0600, rotate sang `.1` theo size, **chỉ giữ 1 thế hệ** (`src/audit.ts:63-81`) |
| `data/users.json` | nhỏ | prefs per-user (`src/state.ts:392`) |
| `data/schedules.json` | nhỏ | file-backed scheduler store (crash-safe: persist trước dispatch — brief §2.10) |
| `data/rotation-health.json` | ~1 KB | đo thật: `currentFloorK: 72`, floor trend ngày 22–96K (đo trực tiếp) |
| `data/manager/` | 96 KB | state của manager |
| `data/uploads/` | 4 KB (hiện tại) | cap tổng 500 MB (`src/uploads.ts:15`), TTL 7 ngày (brief §2.16) |
| `data/notes/`, `data/research/`, `data/ai-improve/` | 12K / 56K / 28 KB | |
| **Tổng `data/`** | **18 MB** | + 3 backup tay: `state.json.bak-finalstate`, `state.json.bak-floorfix`, `schedules.json.bak-6am` (đo `ls data/`) |

**Không nằm trong repo bot:** nội dung sessions (messages, history, compaction artifacts) sống trong
service OpenCode — `~/.opencode` = **711 MB** (đo `du -sh`). Spec state (`docs/sdd/*.md`) nằm trong
git — source of truth trên đĩa và được re-parse mỗi lần dùng (`src/commands/spec.ts`, brief §2.3) —
đây là thiết kế tốt cho scale theo thời gian: không có "state spec" nào bị stale trong memory.

**Kết luận nhanh:** bề mặt state trên đĩa của *bot* rất nhỏ (18 MB, state.json < 0.5 MB). Thứ lớn và
thứ không backup được tự động là `~/.opencode` (711 MB, sessions) và các **worktree** (xem 1.2).

### 1.2 Một worker run thực tế tốn bao nhiêu

**RAM (đo `ps aux` 2026-11-19):**
- `opencode serve --service` **v2.2.6** (đo `opencode --version`): 1 process, **RSS ≈ 1.09 GB**, chạy
  từ 17/11 (PID 7251). Đây là server duy nhất chứa toàn bộ sessions (manager + mọi worker).
- 2 process embedding-worker của plugin magic-context: **~277 MB × 2** (đo `ps` — đường dẫn có
  `@cortexkit/opencode-magic-context@latest` → load bản mới nhất lúc chạy, xem §3 mục 8).
- Bot (tsx src/index.ts): **~150 MB**.
- Máy: **14 GiB RAM, ~10 GiB available**, 16 cores (đo `free -h`, `nproc`).

**Disk per worker:**
- Worktree = git worktree thật (`<repo>.worktrees/<name>`, branch `tg/<name>` — `src/worktree.ts`,
  brief §3.6) → **chia sẻ object store**, chỉ tốn working tree của repo đó.
- `node_modules` **không cài lại** — symlink sang checkout chính, best-effort
  (`src/worktree.ts:113-137`). Chi phí disk incremental của một worktree ≈ bằng 0 cho repo hiện tại.
- **Ngoại lệ nguy hiểm:** task nào đó chạy `npm install` trong worktree (lockfile drift, native dep,
  monorepo workspace) → sinh `node_modules` thật, vài trăm MB đến 1+ GB.
- `.worktrees/` hiện **trống** (đo `ls`) — worktree được merge/remove sạch.
- Disk máy: 457 GB, **276 GB trống (37% đã dùng)** (đo `df -h /`).

**LLM tokens per run:**
- Cơ chế đo: `/usage` so **input + cache-read của bước assistant mới nhất** với context limit của
  model — đây mới là con số quyết định overflow, không phải tổng token tiêu thụ
  (`src/usage.ts:7-8`, brief §2.13).
- Con số vận hành (khai báo): worker **100–570K tok/giờ** khi chạy nặng; manager **~1K/h**.
- Compaction ceiling = `limit − max(15% × limit, 16K)` → 200K window ⇒ **~170K**
  (`src/usage.ts:167-172`, comment ghi "verified against the 200K window → 170K").

### 1.3 OpenCode server đơn tiến trình chịu được bao nhiêu worker song song

- Server = 1 process Node (`opencode serve`), mọi session nằm trong process đó. LLM inference chạy
  **xa** (endpoint `https://code-agent.cads.live/v1`, provider DC5 — `~/.config/opencode/opencode.jsonc:9`,
  model mặc định `qwen/qwen3.8-27b`) nên chi phí local của một worker *active* chủ yếu là: file I/O,
  git, và các subprocess build/test do worker spawn. Phần lớn thời gian session chỉ chờ I/O mạng.
- Giới hạn có chủ đích trong code: `OPENCODE_TG_MAX_WORKERS` mặc định **5** (`src/config.ts:295`);
  dispatch budget **12 dispatch/người dùng nói** (`src/orchestrator.ts:111-112`).
- Giới hạn vật lý thực tế trên máy này: baseline server 1.1 GB tăng dần theo số session + history +
  compaction artifacts; mỗi lần chạy `typecheck`/`test:unit` gate thêm đỉnh RAM vài trăm MB.
  Với 14 GiB, **~6–8 worker active thoải mái, 10–12 là căng RAM** trước khi đụng CPU (16 cores).
- **Nút thắt thật không phải máy:** (1) 1 người giám sát không đọc nổi >5 checkpoint card song song,
  (2) nhiễu Telegram trong group (xem 1.4), (3) endpoint LLM (quota GPU) nếu nhiều worker gọi cùng lúc.

### 1.4 Telegram rate limits và chỗ bot đang gần chúng

Giới hạn phía Telegram (API docs, không enforce trong code — Telegram trả 429 + `retry_after`, bot
honour nó: `src/telegram.ts:368, 585, 780`):
- **4096 chars/tin** → bot split ở **4000** với logic giữ tag well-formed (`src/telegram.ts:158-173`).
- **~20 msg/phút/group**, **~1 edit/giây/message**, ~30 msg/giây toàn cục.
- `callback_data` **64 BYTE** (không phải ký tự) — bot đo bằng `Buffer.byteLength`
  (`src/callbacks.ts:40`), fallback token ngắn hạn khi vượt (brief §4.4).

Chỗ bot **thiết kế sát** giới hạn (đã biết và đã phòng):
- Streaming trong **group**: không dùng draft (Bot API từ chối `TEXTDRAFT_PEER_INVALID`), dùng
  `editMessageText` với **budget sửa hữu hạn `EDIT_BUDGET=20`** để turn 3 phút không "đánh bom" API
  (`src/stream.ts:27-34`).
- Watch card: interval clamp `[2000, 5000]ms` và **floor 5000ms cho group** vì group bị giới hạn
  edit chặt hơn 1:1 (`src/watch.ts:108-120`); băng sau 10 phút (`OPENCODE_TG_WATCH_MAX_MIN`, brief §2.6).
- Checkpoint/spec card dùng **edit** chứ không gửi mới (brief §2.3) — đúng pattern tiết kiệm quota.
- Reminder cho câu hỏi/quyền pending: backoff 300s × 2, tối đa 4 lần (brief §2.4).
- 429 → đọc `retry_after` và đợi, không retry mù (`src/telegram.ts:780`).

**Đánh giá:** tải hiện tại (1 chủ, 1–4 worker, mỗi worker một forum topic riêng — limit tính theo
chat, topic là sub-chat nên phần lớn độc lập) **còn xa** các trần. Chỗ sẽ chạm trước: (1) >6–8 worker
cùng bật streaming + watch → hàng edit dồn dập, 429 tăng (hiện chỉ xử lý reactive);
(2) pr-watch tick mà snapshot diff lớn (nhiều PR/event cùng lúc) → burst message. Chi tiết ở trục (e).

---

## 2. Các trục scale

### 2a. Nhiều worker song song hơn trên 1 máy

**Gỡ trước nhất, theo thứ tự:**
1. **Giám sát con người** (trước cả RAM): mỗi worker đang chạy = 1 card checkpoint chờ người accept.
   5 worker chạy xong gần cùng lúc = 5 quyết định dồn dập. Đây là trần mềm thực sự của hệ thống.
2. **RAM của 1 process OpenCode** (baseline 1.1 GB, không có cap; history + compaction tích luỹ theo
   tuổi server — chạy từ 17/11, chưa restart service riêng).
3. **Đỉnh RAM build/test đồng thời**: 3–4 worker cùng chạy `test:unit` trên 16 cores/14 GiB vẫn ok,
   nhưng 6+ worker chạy test song song + server 1.1 GB → swap.
4. **Endpoint LLM**: 5–8 session gọi cùng lúc → quota/latency phía `code-agent.cads.live` (không thấy
  trong code — là giới hạn hạ tầng, cần hỏi người vận hành endpoint).

**Quy mô xấp xỉ:** 4–6 worker thoải mái · 8–10 căng RAM + giám sát · **>12 là sai thiết kế cho 1 máy
1 người.**

**Cách sửa:**
- **S (đã có, giữ):** cap `MAX_WORKERS=5` + dispatch budget 12 — đừng bỏ.
- **M — tách nhiều OpenCode server** (mỗi server 1 thư mục data riêng, bot nối qua
  `OPENCODE_SERVICE_URL` — cơ chế discover/ensure đã có ở `src/opencode.ts:239-255`). Rủi ro: session id
  trong `state.json` gắn với đúng server đã tạo nó → cần mapping server→session, và watchdog hiện chỉ
  biết 1 service. Công ~vài ngày, risk trung bình (crash domain nhân đôi).
- **L — đa máy:** xem §3 mục 11.

### 2b. Nhiều người dùng / nhiều group Telegram

**Cơ chế allowlist hiện tại (đã verify):** `TELEGRAM_ALLOWED_USER_IDS` (danh sách numeric IDs,
comma-separated) **bắt buộc**, thiếu thì **throw khi load config** (`src/config.ts:252-260`);
escape hatch `OPENCODE_TG_ALLOW_ANY=1` (không khuyến nghị). Cổng `allowed()` chạy **một chỗ duy nhất**
trong `Bot.handle` (brief §4.1) — kiến trúc sạch, mở rộng ID là đủ cho "thêm 1 người".

**Gỡ trước nhất khi thêm người:**
1. **Không có phân quyền per-user**: bất kỳ ID nào trong allowlist đều `/reboot` được máy, `/kill`
   worker của người khác, `/spec` run task bất kỳ, `/model` đổi model chung cuộc. Với 2–5 người tin
   nhau cùng 1 group: chấp nhận được. Với người ngoài nhóm tin: không.
2. **Manager + workers là per top-level chat**: 2 nhóm (group) = 2 hệ thống manager độc lập — về mặt
  code chạy được (mỗi conversation một state) nhưng **tranh tài nguyên máy + endpoint LLM** và không
  ai tổng hợp được "hệ thống đang làm gì".
3. **Worktree chung 1 repo**: 2 user cùng sửa 1 repo → 2 worktree `tg/<name>` (cách ly OK về mặt git)
   nhưng conflict lúc merge về main tăng gần bậc thang.
4. **Chi phí không thuộc về ai**: tokens worker tính chung — không có metering per-user.

**Quy mô xấp xỉ:** 2–5 người tin cậy, **cùng 1 group**: ổn, chỉ cần thêm ID vào allowlist.
>5 người hoặc nhiều group: cần làm lại bài phân tách (xem cách sửa).

**Cách sửa:**
- **S:** thêm ID + ghi quy ước (ai làm gì, ai được `/reboot` — bằng văn bản, không bằng code).
- **M:** namespacing branch theo user (`tg/<user>/<name>`); per-group manager tự nhiên (đã có theo
  conversation); RBAC tối thiểu (2 vai: admin có reboot/kill, member chỉ spec/worker).
- **L (over-engineering cho profile 1-owner):** metering chi phí per-user, SSO.

### 2c. Nhiều repo hơn / codebase lớn hơn

**Hiện trạng:** bot repo + 2 repo khác (khai báo); guard `OPENCODE_TG_BROWSE_ROOTS` giới hạn nơi
worker được làm việc, giải symlink trước (brief §2.2, `src/config.ts:534`).

**Gỡ trước nhất:**
1. **Giả định node_modules symlink** (`src/worktree.ts:113-137`, best-effort): chỉ đúng khi checkout
   chính của repo đó **đã** `npm install` sẵn. Repo mới checkout hoặc monorepo workspace → worker rơi
   vào worktree không có deps → lỗi khó hiểu hoặc worker tự `npm install` (disk + thời gian).
2. **Thời gian gate**: accept có điều kiện typecheck + `test:unit` chạy thật. Repo có test suite 10–30
   phút → mỗi checkpoint chờ 30 phút → chu kỳ pipeline chậm, người accept mệt. Gate thời gian là trần
   scale theo kích thước repo **trước** khi trần nào khác.
3. **Disk theo repo**: worktree = toàn bộ working tree (không sparse). Repo 5 GB × 3 worktree = 15 GB
   thêm — máy còn 276 GB nên chỉ là vấn đề vệ sinh (`/prune`, brief §2.2).
4. **Token per task tăng**: codebase lớn hơn → mỗi task đọc/hiểu nhiều file hơn → 100–570K tok/h tăng
   theo → compaction dày hơn → behaviour flaky hơn (brief §2.2 ghi nhận đã gặp "flaky LLM behavior").

**Quy mô xấp xỉ:** repo < ~10K LOC, gate < 5 phút: pipeline chạy ngon (đúng profile 3 repo hiện tại).
Repo 50K–200K LOC, gate 15–30 phút: pipeline chạy được nhưng chu kỳ chậm, cần chọn test subset.
Monorepo 1 triệu LOC: không phù hợp thiết kế gate hiện tại.

**Cách sửa:**
- **S:** trong `/health` (hoặc `/status` theo repo) thêm check "node_modules có mặt ở main checkout
  của từng BROWSE_ROOT"; doc yêu cầu `npm install` ở main trước khi dùng repo.
- **M:** gate theo repo (config subset test per repo — "chỉ chạy test bị ảnh hưởng"); spec task bắt
  buộc ghi rõ lệnh verify của task.
- **L (over-engineering cho 3 repo):** sparse-checkout tự động, test sharding, repo registry.

### 2d. Pipeline dài hơn (vài tuần spec, hàng trăm task)

**Hiện trạng đo:** 14 spec trong `docs/sdd/` (đo `ls`), **74 task `[x]` hoàn thành** (đo `grep -c`),
0 task pending — backlog về 0, khớp claim "13+ spec backlog completed".

**Điểm mạnh đã có (đúng thiết kế cho dài ngày):**
- Spec state re-parse từ đĩa mỗi lần — không stale (`src/commands/spec.ts`); task done gắn commit hash
  (`docs/sdd/queue-and-steer.md:96-102` — pattern `N. [x] (hash) **T`).
- Manager rotation floor-driven: confirm 90K / auto 110K tokens, tối thiểu 24h giữa 2 lần
  (`src/config.ts:361-364`); đo thật floor đang **72K**, trend ngày cao nhất 96K
  (`data/rotation-health.json`) — còn dư ~15–40K tới ngưỡng.
- Topic worker dọn bằng `/prune` (brief §2.2).

**Gỡ trước nhất theo thời gian:**
1. **Manager "mất ý tưởng lớn" sau mỗi rotation** (xảy ra ~1 lần/ngày ở cường độ hiện tại). Mitigation
   hiện tại là spec files trên đĩa — nhưng phần "tại sao spec này trước spec kia", "quyết định kiến
   trúc nào đã chốt" chỉ sống trong context manager → mất ở rotation. Đây là rủi ro chất lượng âm thầm.
2. **`state.json` phình tuyến tính** theo số conversation từng tồn tại (worker topic tạo ra rồi prune
   — entry có xoá khỏi state không: cần verify thêm, brief không nói rõ; hiện 485 KB cho ~vài chục
   conversation). 1.000 conversation ≈ ~1 MB — không đáng lo cho nhiều năm.
3. **`audit.log` chỉ giữ 1 thế hệ rotation** (`src/audit.ts:81`) — forensic history của 74 task này
   sẽ mất khi log xoay vòng. Với hệ thống chạy spec tự động, audit là bằng chứng chấp nhận công việc.
4. **`~/.opencode` phình theo tuổi server** (711 MB sau ~2 ngày; sessions không bị xoá tự động).

**Quy mô xấp xỉ:** hàng trăm task nữa trong 6–12 tháng tới: chạy ngon, miễn là làm 3 việc ở §4
(backup state, archive audit, handoff note).

**Cách sửa:**
- **S:** backup `data/` hằng đêm ra ngoài máy (xem §4); audit rotate → copy ngày trước khi overwrite.
- **M:** quản lý state phân vùng per-repo hoặc thêm "handoff note" bắt buộc khi rotate manager (template
  ngắn: quyết định đã chốt + thứ dang dở) — chi phí ~1 prompt injection vào agent prompt manager.
- **L (over-engineering):** SQLite thay JSON — chưa đáng ở 18 MB.

### 2e. Lượng message (thông báo, card edit, streaming) vs Telegram

**Gỡ trước nhất:**
1. **Burst edit** khi nhiều worker stream cùng lúc: mỗi topic có budget riêng (20 edit,
   `src/stream.ts:34`) nhưng **không có rate limiter toàn cục** phía bot — 429 chỉ được xử lý
   reactive (`src/telegram.ts:780` đợi `retry_after`). Khi 4–6 topic cùng phát delta nhanh
   (model "nói" nhiều), tổng edit/giây có thể vượt ~1 edit/s/message × nhiều message → 429 rải rác,
   preview lag, budget edit cháy sớm trong turn.
2. **Burst digest**: pr-watch diff lớn (10+ PR event một tick) → 10+ message liền → chạm 20 msg/phút
   của group ở top-level chat.
3. **Tin >4096**: đã xử lý tốt (split 4000, tag-safe — `src/telegram.ts:158-173`), không phải rủi ro.

**Quy mô xấp xỉ:** 4 worker streaming + watch: gần nhưng chưa chạm. 6–8 worker: 429 thành chuyện
hằng ngày. Cách giảm tải đơn giản: streaming mặc định OFF cho worker (chỉ manager + 1–2 topic quan
trọng bật) — một dòng config, không phải code.

**Cách sửa:**
- **S:** bật `OPENCODE_TG_STREAM` chọn lọc (config, không code); doc "watch chỉ cho topic đang accept".
- **M:** outbox token-bucket toàn cục cho mọi gửi đi (1 hàng chờ, ví dụ 18 msg/phút cho top-level
  group, 1 edit/s/message) — code ~1 ngày, risk thấp (thay reactive bằng proactive).

### 2f. Tăng chi phí LLM

**Mô hình chi phí khác hệ thống công khai:** model chạy qua endpoint **tự host của công ty**
(`DC5` → `https://code-agent.cads.live/v1`, `~/.config/opencode/opencode.jsonc:9`; model
`qwen/qwen3.8-27b` mặc định, `qwen/qwen3.6-27b` dự phòng). Không phải giá API per-token của bên thứ 3
→ "chi phí" thực sự là **sức chứa GPU + quota endpoint** (cần hỏi người vận hành con số quota thật —
code không thấy).

**Tăng trưởng:** tokens/giờ × song song. Ước tính: 4 worker × ~300K tok/h × 8 h ≈ **~10 triệu tok/ngày**
trần nặng. Nếu chạy trên API công (mức giá model frontier $3–15/M input) con số đó là vài trăm USD/ngày;
trên endpoint tự host nó là áp lực đồng thời lên GPU.

**Gỡ trước nhất:**
1. **Quota/speed limit của endpoint** khi 4–6 worker gọi cùng lúc (không thấy trong code — rủi ro hạ tầng).
2. **Chất lượng theo chiều dài session**: session càng dài, compaction càng nhiều, output càng drift —
   "chi phí" chất lượng này tăng phi tuyến và không ai đo được (nguy hiểm nhất vì âm thầm).

**Cách sửa:**
- **S:** `/usage` đã có (brief §2.13) — thêm ngưỡng cảnh báo token/task (task tiêu > X tok → card cảnh báo).
- **M:** token budget per-task (quá ngưỡng → worker tự stop + báo manager, thay vì chạy mù tới overflow).
- **L (chưa cần):** route model rẻ cho task ít rủi ro, cache layer phía endpoint.

---

## 3. Vấn đề tương lai theo likelihood × impact

Xếp theo P × I giảm dần. "P/I" = cao (C) / trung (T) / thấp (Th). "Dấu hiệu sớm" là thứ có thể check
bằng lệnh/tin nhắn hiện có.

**1. Nút thắt giám sát con người — P: C · I: T**
Mỗi task = 1 checkpoint card cần người accept. 74 task qua rồi = 74 lần accept tay. Khi backlog spec
tăng lại, hàng đợi review tăng tuyến tính mà băng thông người không tăng. Hệ quả âm thầm: fatigue →
"stamp cao su" (accept không đọc diff) → chất lượng merge giảm, mà pipeline vẫn xanh.
*Dấu hiệu sớm:* thời gian trung bình từ card xuất hiện đến accept tăng; tỉ lệ bật `/auto` tăng.
*Mitigation rẻ:* không có fix code nào thật sự — nhận thức và giữ `auto` cho lớp task ít rủi ro thôi;
xem mục 9 roadmap (gating theo rủi ro). Đây là "vấn đề scale" số 1 của hệ thống 1-owner, trước cả mọi
vấn đề kỹ thuật.

**2. `state.json` — file đơn, SPOF của mapping conversation↔session — P: T · I: C**
485 KB, 1 writer, atomic write tốt (`src/state.ts:521-522`), có cơ chế corrupt-backup
(`src/state.ts:360-372`) — nhưng **không có backup tự động**. File này chết = bot khởi động với state
trống: mọi topic mất mapping session, manager mất vị trí, user phải `/use` lại từ đầu (session trong
`~/.opencode` vẫn sống nhưng không còn ai chỉ về nó). Crash lúc rename hiếm; rủi ro thực tế cao hơn là
viết đè do sửa tay sai quy trình (brief §6.2 ghi rõ phải stop bot trước khi sửa).
*Dấu hiệu sớm:* bất kỳ lần nào thấy file `*.corrupt-*` trong `data/`; bot start với "state empty" log.
*Mitigation rẻ:* backup `data/` hằng đêm ra ngoài máy (mục 1 roadmap) — 1 giờ làm, xài luôn.

**3. Single-machine SPOF: bot + OpenCode server + state trên 1 ổ — P: T · I: C**
Hardware chết = cả hệ thống dừng, không chỉ process. Watchdog chỉ xử lý process chết/wedge
(`deploy/bot-watchdog.sh` — maintenance lock, journal im lặng >15 phút → restart), không xử lý disk
failure. Code thì an toàn (GitHub), **mất thật** là: `data/` (18 MB), `~/.opencode` (711 MB sessions),
worktree chưa merge. Disk 37% full, không thấy dấu hiệu bệnh (chưa đo SMART — nên đo).
*Dấu hiệu sớm:* journal error I/O, `dmesg` disk error, SMART reallocated sectors > 0.
*Mitigation rẻ:* backup đêm (chống mất data) + runbook rebuild máy (chống downtime — mục 11 roadmap).
Full HA là over-engineering cho 1-owner.

**4. OpenCode v1→v2 và churn phía sau — P: C · I: T–C**
Đã ở v2 (`opencode` binary v2.2.6 đo trực tiếp; `@opencode/client ^2.2.6` — package.json:110). Vấn đề
không phải "v1→v2" nữa mà là **nhịp release**: bot tự release 99 lần trong ~7 tuần (đo `grep -c "## ["
CHANGELOG.md` = 99) — hệ sinh thái này release liên tục, và caret `^2.2.6` cho phép minor bump tự
nhập khi `npm install` lại. Mỗi major có thể đổi API client, semantics event stream (event không
replay — `src/opencode.ts` comment §3.2 brief), hoặc ngưỡng compaction.
*Dấu hiệu sớm:* smoke E2E (`npm run smoke`, brief §5.3) fail sau bump; `opencode --version` lệch giữa
binary (`~/.opencode`) và client (node_modules).
*Mitigation rẻ:* pin chính xác version (bỏ caret); thêm smoke E2E vào CI với binary pinned (bản CI hiện
chạy typecheck + unit — brief §5.4; smoke cần service thật nên chạy manual trước release).

**5. Bề mặt bảo mật: LLM worker có shell + dữ liệu bên ngoài vào prompt — P: T · I: C**
Các lớp đã tốt (đã verify): bot token không vào env của child (`src/index.ts:24` theo brief §4.2, ưu
tiên systemd credential), redact secrets mọi text ra Telegram + audit (`src/redact.ts:46`), MCP bridge
bind `127.0.0.1` + bearer token 24 byte random (`src/mcp-bridge.ts:38-55`), reboot 2 bước + token 1 lần
(`src/uptime.ts:86-91` theo brief §4.3), worker bị giới hạn trong `BROWSE_ROOTS`.
Lỗ còn lại theo thứ tự rủi ro: (a) **prompt injection**: pr-watch đọc **PR comments/review từ GitHub
bên ngoài** (brief §2.11) và worker đọc file trong repo — nội dung độc hại vào context LLM rồi LLM
chạy lệnh shell thật trong worktree; gate accept có người đọc nên chặn được merge độc, nhưng lệnh đã
chạy *trước* accept (typecheck/test trong worktree) — phạm vi thiệt hại = 1 worktree + máy host nếu
worker chạy lệnh nguy hiểm (rm, network, đọc ~/.config). (b) Worker chạy trên **host trực tiếp**, không
sandbox — 1 lệnh sai của LLM có thể đụng file ngoài BROWSE_ROOT (code guard có, nhưng guard ≠ sandbox).
*Dấu hiệu sớm:* không có — đây là sự kiện, không phải trend. (Có thể audit.log quét pattern lệnh lạ.)
*Mitigation rẻ:* review diff kỹ trước accept (đang làm); containerize/namespace worker là fix thật
(nhưng L — mục 10 roadmap), chưa cần nếu chấp nhận rủi ro "worktree + lệnh chạy trên host của mình,
code của mình, repo của mình".

**6. Context/rotation của manager session dài ngày — P: C · I: T**
Đo: floor 72K, đỉnh ngày 96K, ngưỡng confirm 90K / auto 110K, tối thiểu 24h giữa 2 rotation
(`src/config.ts:361-364`). Nghĩa là ở cường độ hiện tại manager **đụng ngưỡng confirm gần như hằng
tuần**, và 1 ngày rất bận (spike >40K floor) có thể chạy qua confirm window mà chưa tới auto. Mỗi
lần rotate mất "ý tưởng lớn" (xem 2d). Không phải crash — là suy giảm chất lượng quản lý âm thầm.
*Dấu hiệu sớm:* trend `rotation-health.json` (đang có sẵn!); manager hỏi lại quyết định đã chốt.
*Mitigation rẻ:* handoff note ở rotation (mục 9 roadmap); nới `ROTATION_MIN_INTERVAL_H` xuống 12h nếu
trend tăng.

**7. Plugin magic-context load `@latest` khi chạy — P: T · I: T**
Đo `ps`: 2 embedding worker chạy từ đường dẫn
`~/.cache/opencode/npm/@cortexkit/opencode-magic-context@latest/...` — nghĩa là **phiên bản plugin
không được pin**, bản mới nhất có thể đổi behaviour (compaction, memory) giữa các lần restart mà không
có changelog nào trong repo bot. Đây là "dependency ẩn" lớn nhất của hệ thống, nằm ngoài
package-lock.json của bot.
*Dấu hiệu sớm:* behaviour manager đổi sau restart (mất memory, compaction khác); `ls ~/.cache/opencode/npm/`
thấy nhiều bản.
*Mitigation rẻ:* pin version plugin trong config OpenCode (1 dòng); theo dõi release notes của plugin.

**8. Model/endpoint thay đổi (deprecation, đổi limit, đổi giá/quota) — P: T · I: T**
Model `qwen3.8-27b` sau endpoint công ty; nếu đổi model: context limit đổi (ảnh hưởng compaction
ceiling — nhưng code đọc limit từ service dynamically: `src/opencode.ts:282` nên tự thích ứng tốt),
giá/quota đổi, quality drift khó phát hiện. Model config được per-conversation (`/model`) nên switch
rẻ.
*Dấu hiệu sớm:* `/status` model lệch; chất lượng output giảm theo trend; quota error từ endpoint.
*Mitigation rẻ:* không có gì ngoài doc "ai quản lý endpoint + ai được hỏi khi quota đổi".

**9. Phụ thuộc Telegram API — P: Th · I: T–C**
Polling chết khi network/VPN chết (DNS heal đã có — brief §2.12, watchdog có). Telegram giữ updates
~24h trong queue nên downtime vài giờ không mất tin; downtime 24h+ thì mất. Rủi ro thật là **chậm phát
hiện** khi bot chết âm thầm (polling lỗi lặp không ai nhìn journal).
*Dấu hiệu sớm:* journal `fetch failed` dồn dập; DNS heal fire; không thấy bot phản hồi 1 lệnh thử.
*Mitigation rẻ:* thêm heartbeat tự gửi (tin "tôi sống" mỗi N giờ vào topic riêng) + cảnh báo nếu mất
2 heartbeat — ~2 giờ code.

**10. Disk growth: `~/.opencode` + audit.log + worktree — P: C (xảy ra chắc) · I: Th**
`~/.opencode` 711 MB sau ~2 ngày (đo); sessions cũ không tự xoá. audit.log chỉ giữ 1 thế hệ rotation
(`src/audit.ts:81`) → mất history khi xoay. Worktree sạch bằng `/prune` nhưng repo khác lớn hơn sẽ
nặng hơn. Với 276 GB trống (đo): trần disk còn xa (~vài tháng đến 1 năm tùy repo), nhưng **không ai
đang nhìn nó**.
*Dấu hiệu sớm:* `du -sh ~/.opencode data .worktrees` hằng tuần (1 lệnh).
*Mitigation rẻ:* cron `du` + alert khi vượt ngưỡng; archive audit trước rotation (mục 2 roadmap).

**11. Chi phí portability đa máy (khi máy này hỏng thật) — P: Th · I: T**
Nếu phải dựng lại máy khác, những gì **thật sự** phải làm (đã verify từng điểm): (a) Node 24 qua nvm
(unit pin đường dẫn tuyệt đối `v24.21.0` — `deploy/opencode-bot.service` ExecStart); (b) `npm install`
+ `tsx src/index.ts`; (c) **`state.json` vô nghĩa trên máy mới** — session id gắn với OpenCode server
cũ (chết theo máy nếu không backup `~/.opencode`); (d) sudoers NOPASSWD cho `safe-reboot.sh` +
`systemd-resolved` (brief §2.12, §4.3); (e) loginctl enable-linger; (f) systemd user service + watchdog
timer; (g) spec state thì **an toàn** — parse từ git (2d). Tức là: pipeline sống lại được từ đĩa (spec
+ task + commit hash), mất mapping conversation↔session (sửa được bằng tay cho vài conversation quan
trọng). Đây là mức "dựng lại 1 buổi chiều", không phải thảm hoạ — nhưng chỉ đúng nếu có runbook.
*Mitigation rẻ:* viết runbook 1 trang (mục 11 roadmap) — 2 giờ.

**12. Release pipeline release-please — phức tạp nhưng chạy 99 lần không ai đụng — P: Th · I: T**
Cơ chế có nhiều workaround mong manh (push no-op bằng owner token vì GitHub khử sự kiện của app,
merge `--admin` vì branch protection, normalize tag vì release-please 17.3.0 lệch config — brief §6.1).
GitHub đổi API/semantics sự kiện, hoặc ai đó đổi branch protection, pipeline chết **âm thầm** (release
PR nằm `action_required` không ai thấy). 99 release OK = bằng chứng, không phải miễn trừ.
*Dấu hiệu sớm:* release PR mới không tự merge trong 1 giờ.
*Mitigation rẻ:* job watchdog "nếu 14 ngày không có tag mới → thông báo Telegram" — 2 giờ.

**13. Node 24 / nvm pin tuyệt đối — P: Th · I: T**
Unit pin `/home/phatnd12/.nvm/versions/node/v24.21.0/bin/node` (đo trong file unit). Xóa nvm dir,
hoặc Node 24 EOL (LTS đến ~10/2028), bot chết khi restart và **chỉ 1 người biết cách sửa**. Rủi ro
thực tế = quên, không phải lỗi.
*Dấu hiệu sớm:* service fail-to-start sau reboot; `node --version` ở /usr/bin lệch.
*Mitigation rẻ:* doc 3 dòng "khi nâng Node: sửa ExecStart PATH + Test" (gộp vào runbook mục 11).

**14. Data sovereignty — ai thấy code của bạn — P: Th · I: T**
Code + prompt + file content đi tới `https://code-agent.cads.live/v1` (endpoint công ty, đo config
`~/.config/opencode/opencode.jsonc:9`); model Qwen 27B. Nếu endpoint đúng là tự host trong infra
công ty (cần xác nhận với người vận hành — config không nói ai đứng sau) thì **không có bên thứ 3
công chúng thấy code**; rủi ro thu về = ai vận hành endpoint + logging phía đó. Advisor (`/ask`) gửi
câu hỏi qua Tailscale sang máy khác, agent read-only (brief §2.15) — bề mặt nhỏ. Redact secrets chạy
trên text Telegram + audit (`src/redact.ts:46`) nhưng **không chạy trên prompt gửi tới LLM** — nếu file
repo chứa secret, secret đó lên endpoint nguyên vẹn (đúng tính chất của coding agent, nhưng phải biết).
*Mitigation rẻ:* 1 đoạn doc "data flow: repo → endpoint cads.live → model; ai vận hành; log giữ bao lâu".

---

## 4. Roadmap đề xuất

Ngắn (làm ngay, <1 ngày) — đều là việc phòng SPOF data, tổng ~nửa ngày:
1. **Backup `data/` hằng đêm ra ngoài máy** (rsync/remote, 5 file < 1 MB). Chặn mục 2, 3, 11 cùng lúc. (S, ~1h)
2. **Archive audit.log trước khi rotation overwrite** (copy `audit.log.<date>` trước `renameSync` ở
   `src/audit.ts:81` — 5 dòng code). Giữ forensic của pipeline spec. (S, ~1h)
3. **Pin version plugin magic-context** (bỏ `@latest` trong config OpenCode). Chặn mục 7. (S, ~15ph)
4. **Doc "data flow + ai vận hành endpoint"** 1 trang. Chặn mù ở mục 14. (S, ~30ph)
5. **`du` + SMART check trong `/health`** (2 dòng: kích thước `~/.opencode`, `data/`; SMART nếu được
   sudo). Chặn mù ở mục 3, 10. (S, ~1h)

Trung hạn (tháng tới) — chỉ làm khi có tín hiệu từ §3:
6. **Handoff note khi rotate manager** (template vào agent prompt manager: quyết định chốt + việc dang
   dở; ghi file vào `data/manager/`). Chặn mục 6. (S–M, ~1 ngày)
7. **Outbox rate limiter toàn cục** (token bucket cho mọi send/edit) — chỉ đáng làm nếu thấy 429 tăng
   khi chạy 4+ worker. Chặn mục 2e. (M, ~1–2 ngày)
8. **Token budget per-task** (quá ngưỡng → stop + card báo) — đáng làm nếu muốn chạy 5+ worker dài.
   Chặn mục 2f. (M, ~2 ngày)
9. **Gating theo rủi ro** (class task "an toàn": test-only/doc-only → auto-accept có log; class rủi ro
   → bắt buộc người đọc diff). Đây là fix thật duy nhất cho nút thắt con người (mục 1) — nhưng làm
   **chậm**, vì tiêu chuẩn "an toàn" phải rút từ 74 task đã accept, không phải phát minh từ đầu. (M,
   ~1 tuần, risk: đặt sai class → chất lượng merge)

Dài hạn (quý) — phần lớn là CHỜ, không phải làm:
10. **Sandbox worker (container/namespace)** — chỉ làm nếu (a) bắt đầu để worker chạy repo không phải
    của mình, hoặc (b) sự kiện injection thật. Cho profile hiện tại (code của mình, gate người accept)
    là over-engineering. (L, ~1–2 tuần)
11. **Runbook rebuild máy** 1 trang (mục 11 của §3: Node pin, systemd, sudoers, state mapping). Viết
    một lần, xài khi máy chết. (S, ~2h)
12. **Tách nhiều OpenCode server** — chỉ khi RAM server > 6–8 GB đo được, hoặc >8 worker thành việc
    thường. (M, vài ngày)

**Rõ ràng là over-engineering cho hệ thống 1-owner này (không làm):** SQLite, HA/multi-active,
Kubernetes, per-user RBAC/metering, load balancing OpenCode, microservice hoá bot.

---

## 5. TL;DR (5 gạch đầu dòng)

1. **Máy không phải trần — 1 người mới là trần.** 16 cores / 14 GB / 276 GB trống dư sức cho 6–8
   worker; nút thắt thật là băng thông accept checkpoint (mỗi task 1 lần đọc + quyết định) và sự
   mệt mỏi dẫn đến accept "stamp cao su".
2. **SPOF data là rủi ro kỹ thuật số 1, và rẻ nhất để chặn:** `state.json` 485 KB + `data/` 18 MB
   không có backup tự động; 1 job rsync đêm (1 giờ làm) chặn luôn cả rủi ro máy chết.
3. **System đã già-đẹp đúng chỗ cần:** spec state trên git (parse lại, không stale), atomic write,
   allowlist throw-if-missing, redact, bridge localhost+token, watchdog, 3.622 checks xanh — các lớp
   an toàn không phải chỗ phải sửa; chỗ phải sửa là các "việc vệ sinh" (audit rotation, disk, backup)
   không ai đang nhìn.
4. **Dependency nguy hiểm nhất nằm ngoài package-lock:** OpenCode binary + plugin magic-context
   (`@latest`!) + endpoint LLM công ty — cả 3 có thể đổi behaviour mà bot không biết; pin version và
   1 trang doc data-flow là đủ.
5. **Quy mô hợp lý trung hạn: 1 chủ + 1–2 người tin cậy, 3–6 repo nhỏ, 4–6 worker, 1 máy.** Vượt
   ngưỡng đó (8+ worker, 5+ user, repo lớn gate 30 phút, đa máy) — hãy dừng lại và hỏi lại có cần
   không, vì mọi fix phía sau (multi-server, sandbox, RBAC) đều là L và phần lớn là over-engineering
   cho profile này.

---
*Report đọc-chỉ-đọc repo; mọi con số đo tại 2026-11-19 (du/ps/wc/df trên máy chạy bot).*
