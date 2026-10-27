# Kế hoạch: lệnh `/schedule` cho opencode-telegram-bot

## Context
Hiện bot chỉ chạy prompt khi người dùng nhắn. Mục tiêu: thêm `/schedule` để đặt lịch chạy prompt tự động
(vd. 8h sáng hằng ngày review commit mới rồi báo kết quả / tạo issue), thay cho routine cloud / GitHub Actions
(đã bỏ vì cần kết nối GitHub và API key ngoài). Mọi thứ chạy ngay trong bot, dùng OpenCode service sẵn có.

Đã chốt với người dùng: cú pháp tự nhiên (không cron), **session mới mỗi lượt**, lượt lỡ **chạy bù tối đa 1 lần nếu lỡ < 1 giờ**.

## Phạm vi v1 — giới hạn "không người trông" (bổ sung khi review)
**Lịch chạy KHÔNG CÓ người ở đó.** Nhưng nguyên tắc bảo mật hiện có là **mọi permission vẫn về người dùng,
không bao giờ auto-duyệt** (Manager cũng không trả lời quyền của worker). Hai điều này xung đột trực tiếp:
nếu agent của lịch cần BẤT CỨ permission nào (shell cho `git log`/`git diff`, `gh issue create`, 1 edit file)
mà không ai bấm → treo ở permission card → sau `OPENCODE_TG_SCHEDULE_TIMEOUT_MIN` (30') → interrupt + báo
"⏱ quá hạn". **Hậu quả: lịch chạy đều đặn nhưng ra không ra gì, im lặng, lần nào cũng vậy — tệ hơn là fail to rõ.**

Do đó v1 chỉ đảm nhận những gì agent làm được **không cần duyệt**:
- ✅ **Đọc & phân tích** (`git log`, `git diff`, đọc file, `aft_*`/`ast_grep` read-only) + **báo kết quả vào chat/topic**.
- ❌ **Tác động cần duyệt** (tạo issue `gh issue create`, sửa file, push): **KHÔNG ở trong v1 unattended.**
  Muốn có: (a) user có mặt để bấm duyệt, HOẶC (b) **auto-approve scoped theo lịch** — từ chối ở v1 vì rủi ro
  prompt-injection (nội dung diff/commit là dữ liệu không tin cậy, "Duyệt luôn" lưu rule vĩnh viễn).

→ **Đổi ví dụ flagship:** review commit + **báo tin vào topic** (không "tạo issue"). "Tạo issue" giữ cho giai đoạn
sau (có người, hoặc auto-approve scoped được thiết kế riêng).

**Mặc định agent:** KHÔNG mặc định `plan` nếu use-case cần shell. Chọn agent mà các op read của nó **không cần
permission prompt**. **BƯỚC BẮT BUỘC TRƯỚC BUILD:** verify với OpenCode service đang chạy rằng agent mặc định
chạy được `git log`/`git diff` mà KHÔNG prompt (permissions của agent nằm ở service, KHÔNG nằm trong repo này —
chưa verify được từ source). Nếu `plan` không cho shell-read không-prompt → đổi default hoặc cấp permission scoped an toàn.

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
`agent=plan|build|explore|general` (**mặc định: agent read-only đã verify không-prompt** — xem "Phạm vi v1").

### `every Nh` — ngữ nghĩa anchor (chốt)
"every 6h" **anchor theo wall-clock**, không theo lúc tạo: chạy tại 00:00, 06:00, 12:00, 18:00 (múi giờ của lịch).
Tạo lúc 14:30 → lượt đầu là 18:00 cùng ngày (không phải 20:30). → predictability + testable.
*(Chỉ ảnh hưởng `nextRunAfter`; nếu sau này muốn anchor theo lúc tạo, đổi tại đây.)*

### File mới
- `src/schedule.ts` — logic thuần (như `reminders.ts`): kiểu `Schedule`, `parseScheduleSpec`, `nextRunAfter(spec, afterMs, tz)`,
  `decideRun(nextRunAt, now, graceMs)` → `run | catchup | skip`, `formatSchedule`. Múi giờ bằng `Intl.DateTimeFormat`
  (không thêm dependency; chuyển giờ địa phương → UTC bằng 2 vòng hiệu chỉnh offset, xử lý DST).
- `src/scheduler.ts` — `ScheduleStore` (file riêng `data/schedules.json`, ghi atomic tmp+rename, mode 0o600, copy pattern
  `state.ts:161-170`, file hỏng thì backup `.bak` thay vì mất im lặng) và class `Scheduler` (tick + fire). Phụ thuộc inject
  (`now`, `dispatch`, `notify`) để test không cần Telegram.
- `scripts/test-schedule.ts`.

### Schema `Schedule` (chốt)
```ts
interface Schedule {
  id: string;            // 4 ký tự base36 — vừa callback_data 64 byte
  conv: ConvKey;         // chat/topic của người tạo (đặt nút + nhận báo cáo)
  prompt: string;        // nội dung prompt (đã strip option token)
  spec: SchedSpec;       // { kind, time?, day?, hours? } — đã parse
  tz: string;            // IANA, lưu lúc tạo (không đổi khi sửa env)
  dir: string;           // đã vet (browse roots)
  agent: string;         // agent đã verify không-prompt (vd "plan")
  nextRunAt: number;     // ms epoch (UTC) — nguồn sự thật của tick
  lastRunAt?: number;
  lastStatus?: "ok" | "skipped-busy" | "skipped-late" | "timeout" | "error";
  enabled: boolean;      // false cho `once` đã chạy / khi pause
  createdBy: number;     // user id — re-check allowlist mỗi lượt
  createdAt: number;
}
```
Store: `{ v: 1, schedules: Schedule[] }` trong `data/schedules.json`. Ghi atomic (tmp+rename, 0o600). File hỏng →
rename `.bak` + khởi tạo trống + log (không mất im lặng).

### Vì sao KHÔNG lưu trong `ChatState` / `state.json`
`cmdClear` gọi `st.clear(conv)` (`bot.ts:2786`) → `/clear` sẽ xoá sạch lịch. Mọi key cấp cao của `state.json` cũng bị
coi là một conversation (`chatOf` ra `NaN` với key lạ — `conv.ts:19-20`). Dùng file riêng là an toàn nhất.

### Scheduler (`src/scheduler.ts`)
- `setInterval` 30s, `.unref()` (giống heal loop `orchestrator.ts:229`); chọn tick thay vì `setTimeout` dài để khỏi dính
  giới hạn 2^31 ms và chịu được máy ngủ / đổi giờ. Start cạnh `bot.start()` (`index.ts:41`), stop trong handler
  SIGINT/SIGTERM (`index.ts:54-55`).
- **Chống chạy trùng (quan trọng):** khi đến hạn, **ghi trước** `nextRunAt` mới + `lastRunAt` (với `once` thì
  `enabled=false`) rồi mới dispatch. Crash giữa chừng hoặc restart sẽ không chạy lại lượt đó. Lượt đến hạn trễ ≤ `grace`
  thì chạy bù **một** lần; trễ hơn thì bỏ qua, tiến `nextRunAt` và báo 1 dòng. Không bao giờ chạy bù dồn nhiều lượt.
- **Không xếp chồng:** nếu worker của lịch còn đang `running`/`waiting` thì bỏ lượt này, ghi `lastStatus="skipped-busy"` và báo.
- **Contention capacity:** nhiều lịch cùng giờ mà `assertCapacity` (`orchestrator.ts:632-637`, `maxWorkers` default 5)
  không đủ slot → **KHÔNG throw vào tick**: catch, ghi `lastStatus="skipped-busy"`, report 1 dòng, tick tiếp.
  Tick phải LUÔN catch-all để 1 lịch lỗi không giết cả scheduler.
- Mỗi lần chạy kiểm tra lại người tạo (`createdBy`) còn trong `cfg.allowedUserIds` (check `bot.ts:546`); không còn thì bỏ qua + log.

### Chạy một lượt — `Orchestrator.runScheduled(chat, sch)` (`orchestrator.ts`)
1. Tìm worker `sch-<id>`; chưa có thì `spawn(chat, { name, directory, agent, spawnedBy: "schedule" })` (không `task` →
   `idle`, không chiếm slot; mở rộng union `spawnedBy` ở `orchestrator.ts:134`).
2. Nếu `BUSY` (`orchestrator.ts:56`) → skip.
3. **Session mới (policy):** lượt đầu → **tái dùng session mà `spawn` đã tạo** (không tạo session 2 — tránh orphan).
   Lượt sau → `oc.createSession(dir, { title: "tg:sch-<id>", agent, metadata })` MỚI (`opencode.ts:298-315`) +
   **`oc.removeSession` session của lượt trước** (`opencode.ts:317-321`). Gắn `st.set(conv, { sessionID, guided: true,
   lastRelayedTime: 1 })` (phải gắn sessionID vào conv mới định tuyến được permission/form, xem `findChatBySession`
   `bot.ts:1070`); huỷ reminder của session cũ. **Cap:** chỉ giữ ≤ 1 session sống mỗi lịch → không tích tụ.
4. `oc.prompt(sessionID, workerPreamble + prompt)` (`workerPreamble` `orchestrator.ts:70-74`, `prompt` `opencode.ts:546-551`)
   → `setStatus("running")` → `startTyping`. Reply được relay bằng đường worker sẵn có.
- **Timeout chống treo:** `OPENCODE_TG_SCHEDULE_TIMEOUT_MIN` (mặc định 30). Quá hạn mà vẫn `running/waiting` →
  `stopWorker(conv, false)` (interrupt, thẻ permission cũ hết hạn an toàn) + báo "⏱ quá hạn".
- **Cần topic:** khi `/schedule add` tạo luôn topic (spawn idle) để biết ngay chat có hỗ trợ topic hay không; lỗi thì
  **không lưu lịch** và hiện hướng dẫn bật topic (message sẵn ở `orchestrator.ts:681-684`). **ĐÃ XÁC NHẬN:** chat chính
  (`-1004495820706`) là forum supergroup có topic, bot đủ quyền → v1 OK, không cần fallback.

### Tích hợp `bot.ts`
- `case "/schedule"` trong `handleCommand` (switch `bot.ts:1338-1383`; delegate orch tại `bot.ts:1336`) → `cmdSchedule`;
  dòng help + nút "⏰ Lịch" trong `cmdHelp` (`bot.ts:1641`) / `commandMenu`, nhãn tiếng Việt.
- Callback `sch:p:<id>` / `sch:r:<id>` / `sch:d:<id>` + xác nhận `sch:dy:<id>` thêm trong `handleCallback` (trước nhánh
  `bs:` ở `bot.ts:2007`); id ngắn (4 ký tự base36) để vừa 64 byte.
- `rm` chỉ xoá lịch, **giữ topic + lịch sử** (dọn topic mồ côi bằng `/prune` sẵn có).

### Config (`config.ts` + `.env.example` + `scripts/test-config.ts`)
`OPENCODE_TG_SCHEDULE` (bật mặc định, `0` để tắt) · `OPENCODE_TG_TIMEZONE` (mặc định múi giờ hệ thống, dự phòng
`Asia/Ho_Chi_Minh`, kiểm tra bằng `Intl`, sai thì `warn` + dùng mặc định) · `OPENCODE_TG_MAX_SCHEDULES` (10) ·
`OPENCODE_TG_SCHEDULE_GRACE_MIN` (60) · `OPENCODE_TG_SCHEDULE_TIMEOUT_MIN` (30). Dùng `parseIntSetting` có sẵn
(`config.ts:203`). Múi giờ được lưu theo từng lịch lúc tạo để không đổi khi sửa env.

## Rủi ro và cách giảm (side effect lên repo / issue của khách)
| Rủi ro | Giảm |
|---|---|
| Lịch cần permission → treo im lặng (v1 scope) | v1 chỉ op không-prompt; verify agent trước build; timeout 30' + báo rõ |
| Chạy trùng khi restart / retry | Ghi `nextRunAt` trước khi dispatch; không auto-retry; chạy bù tối đa 1 |
| Chạy trùng nhiều lịch cùng giờ (capacity) | Tick catch-all; skip + report, không throw |
| Session tích tụ | Lượt N xoá session lượt N-1; chỉ 1 session sống mỗi lịch |
| Lượt tự chạy làm việc nguy hiểm | Mặc định agent read-only không-prompt; permission vẫn qua người dùng; không bao giờ tự `always`; `dir` bị khoá trong browse roots |
| Treo vì không ai bấm permission | Timeout 30 phút → interrupt + báo |
| Tốn token / spam | Tối đa 10 lịch, `every` ≥ 1h, bỏ lượt khi worker đang bận |
| Rò dữ liệu nhạy cảm qua issue | Khuyến nghị đặt dòng "không dán token/.env" vào prompt (README ví dụ) |
| `/clear` làm mất lịch | Lưu file riêng, không nằm trong `state.json` |

## Kiểm thử
1. `scripts/test-schedule.ts` (thêm `test:schedule` vào `test:unit`, kiểu `check()` như các test khác): parse hợp lệ/không hợp
   lệ (min 1h, ngày quá khứ, giờ sai); `nextRunAfter` cho daily/weekdays/weekly/every/once ở `Asia/Ho_Chi_Minh` và
   `America/New_York` quanh DST (mỗi kind: assert anchor wall-clock cho `every`); `decideRun` (đúng hạn / lỡ <1h / lỡ >1h);
   store round-trip + file hỏng; tick hai lần chỉ dispatch 1 lần; dispatch ném lỗi vẫn không chạy lại; skip-busy;
   **contention → catch + skip, tick không crash**; giới hạn số lịch; người tạo bị gỡ allowlist;
   **lượt đầu không tạo session 2; lượt 2 xoá session 1**.
2. `scripts/test-multi.ts`: thêm ca `runScheduled` — lần 1 tạo topic + dùng session của spawn, lần 2 tái dùng topic với
   session mới + xoá session cũ, skip khi busy, timeout interrupt.
3. `test-config.ts`: các biến mới (rác → mặc định + warn).
4. **Verify trước build (ngoài repo):** chạy OpenCode service, kiểm tra agent mặc định có chạy `git log`/`git diff`
   không cần permission prompt không (chạy thử 1 session). Nếu không → đổi default agent hoặc cấp permission scoped an toàn.
5. Thứ tự theo AGENTS.md: `npm run typecheck` → `npm run test:unit` → `npm run smoke` (cuối, ~3-4 phút, cần OpenCode chạy;
   đọc log từng mục chứ không chỉ exit code).
6. E2E thủ công: `systemctl --user restart opencode-bot` (không chạy `npm start` thứ hai), tạo
   `/schedule once <hôm nay +2 phút> echo test`, kiểm tra topic + reply; restart bot trước giờ hẹn → vẫn chạy đúng 1 lần;
   kiểm tra `journalctl --user -u opencode-bot -n 20`.
7. Dùng thật cho yêu cầu ban đầu:
   `/schedule daily 08:00 Review commit trong 24h qua của repo này (git log --since="24 hours ago"), liệt kê tối đa 3 vấn đề thật kèm file/hàng. Không dán token/.env. (v1: chỉ báo kết quả vào topic — chưa tạo issue.)`

## Tài liệu / commit
README: dòng lệnh trong bảng + mục "Scheduled prompts" (kèm ghi chú v1-scope + "không người trông"); `.env.example`;
help tiếng Việt. Commit theo Conventional Commits (`feat: /schedule`, `test:`, `docs:`) — chỉ commit khi bạn yêu cầu.

## Trạng thái (cập nhật sau review 2026-10-27)
- **Line refs đã re-anchor** với main @ `27b0e3f` (2026-10-27). Plan gốc viết theo revision cũ (`0ff49e8`, ~80 commit
  trước main) nên refs đã lệch — giờ sửa hết.
- **Scope v1** chốt: chỉ op không-prompt + báo tin; "tạo issue" chờ giai đoạn sau (xem "Phạm vi v1").
- **Session policy** chốt: lượt đầu dùng session của spawn, lượt sau xoá session cũ, ≤ 1 session sống/lịch.
- **Topic mode**: xác nhận sẵn sàng ở chat chính → v1 OK.
- **Còn verify trước build**: agent mặc định có shell-read không-prompt không (mục Kiểm thử #4).
- **2 quyết định còn lại cho user:** (1) default agent (chờ kết quả verify); (2) có chấp nhận v1 không-tạo-issue không,
  hay cần auto-approve scoped (tăng rủi ro → cân nhắc riêng).
