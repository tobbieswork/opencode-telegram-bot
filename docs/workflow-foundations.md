# CV00 — Mốc kiểm thử và quy ước dữ liệu

Ngày xác minh: 2026-10-29. Nhánh khởi đầu: `develop`; bản ghi trước khi chốt mốc:
`37e1685`. Người dùng đã cho phép đưa toàn bộ mã, kiểm thử và tài liệu chưa commit
của các đợt trước vào commit CV00. Không đưa thông tin xác thực, dữ liệu thật,
nhật ký hoặc thư mục phụ thuộc vào Git.

## Quy ước dùng cho các đầu việc kế tiếp

- Danh tính luôn gồm nhóm, liên kết và phiên; kiểm tra thêm nguồn, dự án và thời
  gian tạo khi đọc từ OpenCode. Tên hiển thị không phải khóa nhận diện.
- Mốc quan sát là thời gian bot đọc được dữ liệu; không phải bằng chứng bắt đầu
  hay kết thúc thực thi. Mã tin hiển thị Telegram không thay mã đầu vào OpenCode.
- Đầu vào/lượt thực thi được đối chiếu bằng mã do nguồn cung cấp nếu có; thiếu
  mã hoặc thiếu bằng chứng phải hiển thị chưa xác minh, không suy diễn hoàn tất.
- Truy vấn câu hỏi/quyền lỗi khác với truy vấn thành công cho danh sách trống.
  Không xóa câu hỏi còn chờ hoặc lịch nhắc vì lỗi mạng.
- Tên đồng bộ lỗi là một chiều hiển thị riêng, không sửa trạng thái công việc.
- Lượt lịch còn được sở hữu tiếp tục giữ dung lượng và hạn chót cũ; việc mở
  danh sách/tóm tắt không được thay đổi chủ sở hữu hoặc gửi lại yêu cầu.
- Dữ liệu chỉ đọc có thể cũ nhưng phải ghi rõ độ mới. Các hành động ghi phải
  đọc lại quyền, danh tính, vòng đời và chính sách trước thao tác ngoài.

## Dữ liệu và công cụ kiểm thử

`scripts/fixtures/workflow.ts` cung cấp:

- Hai nhóm được quản lý, có phiên trùng tên, và một nhóm chưa bật quản lý.
- Phiên rảnh, đang chạy, chờ câu hỏi/quyền, đã đóng, cần can thiệp và lỗi tên.
- Lượt lịch đang khôi phục, chưa có bằng chứng kết thúc, còn hạn chót gốc.
- Hai yêu cầu khác loại trong cùng phiên, có mã tin Telegram và lịch nhắc.
- Đồng hồ/bộ hẹn giờ điều khiển được và lời hứa cho hoàn thành chủ động.

`scripts/test-workflow-foundations.ts` kiểm tra lệnh `/sessions` qua
`Bot.handle` không gọi thao tác thay tài nguyên hoặc sửa liên kết/lịch nhắc;
phiên bản trạng thái không hỗ trợ bị chặn qua giao diện `SessionTopics` mà vẫn
giữ nguyên tệp. Dữ liệu mẫu không đọc tệp trạng thái hoặc bí mật của bot thật.

Các kiểm thử công khai đang có tiếp tục bao phủ sở hữu, đóng có xác nhận, nhận
công việc dùng chung, HTML Telegram, phục hồi lượt lịch và đồng bộ tên.

## Xác minh và triển khai

- `npm run typecheck`, `npm run test:unit`: đạt trên mã nền và bộ dữ liệu mới.
- Các kiểm thử đầu-cuối chạy sau kiểm thử nhanh, đọc đủ phần menu, chế độ,
  chuyển tiếp phản hồi bị bỏ lỡ và câu hỏi trước khi bàn giao bản mã.
- `.env`, `data/state.json`, `node_modules` được Git bỏ qua; rà soát thêm các tệp
  mới trước khi tạo commit. Không dùng xóa trạng thái hoặc đặt lại Git để chốt mốc.
- `npm run restart:local -- --check` xác minh đúng bot, tài khoản, thư mục và
  tệp trạng thái mà chưa khởi động lại. `npm run restart:local` dành cho macOS,
  dừng tiến trình cũ trước khi chạy lại, kiểm tra chỉ một bot, không lỗi 409 và
  giữ nguyên liên kết. Linux tiếp tục dùng dịch vụ systemd đã cấu hình.

Tiến độ commit và kiểm thử: [workflow-progress.md](workflow-progress.md).
