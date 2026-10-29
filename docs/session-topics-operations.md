# Operating managed session topics

## Enable deliberately

1. Create a Telegram supergroup and enable Topics.
2. Add the existing bot as an administrator with **Manage Topics**.
3. Keep the operator's Telegram user ID on `TELEGRAM_ALLOWED_USER_IDS`.
4. From General, send `/setup`, then `/new` or `/spawn <name> <directory>`.

The bot verifies group type and its rights. It refuses a cutover while a legacy
General session is active. No group ID is preconfigured and no private chat is
converted automatically. Telegram autocomplete is chat-wide; contextual `/help`
and all command/button handlers enforce General versus work-topic scope.

## Normal workflow

- General: `/sessions`, `/new [title]`, `/attach <session-id>`, `/close <id>`,
  `/restore <id>`, `/sync`; session cards link to the work topic.
- `/sessions` và `/ls` mở bảng điều khiển gọn, tối đa 10 phiên/trang, có bộ lọc
  theo công việc, yêu cầu chờ, lỗi và vòng đời. Bấm tên mới mở thẻ chi tiết.
  Mỗi thẻ bảng điều khiển gắn người/nhóm, hết hạn sau 10 phút; không dùng thẻ
  của người khác. Số đang chạy/chờ chỉ tính dữ liệu đã xác minh; nguồn chưa rõ
  được ghi rõ, không suy thành hoàn tất. Bộ nhớ tạm 30 giây, làm mới từng trang,
  tối đa 2 phiên cùng lúc và thời hạn 3 giây/phiên ở giao diện.
- Thẻ chi tiết có **Xem yêu cầu đang chờ**: câu hỏi và xin quyền có từng liên
  kết đến tin gốc. Nếu tin đã mất hoặc chưa biết mã, dùng **Mở chủ đề** hoặc
  **Hiển thị lại**. Bot kiểm tra yêu cầu còn tồn tại rồi mới hiển thị lại trong
  chủ đề gốc; không trả lời, cấp quyền hoặc tạo yêu cầu OpenCode từ General.
  Lỗi truy vấn giữ trạng thái chưa rõ, không coi là hết chờ. Số lần nhắc được
  giữ nguyên; tắt nhắc vẫn lưu mã tin để điều hướng sau khi khởi động lại.
- **Gắn phiên có sẵn**, `/attach` hoặc `/use` không có mã mở danh sách chọn
  có tên. Danh sách chỉ đọc, không gửi lại thẻ của mọi phiên đã quản lý.
  Saved legacy sessions of this group are included, even outside the
  selected directory. Unowned OpenCode sessions are discovered only in the
  directory selected with `/dir` or `/browse`; other chats' sessions, archived
  sessions and child sessions are excluded. Pagination, refresh and a create-new
  button avoid requiring the operator to find or type an ID. Listing changes
  no bindings. Selection rechecks ownership and termination before attaching.
- A work topic: prompts, replies, questions, permission answers, `/stop`, history
  and session settings. Never `/new`, `/use`, `/clear`, or lifecycle management.
- Model/agent/variant settings in General are defaults for subsequent sessions.
  They do not modify a retained legacy General session.
- Closing means stop and **confirm**, archive OpenCode, then close Telegram.
  `closing` is not success. An unconfirmed execution keeps its capacity slot.
- Restoring keeps both IDs. Successful/failed/stopped turns never close a managed
  topic on their own. Each scheduled run receives a separate session and topic.
- `/manager on` opens or restores a separate Manager topic. `/manager off`
  archives it. Dispatch policy and approval cards remain in General.

### Mở phiên quản lý

Trong chế độ diễn đàn, `/manager`, tin nhắn thường ở General và danh sách
`/sessions` đều có nút **Mở phiên quản lý**. Nút này cùng `/manager on` dùng chung
một luồng: xác minh và dẫn đến chủ đề đang mở, khôi phục đúng phiên/chủ đề đã
đóng, hoặc tạo khi chưa có. Khi thành công mới hiện nút liên kết **Vào chủ đề
quản lý**. Bấm đồng thời hoặc bấm lại sau khởi động lại không tạo phiên trùng.

Phiên quản lý cũ ở General chỉ được chuyển khi đã xác nhận nghỉ; giữ nguyên mã
phiên, lịch sử, ghi chú và mốc chuyển tiếp. Cờ quản lý và tác nhân quản lý ở
General được gỡ trong cùng lần lưu liên kết. Nếu thư mục General vẫn là thư mục
phiên quản lý cũ thì bỏ mặc định đó; thư mục đã chọn khác được giữ nguyên.
Không tự dừng phiên đang chạy và không tự gửi lại yêu cầu đã nhắn ở General.

Trạng thái đang đóng, đang khôi phục, thiếu chủ đề hoặc lần tạo chưa rõ kết quả
không được coi là thành công và không được tạo phiên thay thế. Dùng `/sessions`
hoặc `/sync` để kiểm tra. Quyền gọi công cụ vẫn bị chặn đến khi liên kết mở,
cấu hình đầy đủ và sở hữu phiên được xác minh. Đồng bộ tên chủ đề dùng nút trong
`/sessions`, không cần mở phiên quản lý hay giao cho worker.

### Đồng bộ tên chủ đề theo tiêu đề OpenCode

1. Trong General, mở `/sessions` và bấm **Đồng bộ tên chủ đề** hoặc **Đồng bộ tên**
   trên thẻ phiên.
2. Kiểm tra bản xem trước có phân trang. Cột tên cũ là tên bot đã lưu, không phải
   kết quả đọc lại Telegram; tên đã sửa tay có thể khác. Tiêu đề trống giữ tên cũ;
   phiên/chủ đề chưa mở hoặc không xác minh được được ghi rõ để hoãn.
3. Bấm **Bật đồng bộ tên cho nhóm**. Xác nhận có thời hạn 10 phút, gắn với đúng
   người xem trước và đúng nhóm. Hủy hoặc khởi động lại trước khi xác nhận không
   tự bật chính sách. Mọi nhóm cũ mặc định chưa bật, kể cả sau cập nhật bot.

Sau xác nhận, OpenCode là nguồn tên chuẩn một chiều cho cả nhóm, gồm chủ đề quản
lý và các chủ đề tạo/gắn sau này. General không bị đổi tên. Bot chuẩn hóa một
dòng, tối đa 128 đơn vị UTF-16 và không cắt giữa cụm ký tự tiếng Việt/biểu tượng;
không tự thêm biểu tượng trạng thái. Nhóm chưa dùng `/setup` giữ cách đặt tên cũ.

Sự kiện V2 `session.renamed` chỉ đánh thức việc đọc metadata mới nhất, không áp
dụng tên trong payload có thể cũ. Có gộp sự kiện, kiểm tra khi khởi động/kết nối
lại và đối chiếu định kỳ 60 giây. Sửa tay tên Telegram được đưa về nguồn chuẩn
khi nhận thông báo sửa chủ đề; khởi động lại hoặc nút đồng bộ cũng có thể ép
áp dụng lại. Không có khả năng đọc lại toàn bộ tên chủ đề Telegram để phát hiện
một thông báo sửa tay đã mất; không tuyên bố bộ nhớ cục bộ là bằng chứng tên đang
hiển thị trên Telegram.

Chính sách lưu trong `__machine__.sessionTopics.titleSyncGroups`; kết quả đồng
bộ nằm ở tên liên kết, ý định/lỗi/thời điểm thử lại nằm ở `link.titleSync` và thời
gian chờ do giới hạn tần suất của nhóm ở `titleRetryAt`. Chỉ ghi tên mới sau khi
Telegram xác nhận; chỉ `TOPIC_NOT_MODIFIED` được coi là thành công không thay
đổi. Lỗi khác giữ tên đã xác nhận và hiển thị đang chờ trên thẻ phiên.

Hàng đợi tên độc lập với vòng đời, tối đa một lần ghi mỗi giây trong cùng nhóm,
tôn trọng `retry_after` và giữ thời gian chờ qua khởi động lại. Không tải lịch sử
hội thoại để đọc tên, không gọi mô hình AI, không dừng công việc hay đổi liên
kết. Chủ đề đóng chỉ được đồng bộ sau khi được mở lại bằng luồng quản lý bình
thường; đổi tên không tự mở chủ đề. Kiểm thử riêng: `npm run test:topic-titles`.

## Existing sessions

`/setup` preserves all old bindings and schedules. `/attach <id>` is explicit:

- An already managed session returns its existing topic; no duplicate is made.
- A same-group idle legacy work topic is adopted without replacing its session.
- A legacy General session gets a new work topic; ownership moves atomically.
- An active session, multiple legacy owners, or another chat's ownership is
  refused. Cross-chat migration/detachment needs a separately approved operation;
  do not delete `data/state.json` to force it.

Legacy/private chats keep their existing behavior until deliberately converted.
Do not run a second polling instance for the same bot token during a cutover.

## Pending and failed operations

Lifecycle data is versioned inside `data/state.json` under
`__machine__.sessionTopics`. Only `SessionTopics` changes managed bindings.
State and its conversation binding are committed in one atomic file replacement;
required write failures stop the operation rather than dispatching a prompt.

Cards show link ID, session ID, phase, remaining step and an error when present.
Use `/sync` or **Check pending state** for retryable close/restore failures.
Startup, reconnect and periodic reconciliation also retry those operations and
compare the native archive state. Only `SessionNotFoundError` means deletion;
network/permission failures keep the binding for inspection.

Creation is different: Telegram has no creation idempotency key or topic lookup
that proves an ambiguous creation result. Interrupted/uncertain creation remains
`attention`; it is not replayed. Native metadata `tgTopicLink` and `tgChat`, plus
the saved operation/link ID, identify owned resources for operator inspection.
Repairing an unknown topic requires explicit review; never just press a new
creation action repeatedly. Incomplete first-time configuration cannot become
runnable through reconciliation or close/restore.

Deleting a Telegram topic outside the bot does not authorize deleting its
OpenCode session, state or worktree. Such a link becomes `attention`; automatic
topic replacement and destructive cleanup are intentionally not implemented.
Legacy `/prune` and worktree-removal actions cannot erase managed history.

## Verification

```sh
npm run typecheck
npm run test:unit
npm run smoke:session-topics
npm run smoke:scheduled-run -- --expect-blocked # only for a server without replay
npm run smoke
```

The focused suite covers module operations, public Telegram routing and external
protocol adapters. The lifecycle smoke uses real OpenCode with empty owned
sessions and simulated Telegram failure; it spends no model tokens, polls no
Telegram account and does not restart the server. A real test group is still
required to verify Telegram rights, topic appearance and the complete UI.

The OpenCode durable-history limitation is separate: unsupported recovery still
blocks **scheduled admission**, not all session/topic management. No server
configuration or version is changed by this implementation.
