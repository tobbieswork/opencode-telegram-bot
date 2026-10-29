# Plan: ổn định scheduler, persistence và session lifecycle

- **Ngày:** 2026-10-27
- **Trạng thái:** PR1 đã được duyệt triển khai, đang xác minh; các PR sau chưa triển khai.
- **Baseline khảo sát:** `develop` tại `37e1685`, sau khi merge `main` tại `947a967`.
- **Mục tiêu:** sửa độ đúng và khả năng phục hồi trước; refactor sau khi có regression tests.

Tài liệu này là kế hoạch triển khai, không phải mô tả các bảo đảm đã có. Trước
khi bắt đầu, kiểm tra lại HEAD và các thay đổi kể từ baseline; giữ nguyên công
việc đang có của người dùng. Các phát hiện dưới đây đến từ đọc mã, chưa phải
kết quả tái hiện hoặc chạy tests.

**Phạm vi thiết kế mới:** người dùng yêu cầu General chỉ quản trị, mỗi chủ đề
làm việc gắn một phiên cố định, không tạo/thay phiên trong chủ đề. Xem
[`design-session-topics.md`](design-session-topics.md). Đây là thay đổi hành vi
riêng đang thiết kế, không phải refactor thuần túy hoặc tính năng đã triển khai
trong PR1; chưa tự động đổi thứ tự bàn giao của kế hoạch dưới đây.

## 1. Phạm vi và thứ tự bàn giao

| Bước | Bàn giao | Điều kiện bắt đầu |
| --- | --- | --- |
| 0 | Baseline kiểm thử và regression fixtures | Checkout đã được kiểm tra |
| PR1 | Scheduler concurrency và timeout | Bước 0 |
| PR2 | Tests/mocks và typecheck scripts | PR1 |
| PR3 | Persistence validation, cảnh báo và backup | PR2 |
| PR4 | Session lifecycle | PR3 |
| PR5 | Telegram delivery | PR4 |
| PR6 | Refactor controller và tài liệu vận hành | PR5 |

Mỗi PR có tests đi cùng và được nghiệm thu riêng. PR2 chuẩn hoá hạ tầng kiểm
thử còn lại; không trì hoãn regression tests của PR1 đến PR2.

### Ngoài phạm vi

- Thêm tính năng người dùng hoặc chuyển từ JSON sang database.
- Thay đổi semantics `every Nh` hoặc chính sách quyền/read-only của scheduled
  agent; ghi thành tickets riêng.
- Đại tu kiến trúc hoặc thay bot framework.
- Bảo đảm exactly-once cho dispatch hoặc Telegram delivery.
- Hỗ trợ nhiều bot process cùng ghi một bộ state. Thiết kế concurrency trong
  đợt này nhắm đến một process; không chạy hai polling instances cùng token.

## 2. Bước 0 — chốt baseline

### Công việc

1. Chạy `npm run typecheck`, sau đó `npm run test:unit`.
2. Ghi nhận lỗi có sẵn và phân biệt với lỗi do thay đổi mới. Kiểm tra cleanup
   trong `scripts/test-scheduler.ts` trước khi dựa vào kết quả suite.
3. Chuẩn bị fixtures state/schedules cũ, fake clock/timer và deferred promises
   để điều khiển thứ tự async mà không phải chờ thời gian thực.
4. Xác nhận tests offline không khởi động bot, gọi Telegram hoặc chạy LLM thật.

**Hoàn thành khi:** có kết quả baseline và danh sách lỗi nền; mỗi bug được sửa
ở các PR sau có test tái hiện thất bại trước bản sửa.

## 3. PR1 — scheduler concurrency và timeout

### Hiện trạng cần sửa

- `src/scheduler.ts`: tick đọc cả danh sách, chờ dispatch/notify, rồi ghi lại
  snapshot cũ; có thể ghi đè CRUD diễn ra trong lúc chờ.
- `src/orchestrator.ts`, `runScheduled()`: guard busy/capacity chưa được gom
  vào đường dispatch chung; timeout chỉ nhìn trạng thái worker hiện tại.
- `src/bot.ts`: manual `/schedule run` và tick cần cùng một hợp đồng dispatch.

### Thiết kế dự kiến

Ownership đã chốt ở vòng thiết kế 1: scheduled-run module sở hữu admission,
chống chạy trùng, capacity reservation, run identity và timeout. Parsing/timezone
giữ ở `schedule.ts`; orchestrator tiếp tục sở hữu tài nguyên thực thi worker.
Phân biệt schedule với scheduled run theo [GLOSSARY.md](../GLOSSARY.md).

1. Gom dispatch thủ công/tự động qua một cổng kiểm tra quyền người tạo,
   master switch, busy và capacity. Đọc lại trạng thái cần thiết trước khi
   dispatch, không chỉ tin snapshot đầu tick.
2. Giữ reservation theo schedule trước thao tác async; tính cả lượt đang
   khởi động vào worker capacity. Dùng cơ chế capacity chung với worker thường
   để tránh hai đường cùng lấy slot cuối. Nhả reservation khi chắc chắn chưa
   dispatch hoặc đã terminal; lỗi transport sau dispatch cần recovery, không
   được mặc định coi là execution đã dừng.
3. Thay `save(list)` qua ranh giới `await` bằng cập nhật theo ID trên dữ liệu
   mới nhất. Tách runtime status khỏi cấu hình hoặc dùng revision để kết quả
   lượt cũ không ghi đè chỉnh sửa mới. Lịch đã xoá không được tạo lại.
4. Gắn timeout với `{scheduleID, sessionID, runID, deadline}`. Callback chỉ
   dừng đúng lượt còn active; huỷ timer khi terminal/stop đã xác nhận. Stop
   request hoặc purge local chưa có remote confirmation phải giữ recovery,
   không được làm mất deadline hoặc nhả ownership của lượt chưa xác minh.
5. Persist metadata tối thiểu, tương thích file cũ, để reconcile deadline sau
   restart. Lượt hết hạn được dừng/báo cáo, không tự prompt lại.
6. Nếu ghi nhận trước dispatch thất bại, không gửi prompt. PR1 giữ nguyên tắc
   an toàn này; PR3 bổ sung validation/backup đầy đủ.

### Hợp đồng hành vi đã chốt — vòng thiết kế 1

Người dùng đã đồng ý các quyết định dưới đây ngày 2026-10-27. Đây là yêu cầu
cho implementation, chưa phải hành vi đã được nghiệm thu trong mã.

- Cùng schedule chỉ có một lượt đang khởi động/chạy; lượt trùng bị từ chối
  hoặc bỏ qua với lý do rõ ràng, không xếp chồng.
- Automatic run gặp busy/capacity đầy: bỏ lượt, tiến tới mốc kế tiếp nếu có,
  không retry dồn. Manual run bị từ chối thì không thay đổi mốc định kỳ.
  Không xếp hàng hoặc tự chạy bù vì busy/capacity.
- Pause/xoá ngăn lượt chưa được nhận chạy; lượt đã nhận chạy tiếp tục cho đến
  khi complete hoặc được stop rõ ràng. Timeout của lượt đó vẫn có hiệu lực.
- `OPENCODE_TG_SCHEDULE=0` chặn mọi lượt mới, cả tự động và thủ công; không
  ngầm dừng lượt đang chạy. Dừng lượt bằng thao tác stop riêng.
- Manual run được chạy một lần trên lịch paused nếu master switch bật;
  schedule vẫn paused sau lượt đó.
- Giữ nguyên ghi nhận mốc tiếp theo trước dispatch: tránh phát lại lượt đã
  ghi nhận sau restart, nhưng có thể bỏ lượt nếu crash giữa persist và prompt.
  Nếu không xác định được prompt đã gửi hay chưa, reconcile và báo trạng thái
  không xác định, không tự gửi lại. Ưu tiên tránh thực thi trùng hơn chạy đủ lượt;
  chưa bảo đảm exactly-once.

### Hợp đồng hành vi đã chốt — vòng thiết kế 2

Người dùng đã đồng ý cả năm quyết định vòng 2; implementation và tests vẫn
chưa bắt đầu.

- **Admission:** lượt được coi là đã nhận sau khi giữ được capacity và persist
  thông tin lượt thành công, trước khi chuẩn bị session/gửi prompt. Pause/xoá
  sau thời điểm này không huỷ lượt đó. Persist lỗi thì nhả reservation, không
  gửi prompt.
- **Deadline:** tính từ admission, bao gồm chuẩn bị session và thời gian chờ
  question/permission. Restart giữ deadline cũ, không gia hạn. Hết deadline
  trong giai đoạn chuẩn bị thì không được gửi prompt muộn.
- **Manual thành công:** là lượt bổ sung, không thay mốc hoặc tiêu thụ lượt
  tự động, kể cả schedule `once`. Ví dụ manual lúc 08:55 hoàn tất trước 09:00
  không ngăn lượt tự động 09:00; muốn ngăn thì pause/xoá trước admission.
- **Session:** mỗi lượt dùng session mới. Nếu không xác nhận retire được
  session cũ thì báo lỗi, không prompt session mới và không tự retry lượt đó.
  Tạo mới/dọn session cần rollback tài nguyên phù hợp; đây không phải bảo đảm
  tại mọi thời điểm chỉ tồn tại đúng một session.
- **Capacity:** scheduled run và worker thường dùng chung giới hạn theo chat
  chính, bao gồm mọi topic; tính lượt khởi động, running và waiting, không
  tính idle. Một lượt chỉ chiếm một slot khi chuyển từ reservation sang active.

### Recovery — yêu cầu bổ sung và tương thích legacy

- **Q11, yêu cầu người dùng:** phải có cơ chế lấy lại thông tin execution,
  tìm đúng công việc đã nhận chạy và kết nối lại việc theo dõi; thông báo rõ
  từng trạng thái. Chỉ lưu trạng thái không xác định rồi chờ thụ động là chưa đủ.
  Chi tiết capability, recovery flow và các chính sách Q13–Q15 đã chốt ở
  [design-scheduled-run.md](design-scheduled-run.md).
- **Q12 đã đồng ý:** lượt đang chạy từ phiên bản cũ, thiếu run/deadline
  metadata, được giữ nguyên execution, tính busy, reconcile và cảnh báo thiếu
  timeout. Không tự kill, không gán deadline hồi tố. Lượt nhận sau nâng cấp
  bắt buộc có identity/deadline đầy đủ.

### Nghiệm thu

- [ ] Tick + manual run đồng thời chỉ tạo một lượt cho cùng schedule.
- [ ] Nhiều schedule/worker cạnh tranh slot cuối không vượt worker cap.
- [ ] Add/remove/pause/edit trong lúc dispatch không mất dữ liệu hoặc hồi sinh lịch.
- [ ] Lỗi trước dispatch nhả reservation; lỗi chưa xác nhận sau dispatch đi qua recovery.
- [ ] Timer lượt A không dừng lượt B; terminal event huỷ đúng timer.
- [ ] Restart khôi phục deadline, không tự chạy lại lượt đã ghi nhận.
- [ ] Persistence lỗi trước dispatch không tạo prompt.
- [ ] Mất kết nối tìm lại đúng lượt và khôi phục observation, không resend prompt.
- [ ] Thông báo phân biệt mất quan sát, đang tìm lại, đã nối lại và xác nhận terminal.
- [ ] Legacy active không bị kill hoặc gán deadline mới sau nâng cấp.
- [ ] Recovery giữ slot/exclusion đến khi terminal xác nhận; quá 5 phút escalation,
      tiếp tục thử mỗi phút và không spam thông báo.
- [ ] Thiếu capability recovery chặn admission mới, không consume lịch hoặc ảnh
      hưởng các chức năng bot khác; identity mâu thuẫn không stop nhầm latest.

## 4. PR2 — tests/mocks và typecheck scripts

**Phạm vi:** `scripts/`, `tsconfig*.json`, `package.json`, `.github/workflows/ci.yml`.

### Công việc

- Sửa cleanup dùng filesystem API sai, mock thiếu methods và callback parsing
  không còn khớp protocol hiện tại.
- Tạo typed test doubles dùng chung cho phần Telegram/OpenCode API thực sự
  được sử dụng; không dùng `any` hàng loạt hoặc hạ `strict` để ép pass.
- Thêm typecheck cho scripts bằng cấu hình riêng hoặc mở rộng cấu hình hiện
  tại. Việc typecheck live probes không được thực thi chúng.
- Thay smoke checks chỉ in boolean bằng assertions trả exit code khác 0.
- Dọn key `test:notes` trùng trong `package.json`.
- Phân loại tests offline và smoke/probes cần dịch vụ thật. Bổ sung tests cho
  đường command → scheduler dispatch → orchestrator.
- CI kiểm tra source và scripts, giữ tên checks hiện tại để tránh ảnh hưởng
  branch protection; xem xét trigger cho `develop` theo quy trình repository.

### Nghiệm thu

- [ ] Sai signature/API trong mocks bị bắt bởi typecheck.
- [ ] Assertion thất bại làm test/CI thất bại, không chỉ ghi log.
- [ ] Tests offline chạy không cần token, Telegram hoặc OpenCode service.
- [ ] CI chạy được typecheck source/scripts và toàn bộ suite offline.

## 5. PR3 — persistence validation, cảnh báo và backup

**Phạm vi:** `src/state.ts`, `ScheduleStore` trong `src/scheduler.ts` và fixtures.

State và schedule store hiện đã ghi file tạm rồi rename với mode `0600`.
Schedules đã có version v1 và quarantine cơ bản. Giữ các cơ chế này, bổ sung
phần thiếu thay vì viết lại toàn bộ.

### Công việc

1. Validate envelope và từng record; thêm version/migration cho state. Đọc
   được state map cũ và schedules v1, gồm metadata active run từ PR1.
2. Phân biệt file chưa tồn tại với JSON hỏng, sai schema, version không hỗ
   trợ hoặc lỗi quyền truy cập.
3. Giữ backup last-known-good đã validation. Quarantine bản lỗi với tên riêng;
   không dùng cùng một `.bak` cho cả backup tốt và dữ liệu hỏng.
4. Khi primary lỗi, thử backup hợp lệ và cảnh báo rõ. Nếu cả hai không dùng
   được, chặn thao tác ghi/dispatch liên quan thay vì tự ghi dữ liệu rỗng.
5. Bỏ silent catch khi lưu state. Xác định caller nào phải dừng hành động khi
   persist lỗi; không chỉ thêm log rồi tiếp tục hành động nguy hiểm.
6. Log có file/operation/reason; cảnh báo vận hành chống spam, không lộ token,
   prompt hoặc nội dung state. Kiểm tra lại hợp đồng durability; atomic rename
   không đồng nghĩa bảo đảm sống sót mọi tình huống mất điện.
7. Định nghĩa thứ tự commit primary/backup và quy trình restore/rollback trước
   khi ghi format mới trên dữ liệu vận hành.

### Nghiệm thu

- [ ] Migration giữ nguyên session, worker, notes, schedules và active-run metadata.
- [ ] JSON hỏng/sai schema không bị âm thầm thay bằng `{}` hoặc `[]`.
- [ ] Backup hợp lệ khôi phục được; backup hỏng không ghi đè primary hợp lệ.
- [ ] Tests bao phủ lỗi read/write/rename và file tạm do lần ghi gián đoạn.
- [ ] Lỗi persistence được báo rõ; thao tác phụ thuộc không tiếp tục như đã lưu thành công.

## 6. PR4 — chuẩn hoá session lifecycle

**Phạm vi:** `src/bot.ts`, `src/orchestrator.ts`, `src/state.ts`, `src/stream.ts`
và các adapter liên quan.

### Công việc

- Tạo luồng bind/unbind dùng chung cho `/new`, `/use`, `/clear`, browser,
  worker và schedule; chỉ tách module tối thiểu cần cho correctness.
- Mỗi turn có session/run identity. Áp dụng cho prompt completion, SSE,
  preview, timeout và cleanup; terminal events trễ không settle lượt mới.
- Khi đổi session, xử lý nhất quán turn cũ, typing, previews, forms và
  permissions. Bảo đảm bot không để task mất chủ quản một cách âm thầm.
- Guide và relay cursor thuộc session; lựa chọn model/directory/agent của
  conversation chỉ được giữ lại theo quy tắc tường minh.
- Khởi tạo recovery tracking ngay từ turn đầu; không phụ thuộc đã từng gửi
  thành công một reply trước đó. Đồng bộ lại yêu cầu pending sau reconnect.
- Dùng chung identity/deadline contract của PR1, tránh tạo hai lifecycle độc lập.

### Nghiệm thu

- [ ] `/new`, `/use`, `/clear` giữa lúc chạy không làm kết quả cũ rơi vào session mới.
- [ ] Cleanup turn cũ không xoá inflight/typing/preview của turn mới.
- [ ] Stop, reconnect và terminal event lặp/trễ có xử lý idempotent.
- [ ] Recovery sau restart bao phủ phản hồi đầu tiên và không dùng cursor session khác.
- [ ] Interactive, Manager và worker được kiểm thử riêng cho cùng hợp đồng lifecycle.

## 7. PR5 — Telegram delivery

**Phạm vi:** `src/telegram.ts`, final-reply relay trong `src/bot.ts`, persistence
cho delivery progress và tests.

### Công việc

1. Tập trung retry/rate limiting; giữ thứ tự chunks trong từng conversation
   nhưng không để một conversation chặn toàn bộ bot.
2. Tôn trọng `retry_after`; retry có giới hạn cho transport/5xx. Phân loại lỗi
   400, no-op edit, message bị xoá và lỗi parse thay vì nuốt tất cả.
3. Phân loại thao tác được phép retry. Không tự retry mù thao tác tạo topic
   hoặc side effect không an toàn khi lặp.
4. Final reply có delivery identity gắn session/message/run, danh sách chunks
   và tiến độ gửi được persist. Chỉ advance relay cursor sau khi giao đủ.
5. Sau restart, reconcile delivery đang dở trước orphan sweep để tránh hai
   đường cùng chuyển tiếp một reply. Preview/activity là best-effort, không
   đưa vào durable final-reply queue.
6. Định nghĩa retry exhaustion, thông báo lỗi và retention/cleanup cho dữ liệu
   pending để tránh loop vô hạn hoặc file tăng không giới hạn.

### Nghiệm thu

- [ ] 429/5xx/transport errors có retry đúng budget và thứ tự chunks.
- [ ] Lỗi giữa reply nhiều chunks khôi phục phần chưa xác nhận sau restart.
- [ ] Relay cursor không vượt phần đã giao; pending delivery và sweep không chạy trùng.
- [ ] Lỗi vĩnh viễn dừng retry và có trạng thái/cảnh báo có thể quan sát.
- [ ] Topic creation không bị nhân đôi bởi retry chung.

**Giới hạn:** Telegram có thể đã nhận message nhưng bot crash trước khi lưu
xác nhận. Khi phục hồi vẫn có thể gửi trùng; tài liệu vận hành phải công bố
điều này, không mô tả delivery là exactly-once.

## 8. PR6 — refactor controller và cập nhật tài liệu

### Công việc

- Tách command handlers, session lifecycle, interaction relay và delivery khỏi
  `bot.ts`; giữ controller làm router/composition layer.
- Tách scheduled-run lifecycle khỏi `orchestrator.ts` nếu ranh giới đã rõ sau
  PR1–PR5. Giữ public entrypoints và typed dependencies nhỏ.
- Di chuyển mã trong commits riêng, không trộn thêm thay đổi hành vi.
- Cập nhật README, `.env.example`, testing guide và deployment runbook: flags,
  commands, timeout, shutdown, backup/restore và delivery limitations.
- Kiểm tra graceful shutdown cho reservations, timers và pending writes;
  để lại dữ liệu phục hồi nhất quán nếu không thể drain trước deadline.

### Nghiệm thu

- [ ] Regression tests giữ nguyên kỳ vọng sau di chuyển mã.
- [ ] Commands tương thích, ngoại trừ sửa lỗi/chính sách đã chốt và được ghi rõ.
- [ ] Không có hai nguồn sự thật cho lifecycle hoặc delivery.
- [ ] Hướng dẫn cấu hình/backup/restore phản ánh format và hành vi thực tế.

## 9. Quyết định cần chốt trước khi sửa hành vi

Các quyết định scheduler vòng 1 đã chốt tại mục 3; không cần hỏi lại master
switch, overlap, pause/delete hoặc manual run trên lịch paused.

| Quyết định | Đề xuất | Chốt trước |
| --- | --- | --- |
| Chuyển session khi turn cũ đang chạy | Stop/retire turn cũ trước bind; nếu không xác nhận được thì báo lỗi, không chuyển âm thầm | PR4 |
| Không có primary/backup hợp lệ | Fail closed với thao tác phụ thuộc; giữ file lỗi để điều tra | PR3 |
| Telegram không xác định đã nhận hay chưa | Cho phép trùng khi phục hồi để ưu tiên không mất final reply | PR5 |

Các đề xuất này chưa phải bảo đảm của mã hiện tại. Ghi lại lựa chọn cuối cùng
và regression test tương ứng trong PR triển khai.

Các quyết định scheduler vòng 2 (admission, deadline, manual/once, session
retirement và capacity scope) và Q12 legacy đã chốt tại mục 3. Yêu cầu Q11
được làm rõ thành active recovery trong `design-scheduled-run.md`; Q13–Q15
về recovery kéo dài, readiness và identity mâu thuẫn cũng đã được người dùng
đồng ý. Người dùng đã chọn triển khai PR1 và duyệt ba điểm kiểm thử: module
lượt chạy, kết nối OpenCode giả lập, lệnh/nút Telegram. Các quyết định PR3–PR5
trong bảng trên không thuộc phạm vi PR1.

### Tiến độ xác minh PR1

- Baseline trước thay đổi: `npm run typecheck` và toàn bộ `npm run test:unit`
  đều đạt. Các phát hiện trong khảo sát không được tự coi là lỗi đã tái hiện.
- Đã quan sát kiểm thử thất bại rồi đạt cho mất CRUD khi dispatch chờ, admission
  trùng, deadline sau restart, mất phản hồi, stop lúc chuẩn bị, master switch,
  file metadata biến mất và nút tạo session vượt guard.
- Sau implementation: kiểm tra kiểu source, kiểm tra kiểu riêng các scripts
  PR1, toàn bộ kiểm thử offline và `git diff --check` đều đạt.
- Lần `smoke` đầu: menu, mode, sweep đạt; question relay không hiện câu hỏi dù
  tiến trình trả mã thành công. Model mặc định là `opencode/flint-40b-free`;
  phiên kiểm thử có lỗi provider transport timeout. Đã bổ sung assert cho các
  phần bắt buộc và chạy lại với model `openai/gpt-6.1-sol` (chỉ cấu hình tiến
  trình kiểm thử, không đổi model đang vận hành).
- Lần chạy lại với `openai/gpt-6.1-sol`: menu, mode, sweep và toàn bộ question
  relay (hiện câu hỏi → bấm nút → gửi đáp án → hoàn tất) đạt. Prompt đầu không
  hoàn tất trong 90 giây; lượt trả kết quả được log sau khoảng 136,7 giây. Assert
  mới làm smoke trả mã lỗi đúng thay vì báo thành công giả. Không ghi nhận toàn
  bộ smoke là đạt và không tự nới thời hạn để lấy kết quả xanh.
- Lần `smoke:scheduled-run` đầu không đạt: máy chủ OpenCode 2.1.4 tại đây
  không giữ/phát lại durable event payload, dù route có mặt và watermark tăng.
  Đã thêm hồi quy qua client thật/máy chủ giả lập và phép kiểm chứng replay tại
  readiness. `smoke:scheduled-run -- --expect-blocked` đã đạt trên máy chủ thật:
  không admission, không prompt. Chưa coi đó là kiểm thử execution recovery đạt.
- Hai phiên thử bị treo đã được xác minh đúng thư mục/đầu vào kiểm thử rồi ngắt;
  API xác nhận không còn active. Không dừng phiên làm việc của người dùng.
- Bot đang chạy vẫn giữ mã cũ trong bộ nhớ; chưa khởi động lại để áp dụng PR1.

PR1 chưa nghiệm thu tích hợp đầy đủ: cần máy chủ hỗ trợ phát lại lịch sử thực
sự. Khi triển khai mã mới lên môi trường hiện tại, các lượt lịch mới sẽ bị
chặn an toàn; các chức năng bot không phụ thuộc scheduler không bị tắt.

Người dùng đã duyệt khảo sát OpenCode riêng, chưa duyệt thay đổi máy chủ.
Kết quả có nguồn đúng tag và phương án tại
[`research-opencode-durable-history.md`](research-opencode-durable-history.md):
`events.persist:true` có ở server/SDK 2.1.4, nhưng chưa có công tắc CLI/shared
service chuẩn được xác minh; nâng lên 2.2.0 đơn thuần không bật lưu payload.

## 10. Xác minh và triển khai

- Mỗi PR: `npm run typecheck` rồi `npm run test:unit`; từ PR2, typecheck phải
  bao phủ cả scripts.
- Sau các thay đổi tích hợp: chạy `npm run smoke` sau cùng với OpenCode service
  thật. Kiểm tra đủ menu, mode picker, recovery sweep và question relay trong
  log, không chỉ exit code. Chạy smoke multi-session khi thay Manager/worker.
- Trước thay format dữ liệu: backup state, schedules và metadata liên quan;
  kiểm tra restore bằng fixtures trong môi trường cách ly, không dùng bot thứ hai.
- Sau khi triển khai source trên host systemd: restart `opencode-bot` rồi xem
  journal theo `AGENTS.md`. Không xoá state để xử lý lỗi và không chạy thêm
  `npm start` cạnh service. Không áp dụng lệnh systemd nguyên xi trên macOS.
- Nếu rollback qua schema mới: dùng đường tương thích đã kiểm thử hoặc restore
  backup phù hợp; không hạ binary một cách mù quáng lên dữ liệu mới.

**Hoàn thành toàn kế hoạch khi:** sáu PR được nghiệm thu, offline tests và
smoke tích hợp được ghi nhận kết quả, migration/restore được kiểm chứng, và
runbook nêu rõ các giới hạn crash recovery còn lại.
