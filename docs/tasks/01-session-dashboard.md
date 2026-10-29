# Đầu việc 1 — Bảng điều khiển và danh sách Đang chờ bạn

**Trạng thái:** CV01–CV03 đã triển khai; CV04 chưa triển khai.
**Thứ tự:** CV01 → CV02 → CV03 → CV04.
**Điều kiện bắt đầu:** CV00 trong [kế hoạch tổng](../plan-session-workflow-improvements.md).

## Mục tiêu và phạm vi

Người dùng mở General và biết phiên nào đang cần mình mà không phải mở từng
chủ đề. Giữ nguyên khả năng tìm/gắn phiên cũ của `/sessions`, nhưng tách nó khỏi
danh sách phiên đã quản lý để không trộn hai hành động khác nhau.

Hiện `showSessionTopics()` gửi một thẻ cho mỗi liên kết ở trang đầu rồi mới gửi
danh sách chọn phiên chưa gắn. `pendingPrompts` có mã yêu cầu, loại, mốc nhắc và
mã tin Telegram; các bộ nhớ câu hỏi/quyền đang hoạt động còn nằm trong `bot.ts`.

## CV01 — Mô hình đọc trạng thái và độ mới dữ liệu

### Công việc

- [x] Thiết kế module đọc danh sách phiên theo nhóm; vị trí dự kiến
  `src/session-dashboard.ts`. Module chỉ đọc, không sở hữu liên kết hoặc điều
  kiện nhận công việc.
- [x] Kết hợp liên kết từ `SessionTopics`, thông tin hội thoại, tác vụ, câu
  hỏi/quyền và dữ liệu OpenCode đã đối chiếu; không coi một trường cục bộ là
  nguồn đúng tuyệt đối cho mọi chiều trạng thái.
- [x] Tách rõ: vòng đời; thực thi; chờ người dùng; lỗi đồng bộ tên; độ mới dữ
  liệu. Có trạng thái **Chưa xác minh**, kèm mốc kiểm tra và lý do khi cần.
- [x] Quy tắc chờ người dùng dựa trên câu hỏi/quyền còn tồn tại. Truy vấn lỗi
  giữ trạng thái chưa rõ; chỉ danh sách lấy thành công mới chứng minh yêu cầu
  đã biến mất. Không dùng `waiting` của tác vụ để suy ra một câu hỏi cụ thể.
- [x] Đọc nhanh từ dữ liệu đã biết; làm mới có giới hạn số lời gọi đồng thời,
  thời hạn và bộ nhớ tạm. Không gọi `topicSession()` cho mọi phiên ở mỗi lần bấm
  bộ lọc, vì lời gọi đó hiện tải nhiều nguồn dữ liệu.
- [x] Mỗi hàng có mã nhóm, liên kết, phiên và mốc quan sát để phía hiển thị
  không tự ghép hoặc đoán lại danh tính.

### Kiểm thử và nghiệm thu

- [x] Dữ liệu cũ, mất sự kiện và lỗi đối chiếu không tạo trạng thái hoàn tất giả.
- [x] Hai nhóm có cùng tên phiên không dùng chung dữ liệu.
- [x] Đọc danh sách không mở/đóng phiên, gửi yêu cầu, đổi tên hay thay mốc nhắc.
- [x] Lỗi đồng bộ tên không biến công việc thành thất bại.

**Tệp liên quan:** `src/session-topics.ts`, `src/state.ts`, `src/opencode.ts`,
`src/bot.ts`. Kiểm thử dự kiến: `scripts/test-session-dashboard.ts`.

## CV02 — Bảng điều khiển gọn, bộ lọc và phân trang

### Công việc

- [x] Nâng cấp `/sessions` thành điểm vào có hai phần rõ ràng: **Phiên đang
  quản lý** và **Gắn phiên có sẵn**. Giữ các bí danh/lối vào đang có.
- [x] Thêm bộ lọc **Tất cả**, **Đang chờ bạn**, **Đang chạy**, **Gặp lỗi**,
  **Đã đóng**; **Tất cả** vẫn cho thấy các phiên chưa xác minh/cần can thiệp.
- [x] Mỗi hàng hiển thị tên, thư mục rút gọn, trạng thái theo các chiều cần
  thiết và mốc hoạt động; xem chi tiết mới mở thẻ đầy đủ.
- [x] Hiển thị số lượng theo bộ lọc và phân trang tối đa 10 phiên/trang; không
  gửi lại hàng loạt thẻ ở mỗi lần mở danh sách.
- [x] Quy định thứ tự ổn định: chờ người dùng trước, sau đó mốc hoạt động và
  mã liên kết để phân xử. Lưu bộ lọc/trang gắn với đúng thẻ, không dùng một biến
  toàn cục khiến người này đổi giao diện của người khác ngoài ý muốn.
- [x] Nút làm mới kiểm tra lại quyền và phạm vi. Khi dữ liệu thay đổi giữa hai
  trang, đưa trang về phạm vi hợp lệ hoặc yêu cầu làm mới, không rơi sang nhóm khác.
- [x] Trạng thái trống/lỗi vẫn có đường quay lại, làm mới và tạo/gắn phiên theo
  quyền hiện tại; không yêu cầu người dùng nhập mã phiên.

### Kiểm thử và nghiệm thu

- [x] Đủ dữ liệu 0, 1, 10, 11 và nhiều phiên; số lượng và phân trang nhất quán.
- [x] Các lối vào `/sessions`, `/ls`, `/attach`, `/use` không có mã vẫn hoạt động
  đúng hoặc dẫn rõ ràng đến phần chọn phiên tương ứng.
- [x] Gắn phiên vẫn qua `SessionTopics.attach`, kiểm tra lại danh tính/quyền và
  điều kiện nghỉ; không gắn phiên ngay khi chỉ xem danh sách.
- [x] Kiểm thử qua `Bot.handle` và adapter Telegram thật với máy chủ giả lập
  kiểm tra HTML và kích thước dữ liệu nút.

**Tệp liên quan:** `src/bot.ts`, `src/commands.ts`; mở rộng
`scripts/test-session-picker.ts`, `scripts/test-session-topic-commands.ts`,
`scripts/test-telegram-command-html.ts` và kiểm thử bảng điều khiển.

## CV03 — Danh sách Đang chờ bạn và liên kết đến yêu cầu

### Công việc

- [x] Tạo hàng đọc cho từng câu hỏi/quyền: loại, tên phiên, mốc xuất hiện, mốc
  xác minh và mã tin Telegram nếu biết. Một phiên có nhiều yêu cầu phải có thể
  xem đủ, không ghi đè yêu cầu này bằng yêu cầu khác.
- [ ] Thêm nút **Đến câu hỏi** hoặc **Đến yêu cầu cấp quyền**. Dùng mã tin đã
  lưu; kiểm tra đường dẫn trên nhóm thử nghiệm. Nếu chưa có/đã mất tin, chỉ dẫn
  đến chủ đề và ghi rõ không tìm được thẻ gốc.

  Đã triển khai và kiểm thử giao thức theo tài liệu chính thức
  <https://core.telegram.org/api/links#message-links>, dùng dạng
  `https://t.me/c/<nhóm>/<tin>?thread=<chủ-đề>`. Phần thử mở trên thiết bị
  Telegram thật chưa nghiệm thu; thực hiện ở CV15 trên nhóm thử nghiệm được phép.

- [x] Nếu cần hiển thị lại thẻ, dùng luồng câu hỏi/quyền hiện có ở đúng chủ đề;
  không tạo yêu cầu OpenCode mới hoặc cấp quyền trực tiếp từ General.
- [x] Khi yêu cầu được trả lời/hủy từ nơi khác, làm mới danh sách để bỏ hoặc
  đánh dấu đã giải quyết. Nút cũ không được trả lời thay cho yêu cầu mới.
- [x] Sau khởi động lại, đối chiếu với OpenCode trước khi khẳng định còn chờ;
  không coi bộ nhớ trong tiến trình là toàn bộ danh sách.

### Kiểm thử và nghiệm thu

- [x] Đồng thời có câu hỏi và xin quyền; yêu cầu được giải quyết ngoài Telegram;
  mất tin gốc; phiên đóng trong lúc làm mới; lỗi truy vấn một loại yêu cầu.
- [x] Không trả lời, cấp quyền, mở lại hoặc tạo phiên do bấm nút điều hướng.
- [x] Quy tắc một câu hỏi mỗi lần và quy tắc xin quyền hiện tại không thay đổi.

Kiểm thử thêm: thẻ câu hỏi gắn chỉ số trường, không dùng lựa chọn của câu trước
cho câu sau; câu hỏi/quyền được kiểm tra nguồn trước khi trả lời và bị chặn nếu
dùng ở chủ đề khác. Tắt nhắc vẫn lưu mã tin; hiển thị lại giữ số lần nhắc đã có.
Đang nhập câu trả lời nhiều trường vẫn là trạng thái trong tiến trình như trước;
tài liệu không cam kết giữ các câu trả lời chưa gửi qua lần khởi động lại.

**Tệp liên quan:** `src/bot.ts` tại các luồng câu hỏi/quyền, đối chiếu và nhắc;
`src/state.ts`, `src/telegram.ts`. Kiểm thử dự kiến:
`scripts/test-pending-actions.ts`, cùng kiểm thử chuyển tiếp câu hỏi hiện có.

## CV04 — Yêu cầu và kết quả gần nhất có nguồn đối chiếu

### Công việc

- [ ] Bổ sung bản ghi hoạt động nhỏ theo đúng phiên: đoạn yêu cầu gần nhất,
  đoạn kết quả đã có, mã đầu vào/lượt thực thi nếu có, thời gian và nguồn.
- [ ] Không lấy `WorkerInfo.task` làm yêu cầu mới nhất; không coi `msgIndex`
  phục vụ phản ứng biểu tượng là lịch sử bền vững vì nó bị cắt theo giới hạn.
- [ ] Chỉ cập nhật kết quả cho đúng đầu vào/lượt đã quan sát; không để phản hồi
  muộn của lượt A ghi đè thông tin lượt B. Thiếu bằng chứng thì ghi chưa rõ.
- [ ] Giới hạn từng đoạn và tổng kích thước; không lưu thêm toàn bộ hội thoại,
  đầu vào công cụ hoặc dữ liệu nhạy cảm không cần hiển thị trong General.
- [ ] Lưu qua `StateManager`, tương thích dữ liệu thiếu bản ghi mới. Với phiên
  cũ, không tự tải toàn bộ lịch sử để lấp dữ liệu; chỉ bổ sung khi được quan sát
  hoặc khi người dùng mở chi tiết với truy vấn có giới hạn.
- [ ] Đưa các đoạn và mốc dữ liệu vào thẻ chi tiết; đây là dữ liệu đầu vào dùng
  chung cho tóm tắt quay lại và tìm kiếm ở các đầu việc sau.

### Kiểm thử và nghiệm thu

- [ ] Yêu cầu từ chủ đề, từ phiên quản lý, từ lượt lịch và thay đổi ngoài
  Telegram không bị gán nhầm nguồn. Nguồn không quan sát được phải ghi rõ.
- [ ] Khởi động lại, ghi lỗi, phản hồi muộn và dữ liệu quá dài không làm mất
  liên kết hoặc thay đổi trạng thái nhận công việc.
- [ ] Không xuất hiện nội dung phiên khác nhóm trong bản ghi hoặc giao diện.

**Tệp liên quan:** `src/state.ts`, `src/bot.ts`, `src/orchestrator.ts`,
`src/opencode.ts`; kiểm thử bản ghi hoạt động và dữ liệu lưu cũ/mới.

## Điều kiện bàn giao nhóm tính năng

- [ ] CV01–CV04 đạt; `/sessions` vẫn tìm/gắn được phiên cũ như trước.
- [ ] Danh sách Đang chờ bạn dùng được hoàn toàn qua nút Telegram.
- [ ] Cập nhật hướng dẫn và ghi rõ độ trễ làm mới, giới hạn dữ liệu đã biết.

**Tiếp theo:** [CV05–CV07 — Kiểm soát tên chủ đề](02-topic-title-controls.md).
