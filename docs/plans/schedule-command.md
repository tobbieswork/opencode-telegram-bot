# Kế hoạch: lệnh `/schedule` cho opencode-telegram-bot

## Context
Hiện bot chỉ chạy prompt khi người dùng nhắn. Mục tiêu: thêm `/schedule` để đặt lịch chạy prompt tự động
(vd. 8h sáng hằng ngày review commit mới rồi báo kết quả / tạo issue), thay cho routine cloud / GitHub Actions
(đã bỏ vì cần kết nối GitHub và API key ngoài). Mọi thứ chạy ngay trong bot, dùng OpenCode service sẵn có.

Đã chốt với người dùng: cú pháp tự nhiên (không cron), **session mới mỗi lượt**, lượt lỡ **chạy bù tối đa 1 lần nếu lỡ < 1 giờ**.

## Trả lời câu hỏi "tự tương tác với Manager có hợp lý không?"
- **Dùng hạ tầng worker của orchestrator: hợp lý, và kế hoạch này làm vậy.** Mỗi lịch có 1 worker topic riêng
  (`sch-<id>`): có sẵn topic, icon trạng thái 🟢🟡✅❌, `/board`, `/kill`, giới hạn `OPENCODE_TG_MAX_WORKERS`,
  relay reply, thẻ permission/question gửi đúng topic.
- **Để Manager (LLM) tự duyệt permission/question: không.** Trái nguyên tắc hiện có ("permission và câu hỏi của worker
  luôn về người dùng, Manager không bao giờ trả lời"), nội dung diff/commit message là dữ liệu không tin cậy (prompt injection),
  và "Duyệt luôn" lưu rule vĩnh viễn. Thay vào đó: thẻ permission vẫn về bạn trong topic như thường
  (vd. `gh issue create` cần bạn bấm "Duyệt 1 lần"), cộng thêm **timeout chống treo** (xem dưới).

## Thiết kế

### Cú pháp
```
/schedule                      → danh sách + nút ⏸/▶️ · ▶ chạy ngay · 🗑 xoá
/schedule daily 08:00 <prompt>
/schedule weekdays 08:00 <prompt>
/schedule weekly mon 09:00 <prompt>
/schedule every 6h <prompt>            (tối thiểu 1h, tối đa 168h)
/schedule once 2026-11-01 08:00 <prompt>
/schedule pause|resume|run|rm <id>
```
Tuỳ chọn đứng ngay sau spec: `dir=<path>` (mặc định thư mục hiện tại của chat, qua `vetDirectory` → `OPENCODE_TG_BROWSE_ROOTS`),
`agent=plan|build|explore|general` (**mặc định `plan`**, vì chạy không người trông).

### File mới
- `src/schedule.ts` — logic thuần (như `reminders.ts`): kiểu `Schedule`, `parseScheduleSpec`, `nextRunAfter(spec, afterMs, tz)`,
  `decideRun(nextRunAt, now, graceMs)` → `run | catchup | skip`, `formatSchedule`. Múi giờ bằng `Intl.DateTimeFormat`
  (không thêm dependency; chuyển giờ địa phương → UTC bằng 2 vòng hiệu chỉnh offset, xử lý DST).
- `src/scheduler.ts` — `ScheduleStore` (file riêng `data/schedules.json`, ghi atomic tmp+rename, mode 0o600, copy pattern `state.ts:161-170`,
  file hỏng thì backup `.bak` thay vì mất im lặng) và class `Scheduler` (tick + fire). Phụ thuộc inject (`now`, `dispatch`, `notify`) để test không cần Telegram.
- `scripts/test-schedule.ts`.

### Vì sao KHÔNG lưu trong `ChatState` / `state.json`
`cmdClear` gọi `st.clear(conv)` (`bot.ts:1421`) → `/clear` sẽ xoá sạch lịch. Mọi key cấp cao của `state.json` cũng bị coi là một conversation
(`chatOf` ra `NaN` với key lạ). Dùng file riêng là an toàn nhất.

### Scheduler (`src/scheduler.ts`)
- `setInterval` 30s, `.unref()` (giống heal loop `orchestrator.ts:165`); chọn tick thay vì `setTimeout` dài để khỏi dính giới hạn 2^31 ms
  và chịu được máy ngủ / đổi giờ. Start cạnh `bot.start()` (`index.ts:36`), stop trong handler SIGINT/SIGTERM (`index.ts:41-50`).
- **Chống chạy trùng (quan trọng):** khi đến hạn, **ghi trước** `nextRunAt` mới + `lastRunAt` (với `once` thì `enabled=false`) rồi mới dispatch.
  Crash giữa chừng hoặc restart sẽ không chạy lại lượt đó. Lượt đến hạn trễ ≤ `grace` thì chạy bù **một** lần; trễ hơn thì bỏ qua,
  tiến `nextRunAt` và báo 1 dòng. Không bao giờ chạy bù dồn nhiều lượt.
- **Không xếp chồng:** nếu worker của lịch còn đang `running`/`waiting` thì bỏ lượt này, ghi `lastStatus="skipped-busy"` và báo.
- Mỗi lần chạy kiểm tra lại người tạo (`createdBy`) còn trong `allowedUserIds` (`bot.ts:264`); không còn thì bỏ qua + log.

### Chạy một lượt — `Orchestrator.runScheduled(chat, sch)` (`orchestrator.ts`)
1. Tìm worker `sch-<id>`; chưa có hoặc bị `/clear` thì `spawn(chat, {name, directory, agent, spawnedBy:"schedule"})` (không `task` → `idle`, không chiếm slot; mở rộng union `spawnedBy` ở `orchestrator.ts:110`).
2. Nếu `BUSY` → skip; `assertCapacity`; nếu trạng thái `stopped/done/failed` thì đặt lại `idle`.
3. **Session mới:** `oc.createSession(dir, {title:"tg:sch-<id>", agent, metadata})`, `applyModelAndVariant`, `st.set(conv, {sessionID, guided:true, guidedLanguageSession:undefined, lastRelayedTime:1})`
   (phải gắn sessionID vào conv mới định tuyến được permission/form, xem `findChatBySession` `bot.ts:1662`); huỷ reminder của session cũ.
4. `oc.prompt(sessionID, workerPreamble + prompt)` → `setStatus("running")` → `startTyping`. Reply được relay bằng đường worker sẵn có.
- **Timeout chống treo:** `OPENCODE_TG_SCHEDULE_TIMEOUT_MIN` (mặc định 30). Quá hạn mà vẫn `running/waiting` → `stopWorker(conv,false)` (interrupt, thẻ permission cũ hết hạn an toàn qua nhánh "not found" `bot.ts:1738`) + báo "⏱ quá hạn".
- **Cần topic:** khi `/schedule add` tạo luôn topic (spawn idle) để biết ngay chat có hỗ trợ topic hay không; lỗi thì **không lưu lịch** và hiện hướng dẫn bật topic (message sẵn ở `orchestrator.ts:482`).

### Tích hợp `bot.ts`
- `case "/schedule"` trong `handleCommand` (`bot.ts:481-524`) → `cmdSchedule`; dòng help + nút "⏰ Lịch" trong `cmdHelp`/`commandMenu` (`bot.ts:691-743`), nhãn tiếng Việt.
- Callback `sch:p:<id>` / `sch:r:<id>` / `sch:d:<id>` + xác nhận `sch:dy:<id>` thêm trước nhánh `bs:` trong `handleCallback` (`bot.ts:908-950`); id ngắn (4 ký tự base36) để vừa 64 byte.
- `rm` chỉ xoá lịch, giữ topic và lịch sử.

### Config (`config.ts` + `.env.example` + `scripts/test-config.ts`)
`OPENCODE_TG_SCHEDULE` (bật mặc định, `0` để tắt) · `OPENCODE_TG_TIMEZONE` (mặc định múi giờ hệ thống, dự phòng `Asia/Ho_Chi_Minh`, kiểm tra bằng `Intl`, sai thì `warn` + dùng mặc định)
· `OPENCODE_TG_MAX_SCHEDULES` (10) · `OPENCODE_TG_SCHEDULE_GRACE_MIN` (60) · `OPENCODE_TG_SCHEDULE_TIMEOUT_MIN` (30). Dùng `parseIntSetting` có sẵn (`config.ts:120`).
Múi giờ được lưu theo từng lịch lúc tạo để không đổi khi sửa env.

## Rủi ro và cách giảm (side effect lên repo / issue của khách)
| Rủi ro | Giảm |
|---|---|
| Chạy trùng khi restart / retry | Ghi `nextRunAt` trước khi dispatch; không auto-retry; chạy bù tối đa 1 |
| Lượt tự chạy làm việc nguy hiểm | Mặc định agent `plan`; permission vẫn qua người dùng; không bao giờ tự `always`; `dir` bị khoá trong browse roots |
| Treo vì không ai bấm permission | Timeout 30 phút → interrupt + báo |
| Tốn token / spam | Tối đa 10 lịch, `every` ≥ 1h, bỏ lượt khi worker đang bận |
| Rò dữ liệu nhạy cảm qua issue | Khuyến nghị đặt dòng "không dán token/.env" vào prompt (README ví dụ) |
| `/clear` làm mất lịch | Lưu file riêng, không nằm trong `state.json` |

## Kiểm thử
1. `scripts/test-schedule.ts` (thêm `test:schedule` vào `test:unit`, kiểu `check()` như các test khác): parse hợp lệ/không hợp lệ (min 1h, ngày quá khứ, giờ sai);
   `nextRunAfter` cho daily/weekdays/weekly/every/once ở `Asia/Ho_Chi_Minh` và `America/New_York` quanh DST; `decideRun` (đúng hạn / lỡ <1h / lỡ >1h);
   store round-trip + file hỏng; tick hai lần chỉ dispatch 1 lần; dispatch ném lỗi vẫn không chạy lại; skip-busy; giới hạn số lịch; người tạo bị gỡ allowlist.
2. `scripts/test-multi.ts`: thêm ca `runScheduled` — lần 1 tạo topic, lần 2 tái dùng topic với session mới, skip khi busy, timeout interrupt.
3. `test-config.ts`: các biến mới (rác → mặc định + warn).
4. Thứ tự theo AGENTS.md: `npm run typecheck` → `npm run test:unit` → `npm run smoke` (cuối, ~3-4 phút, cần OpenCode chạy; đọc log từng mục chứ không chỉ exit code).
5. E2E thủ công: `systemctl --user restart opencode-bot` (không chạy `npm start` thứ hai), tạo `/schedule once <hôm nay +2 phút> echo test`, kiểm tra topic + reply; restart bot trước giờ hẹn → vẫn chạy đúng 1 lần; kiểm tra `journalctl --user -u opencode-bot -n 20`.
6. Dùng thật cho yêu cầu ban đầu:
   `/schedule daily 08:00 Review commit trong 24h qua của repo này (git log --since="24 hours ago"), liệt kê lỗi thật, tối đa 3 vấn đề, không dán token/.env. Nếu có, đề xuất tạo issue.`

## Tài liệu / commit
README: dòng lệnh trong bảng + mục "Scheduled prompts"; `.env.example`; help tiếng Việt. Commit theo Conventional Commits
(`feat: /schedule`, `test:`, `docs:`) — chỉ commit khi bạn yêu cầu.

## Điểm cần xác nhận khi review kế hoạch
- Chat của bạn có **topic mode** không? Kế hoạch v1 yêu cầu topic (mỗi lịch 1 topic). Nếu không có, cần phương án dự phòng
  (chạy trong chính chat, thay session hiện tại) — làm thêm sẽ phức tạp hơn.
- Mặc định agent `plan` có đủ để review commit (git log/diff qua bash) không, hay bạn muốn `build`?
