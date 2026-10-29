# Design: scheduled-run ownership và recovery

- **Trạng thái:** đã được người dùng duyệt triển khai PR1; đã viết mã và đang xác minh tích hợp.
- **Cập nhật:** 2026-10-28.
- **Liên quan:** [reliability plan, PR1](plan-reliability-hardening.md#3-pr1--scheduler-concurrency-và-timeout), [glossary](../GLOSSARY.md).

## 1. Phạm vi đã chốt

Scheduled-run module sở hữu admission, same-schedule exclusion, capacity
reservation, run identity, deadline và recovery. Parsing/timezone ở
`schedule.ts`; worker execution ở orchestrator. Hợp đồng hành vi Q1–Q10 và
Q12 có một nguồn tại mục 3 của reliability plan; tài liệu này chỉ làm rõ Q11.

**Yêu cầu Q11:** lấy lại thông tin execution, có cơ chế tìm lại execution và
kết nối lại, thông báo rõ ràng. Recovery phải chủ động, không chỉ ghi
`unknown` rồi chờ. Đây là recovery observation, không phải resend prompt.

## 2. Capability đã xác minh

Đã đọc adapter và dependency `@opencode/client` 2.1.2 cài trong repository,
đối chiếu [client guide V2](https://opencode.ai/v2/docs/build/client) và
[reference V2](https://opencode.ai/v2/docs/api). Chưa gọi server thật; khi
triển khai cần kiểm tra server tương thích, không coi capability của client
là bằng chứng server vận hành đã hỗ trợ.

| Capability | Ý nghĩa và giới hạn |
| --- | --- |
| `session.get`, `session.active` | Lấy session và execution active trên process đang hỏi; session không có trong active map không tự chứng minh target run thành công |
| Client-chosen prompt message ID | Biết được identity của input trước request; không phải execution ID |
| Exact message lookup, inbox listing | Phân biệt input còn pending và message đã tồn tại; inbox vắng input không có nghĩa chưa gửi |
| `session.log({after, follow})` | Replay durable events theo sequence rồi follow; endpoint experimental, cần kiểm tra support và cursor semantics |
| Global event subscription | Live-only, không replay và không tự reconnect; reconnect subscription không lấy lại events đã mất |
| Session interrupt | Tác động execution hiện tại theo session, không có compare-and-interrupt theo execution ID |
| Inbox cancellation | Huỷ input chưa delivered; khác interrupt execution đã chạy |

Client không có execution resource/ID riêng cho get/resume/stop. Execution
events có event ID và sequence, nhưng terminal event không tham chiếu trực
tiếp prompt hoặc execution-start ID. Cần correlation từ input và timeline
của session riêng cho lượt chạy, không giả lập một server execution ID.

### Evidence trong mã hiện tại

- `src/opencode.ts:470–489, 546–550`: sinh/truyền message ID; scheduled path
  hiện không persist ID đó. Comment dedupe chưa đủ chứng minh an toàn resend.
- `src/opencode.ts:575–585`: sessionState hiện suy busy từ timestamps; không
  phải xác minh target execution qua active map và durable events.
- `src/opencode.ts:689–742`: reconnect global events và gọi reconcile callback;
  chưa expose durable log recovery.
- `src/orchestrator.ts:752–761, 775–823`: stop nuốt interrupt error, scheduled
  timer không lưu run identity/deadline; thông báo hiện có thể quá mức xác nhận.
- `node_modules/@opencode/protocol/dist/groups/session.js`: contract active,
  inbox, log, interrupt; `dist/groups/event.js`: global stream volatile.

Line references ứng với baseline khảo sát; xác minh lại khi triển khai.

## 3. Thông tin cần giữ để tìm đúng lượt

Đây là yêu cầu về bằng chứng, chưa phải schema hoặc interface cụ thể:

- Internal run identity, schedule và owner conversation.
- Admission time và deadline gốc.
- Nguồn OpenCode/server namespace; expected session/project/location.
- Exact session ID, persist trước prompt.
- Client-generated prompt message ID, persist trước HTTP request.
- Durable sequence checkpoint và các input/execution observations đã xác minh.
- Phase đã biết: preparing, admission chưa xác nhận, pending, running/waiting,
  stop requested, terminal hoặc chưa đủ bằng chứng.

URL có thể đổi port khi rediscover; directory có thể giống nhau trên hai server.
Không dùng URL, directory, topic title hoặc worker name đơn độc để thay identity.
Checkpoint durable log không dùng chung với relay timestamp/message cursor.

## 4. Recovery flow dự kiến

1. Khi startup, mất stream, request timeout hoặc stop không xác nhận: giữ
   checkpoint, thông báo mất quan sát và bắt đầu recovery cho đúng run.
2. Tìm lại đúng nguồn OpenCode. Explicit endpoint không tự fallback sang local
   server; rediscovery không được âm thầm đổi namespace dữ liệu. Không restart
   OpenCode hoặc gọi cơ chế có thể replace process chỉ để thử khôi phục stream.
3. Tìm exact session; đối chiếu exact input/message, pending inbox và durable
   timeline từ checkpoint. Không nhận execution mới nhất làm target mặc định.
4. Đọc bù đến watermark và khôi phục theo dõi. Implementation PR1 phối hợp
   lịch sử session với luồng sự kiện toàn cục hiện có và kiểm tra định kỳ;
   chưa dùng `follow=true`. Mọi sự kiện bị lỡ tiếp tục được lấy từ durable log
   ở lần kiểm tra sau, checkpoint ngăn xử lý terminal hai lần.
5. Nếu đã terminal: settle theo bằng chứng. Nếu vẫn running/waiting: theo dõi
   tiếp với deadline cũ. Nếu input còn pending và deadline đã hết: huỷ đúng
   input thay vì cho chạy muộn. Nếu target đang chạy quá hạn: yêu cầu interrupt
   chỉ khi xác minh được target vẫn sở hữu session, sau đó xác nhận terminal.
6. Không đủ bằng chứng, log unsupported, session mất hoặc phát hiện execution
   khác: không đoán success/stopped và không resend. Giữ capacity/exclusion,
   tiếp tục recovery hoặc yêu cầu can thiệp theo chính sách đã chốt ở mục 6.

Không có kết nối mạng thì không thể bảo đảm lấy thông tin ngay. Yêu cầu là
có đường tìm lại/reconnect được kiểm thử và báo trung thực mức bằng chứng,
không hứa luôn phục hồi được session bị xoá hoặc server mất dữ liệu.

## 5. Thông báo cần phân biệt

Mỗi thông báo liên quan phải chỉ rõ schedule/run, worker/topic, session, thời
điểm xác minh cuối, deadline và bước tiếp theo; không lộ auth, prompt hoặc
nội dung file. Có thể rút gọn ID trên Telegram và giữ correlation đầy đủ trong
log đã redacted.

| Tình huống | Nội dung minh hoạ |
| --- | --- |
| Mất observation | “Mất kết nối khi theo dõi lượt X; chưa xác nhận execution đã dừng. Đang tìm lại đúng session.” |
| Đã tìm lại | “Đã tìm lại lượt X: đang chạy/chờ quyền. Đã nối lại theo dõi; deadline vẫn là …” |
| Stop chưa xác nhận | “Đã yêu cầu dừng lượt X do quá hạn, nhưng chưa có xác nhận kết thúc. Đang kiểm tra lại.” |
| Terminal xác nhận | “Đã xác nhận lượt X kết thúc: thành công/thất bại/bị ngắt.” |
| Chưa đủ bằng chứng | “Chưa xác minh được lượt X vì …; không tự chạy lại. Bước tiếp theo: …” |

“Đã gửi request interrupt” không đồng nghĩa “đã dừng”. Reconnect stream cũng
không đồng nghĩa “đã tìm lại execution”. Phải chống spam và terminal duplicate.

## 6. Chính sách recovery đã chốt — Q13–Q15

Người dùng đã đồng ý cả ba quyết định ngày 2026-10-28.

### Q13 — giữ ownership và tiếp tục tìm lại

- Chưa xác nhận execution kết thúc thì giữ capacity và same-schedule exclusion;
  không nhả slot chỉ vì mất kết nối, request interrupt trả lỗi hoặc deadline đã qua.
- Reconnect/reconcile với exponential backoff có giới hạn và jitter, không loop
  nóng. Sau 5 phút liên tục chưa phục hồi, cảnh báo cần kiểm tra và chuyển sang
  tiếp tục thử mỗi phút. Đây không phải thời điểm tự bỏ ownership.
- Thông báo khi đổi trạng thái, không mỗi lần retry. Persist mốc recovery và
  trạng thái escalation để restart không reset vòng cảnh báo hoặc deadline.
- Với lỗi cần người vận hành như thiếu quyền hoặc mất bằng chứng, nêu đúng
  nguyên nhân và cách kiểm tra. Các lần reconcile tiếp theo chỉ quan sát, không
  tự resend prompt, recreate execution hoặc restart OpenCode.
- Terminal đã xác minh được settle idempotently rồi mới giải phóng ownership.

### Q14 — readiness trước nhận scheduled run mới

- Kiểm tra server đang kết nối có đủ capability/permission để nhận diện input,
  đọc lịch sử và phục hồi observation đáng tin cậy. Không dựa riêng vào client
  types hoặc version string để khẳng định server hỗ trợ.
- Thiếu capability thì chặn admission mới của scheduler, cả automatic và manual;
  báo chính xác phần thiếu. Các chức năng khác của bot vẫn hoạt động.
- Không consume lịch hoặc đánh dấu đã nhận chạy chỉ vì preflight không đạt.
  Khi readiness phục hồi, vẫn áp dụng grace/catchup đã có, không replay dồn.
- Các run đã active vẫn giữ ownership/recovery; capability thiếu không phải
  bằng chứng execution đã kết thúc.

### Q15 — mâu thuẫn identity cần can thiệp

- Nếu không xác định chắc execution hiện tại thuộc target run, không interrupt
  hoặc xoá session theo latest; chuyển sang trạng thái cần can thiệp.
- Thông báo run/session, bằng chứng cuối, nguyên nhân và bước xử lý, theo mục 5.
  Giữ slot/exclusion theo Q13, không tạo run thay thế để vượt trạng thái này.
- Reconcile có thể tiếp tục quan sát; chỉ cho phép thao tác gây thay đổi khi đã
  xác minh lại ownership. Session endpoint không có compare-and-interrupt theo
  execution ID nên phải nêu giới hạn fencing, không hứa atomic stop trước việc
  một client ngoài bot thay đổi session đồng thời.

### Các hệ quả implementation

- Active-run records phải sống độc lập với schedule configuration để pause/delete
  không làm mất identity, deadline hoặc recovery của lượt đã nhận.
- Startup phục hồi ownership trước khi mở admission mới, kể cả khi master switch
  đang OFF; OFF chặn nhận lượt mới, không xoá trách nhiệm theo dõi lượt cũ.
- Reservation → active → recovery là chuyển ownership, không cộng ba slot cho
  cùng một lượt. Worker state và scheduled-run records phải được reconcile tránh
  vừa đếm trùng vừa bỏ sót, gồm cả legacy active đã chốt ở reliability plan.
- Chưa xác nhận stop/purge từ phía execution thì việc dọn topic/state local không
  được coi là remote terminal. Mọi callback sau await phải kiểm tra lại run identity.

## 7. Regression tests cần có

- Prompt đã admitted nhưng mất response; recovery nhận đúng input, không resend.
- Mất terminal event trên global stream; log replay tìm thấy và settle một lần.
- Reconnect stream trước/sau replay không bỏ sót hoặc xử lý lặp sự kiện.
- `active()` không có target trên process mới nhưng lịch sử chưa chứng minh terminal.
- Session hoặc input không tìm thấy, log unsupported/truncated, cursor không hợp lệ.
- Pending input quá deadline được cancel; running target quá deadline được interrupt
  đúng session; mất response interrupt không bị báo thành “đã dừng”.
- Có execution/input khác trong session: không nhận nhầm latest, không stop nhầm.
- Explicit server mất kết nối không chuyển sang local server có cùng directory.
- Restart giữa recovery giữ identity, checkpoint và deadline; không cấp lại thời gian.
- Legacy active không có metadata không bị kill hoặc gán deadline hồi tố.
- Recovery quá 5 phút chỉ escalation một lần theo trạng thái, tiếp tục thử mỗi
  phút và giữ slot; restart không làm mất checkpoint hoặc spam cảnh báo.
- Readiness fail chặn automatic/manual admission mà không consume schedule;
  chức năng không liên quan của bot vẫn dùng được.
- Xoá schedule/master switch OFF trong lúc recovery không làm mất active-run
  record hoặc nhả capacity; startup không mở admission trước reconcile ownership.

Tests phải kiểm tra hành vi qua seam của scheduled-run module với execution,
clock và persistence adapters điều khiển được; giữ parsing/timezone tests hiện có.
Giữ tests cho parsing/timezone và các hành vi hữu ích hiện có; không tạo thêm
tests phụ thuộc private maps nếu có thể kiểm tra qua interface.

## 8. Implementation PR1

### Ownership và điểm kiểm thử đã được duyệt

- `src/scheduled-run.ts`: `ScheduledRuns.run`, `tick`, `recover`, `requestStop`
  là điểm vào của lượt chạy. Module sở hữu admission, deadline, recovery và
  thông báo; dependencies thực thi/thời gian được thay bằng adapters trong tests.
- `src/scheduled-observer.ts`: kiểm chứng session/input và timeline theo
  checkpoint; không coi active map vắng session hoặc outcome mới nhất là
  bằng chứng terminal của target run.
- `src/scheduler.ts`: chỉ giữ `ScheduleStore`; admission ghi cả run metadata
  và lịch tiếp theo trong cùng một lần thay file. CRUD giữ lại active runs,
  kể cả khi schedule bị xoá. Khi đã dùng run metadata, đọc lỗi phải chặn thay
  vì quarantine rồi khởi tạo rỗng.
- `src/orchestrator.ts`: thực thi qua `scheduledExecution()`, dùng capacity
  chung với worker thường; không còn đường `runScheduled()` tự tạo timer.
- `src/opencode.ts`: các thao tác dành cho scheduled run không retry prompt;
  khôi phục kết nối chỉ rediscover, không `ensure`/restart OpenCode. Adapter
  dừng theo session phải đối chiếu lại bằng chứng ngay trước thao tác. Readiness
  tạo phiên kiểm tra không có prompt, đổi tên và yêu cầu đọc lại sự kiện đổi tên;
  chỉ có OpenAPI hoặc watermark chưa đủ chứng minh khả năng khôi phục.
- `src/bot.ts`: command/callback dùng cùng admission; các thao tác thay session
  trong topic của lượt đang sở hữu bị chặn đến khi có xác nhận kết thúc.
- `StateManager.setRequired` chỉ bổ sung ghi bắt buộc cho binding mới. Validation,
  backup và thay đổi toàn bộ persistence vẫn thuộc PR3, không coi đã hoàn thành.

### Cách chạy kiểm tra

- `npm run typecheck`: source.
- `npm run test:unit`: gồm `test:scheduled-run` và hồi quy capacity của worker.
- `npm run test:scheduled-run`: lượt chạy, observer, client thật với máy chủ
  giả lập, lệnh và nút Telegram; không dùng token hoặc máy chủ OpenCode thật.
- `npm run smoke`: kiểm tra luồng bot hiện có, dùng Telegram giả lập và các
  prompt thật trong workspace tạm riêng. Kiểm tra các phần menu, mode, sweep
  và question relay trong log.
- `npm run smoke:scheduled-run`: thêm một prompt thật với agent `plan`, không
  đăng ký global events; xác nhận đọc bù execution, phản hồi và worker terminal
  từ session log. Dữ liệu nằm trong thư mục tạm, không dùng `data/state.json`
  vận hành hoặc mở Telegram polling thứ hai.
  Thêm `-- --expect-blocked` để xác minh máy chủ thiếu replay bị từ chối trước
  admission và không tạo run/gửi prompt; đây không phải kiểm thử execution đạt.

Typecheck các scripts mới được chạy riêng trong PR1; việc mở rộng cấu hình
typecheck/CI cho toàn bộ scripts vẫn thuộc PR2. Kết quả xác minh thực tế được
ghi ở reliability plan, không suy từ việc các lệnh đã được định nghĩa.

### Trở ngại từ máy chủ đã quan sát

Máy chủ tại môi trường kiểm tra báo OpenCode 2.1.4 nhưng session log chỉ trả
`log.synced`, không phát lại payload dù sequence tăng. Đã kiểm tra bằng cả
client và HTTP trực tiếp với `after=0`, không chỉ suy từ một lỗi test. Mã nguồn
upstream `packages/core/src/bus.ts` cũng có lựa chọn `persist` mặc định false;
không coi mọi máy chủ 2.1.4 đều có cấu hình giống môi trường này.

Do đó chưa thể chứng minh execution recovery trên máy chủ hiện tại. Bản PR1
phải từ chối lượt mới tại readiness, không tự hạ yêu cầu thành dựa vào active
map/latest outcome, không tự bật lưu lịch sử, sửa database hoặc restart
OpenCode ngoài phạm vi được duyệt.
