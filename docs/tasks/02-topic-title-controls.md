# Đầu việc 2 — Kiểm soát đồng bộ tên chủ đề

**Trạng thái:** chưa triển khai phần mở rộng. **Thứ tự:** CV05 → CV06 → CV07.
**Điều kiện bắt đầu:** CV04 đã nghiệm thu theo
[kế hoạch tổng](../plan-session-workflow-improvements.md).

## Mục tiêu và hiện trạng

Giữ cơ chế đồng bộ tên hiện có, bổ sung khả năng tắt, ngoại lệ từng chủ đề và
tên riêng do người dùng chủ động chọn. Không triển khai đồng bộ hai chiều.

Hiện `SessionTopicsData.titleSyncGroups` chỉ lưu khóa có giá trị `true`, không
chấp nhận `false`; `link.titleSync` lưu ý định/lỗi/lần thử lại. Chính sách bật
theo nhóm, chưa có ngoại lệ hoặc tên riêng. Mọi thay đổi phải đi qua
`SessionTopics`, không tạo đường gọi đổi tên cạnh tranh trong `bot.ts`.

## CV05 — Mô hình chính sách và tương thích

### Công việc

- [ ] Định nghĩa giao diện chính sách trong `SessionTopics`: công tắc tự đồng
  bộ toàn nhóm và lựa chọn theo chủ đề gồm **Theo OpenCode**, **Giữ tên hiện tại**,
  **Tên riêng**. Dữ liệu cũ không có lựa chọn thì kế thừa hành vi hiện tại.
- [ ] Chốt thứ tự ưu tiên: tắt toàn nhóm dừng mọi tự đồng bộ; khi nhóm bật,
  chỉ chủ đề chọn Theo OpenCode được tự theo tên phiên. Tên riêng/giữ tên không
  được nguồn OpenCode ghi đè. Đặt tên riêng là thao tác rõ ràng của người dùng,
  không phải tự đồng bộ ngầm khi nhóm tắt.
- [ ] Phân biệt tên mong muốn theo chính sách với tên đã được Telegram xác
  nhận, kể cả khi phản hồi đến muộn hoặc lần ghi trước chưa rõ kết quả.
- [ ] Bổ sung số phiên bản chính sách hoặc mốc tương đương để một công việc đổi
  tên cũ không xác nhận thay cho chính sách mới.
- [ ] Chọn cách lưu tương thích trước khi sửa bộ kiểm tra dữ liệu; không ghi
  `false` vào bản đồ hiện tại khi chưa nâng bộ đọc/ghi. Không bật nhóm đang tắt
  hoặc xóa thời gian chờ do giới hạn tần suất trong lúc nâng dữ liệu.
- [ ] Xác định hành vi khi quay về bản mã cũ; nếu không thể đọc dữ liệu mới,
  báo rõ giới hạn và cách khôi phục đã kiểm thử, không âm thầm bỏ trường.

### Kiểm thử và nghiệm thu

- [ ] Bảng đầy đủ giữa công tắc nhóm, lựa chọn chủ đề và dữ liệu thiếu trường.
- [ ] Đọc/ghi dữ liệu cũ; chính sách hỏng/không hỗ trợ; lỗi lưu trước thao tác ngoài.
- [ ] Không đổi `sessionID`, danh tính, vòng đời hoặc điều kiện nhận công việc.

**Tệp liên quan:** `src/session-topics.ts`, `src/state.ts`;
`scripts/test-topic-titles.ts` và dữ liệu mẫu tương thích.

## CV06 — Bật/tắt trong General và xem trạng thái

### Công việc

- [ ] Thêm trang cấu hình tên trong General với trạng thái công tắc nhóm;
  thẻ từng phiên hiển thị chế độ tên đang áp dụng.
- [ ] Bật toàn nhóm và bật lại Theo OpenCode có xem trước phạm vi đổi tên,
  xác nhận theo đúng người/nhóm, có thời hạn, giống nguyên tắc đang có.
- [ ] Tắt nhóm hoặc chuyển một chủ đề sang Giữ tên hiện tại phải lưu thành
  công trước khi báo đã tắt; hủy bộ hẹn giờ và vô hiệu hóa công việc chưa ghi.
- [ ] Hiện tên đã xác nhận, tên đang chờ nếu có, lỗi gần nhất và thời điểm thử
  lại. Không quảng cáo bản ghi cục bộ là kết quả đọc lại tên thực tế Telegram.
- [ ] Nút thử lại chỉ đổi tên theo chính sách hiện tại, không tự bật nhóm, bỏ
  ngoại lệ hoặc vượt qua thời gian chờ Telegram đã yêu cầu.
- [ ] Khi lời gọi Telegram đã được gửi trước thao tác tắt, thông báo đúng giới
  hạn: không bảo đảm rút lại lời gọi đang bay; xử lý phản hồi muộn theo CV07,
  không báo rằng mọi thao tác ngoài đã bị hủy tức thì.

### Kiểm thử và nghiệm thu

- [ ] Bấm lặp, nút cũ, tắt trong lúc chờ metadata, tắt khi đang chờ thử lại,
  tắt rồi khởi động lại đều giữ đúng chính sách.
- [ ] Người dùng/nhóm khác không dùng được bản xem trước hoặc sửa ngoại lệ.
- [ ] Thay đổi cấu hình không dừng phiên hay tự mở lại chủ đề đã đóng.

**Tệp liên quan:** `src/bot.ts`, `src/session-topics.ts`, `src/commands.ts`
nếu cần; `scripts/test-topic-title-commands.ts`, kiểm thử HTML.

## CV07 — Tên riêng và hàng đợi an toàn khi chính sách đổi

### Công việc

- [ ] Cho nhập tên riêng bằng luồng trong General có người sở hữu, nhóm,
  phiên đích và thời hạn rõ ràng; có nút Hủy. Không lấy tin nhắn trong chủ đề
  làm tên riêng ngoài ý muốn.
- [ ] Chuẩn hóa tên bằng helper hiện có: một dòng, không trống, đúng giới hạn,
  không cắt cụm ký tự. Hiển thị xem trước trước khi ghi Telegram.
- [ ] Lưu chính sách và ý định; đổi đúng chủ đề; chỉ cập nhật tên đã xác nhận
  sau thành công. Lỗi mạng/quyền giữ nguyên tên đã xác nhận và tên mong muốn.
- [ ] Đọc lại chính sách, phiên bản và danh tính sau mỗi bước chờ trước khi
  ghi. Phản hồi công việc cũ không được ghi đè tên mong muốn/chế độ mới.
- [ ] Nếu thay đổi xảy ra sau khi yêu cầu Telegram đã gửi, ghi nhận kết quả
  đã biết riêng và lên lịch áp dụng chính sách hiện tại nếu phù hợp; không lặp
  vô hạn giữa tên OpenCode và tên riêng.
- [ ] Thông báo sửa tay từ Telegram không được đổi chế độ một cách ngầm định:
  Theo OpenCode đưa về nguồn chuẩn; Giữ tên/Tên riêng không bị ép về OpenCode.
  Không tuyên bố phát hiện được thông báo đã mất khi không có cách đọc lại tên.
- [ ] Khi chọn trở lại Theo OpenCode, đọc metadata mới nhất và yêu cầu xem
  trước/xác nhận nếu sẽ ghi đè tên riêng. Không cập nhật ngược tiêu đề OpenCode.

### Kiểm thử và nghiệm thu

- [ ] Lời gọi cũ A hoàn tất sau khi đã chọn tên B; lỗi 400 khác
  `TOPIC_NOT_MODIFIED`; lỗi 429; mất phản hồi; khởi động lại giữa đổi chính sách
  và ghi tên; chủ đề đóng hoặc danh tính thay đổi trong lúc chờ.
- [ ] Hàng đợi không khóa gửi yêu cầu/trả lời câu hỏi; bộ giới hạn tần suất
  hiện có tiếp tục được tôn trọng ở mọi chế độ.
- [ ] Kiểm thử thực tế tên dài, tiếng Việt, biểu tượng và chuyển chế độ trên
  nhóm thử nghiệm; nhóm chưa bật quản lý giữ hành vi cũ.

**Tệp liên quan:** `src/session-topics.ts`, `src/bot.ts`, `src/telegram.ts`,
`src/format.ts`; mở rộng hai bộ kiểm thử tên và kiểm thử tương thích OpenCode.

## Điều kiện bàn giao nhóm tính năng

- [ ] CV05–CV07 đạt; người dùng tự tắt/bật và đặt tên riêng hoàn toàn qua nút.
- [ ] Tài liệu mô tả thứ tự ưu tiên, lời gọi đang bay, dữ liệu cũ và cách quay
  lại Theo OpenCode; không thay đổi mặc định các nhóm đã cấu hình.

**Tiếp theo:** [CV08–CV09 — Quay lại công việc](03-session-resume.md).
