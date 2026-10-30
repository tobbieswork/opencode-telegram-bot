# Hồ sơ nghiệm thu CV15 — 30/10/2026

## Phạm vi

CV00–CV14 đã có commit riêng và lần khởi động lại được ghi trong
[tiến độ](workflow-progress.md). CV15 khóa kiểm thử xuyên suốt, tài liệu và
hai sửa lỗi tìm được khi nghiệm thu. Không coi kế hoạch ổn định cũ đã hoàn tất.

Người dùng chọn **một chủ đề thử trong nhóm hiện có**, không thử bật/tắt chính
sách toàn nhóm. Chỉ một phiên/chủ đề CV15 được tạo qua nút lệnh chuẩn trong
General; không mở bot polling thứ hai hoặc dùng một StateManager khác để ghi
đè trạng thái của bot đang chạy. Không xóa phiên thử/hay lịch sử để dọn.

## Bằng chứng tự động

| Ca | Đường kiểm thử và bằng chứng |
| --- | --- |
| Xuyên suốt | `scripts/test-workflow-acceptance.ts`: Bot.handle tạo → 1 yêu cầu → form → Đang chờ bạn → trả lời đúng thẻ/chủ đề → kết quả → tóm tắt → tìm/ghim → đóng/mở đúng SID/conv, không tự gửi thêm |
| Tên/chính sách/khởi động | Bộ `test:topic-titles`: ngoại lệ giữ/custom, phản hồi A tới muộn sau B, nhóm tắt, dữ liệu cũ, 429, restart và lỗi lưu; probe `smoke:session-topics` đọc metadata và nhận session.renamed OpenCode thật |
| Thông báo/giờ | `test-notification-queue.ts`, `test-notification-time.ts`: gộp có hạn, câu hỏi đã giải quyết, hai nhóm, 429, lỗi trước/sau HTTP, unknown, edit đã biết mã, restart, giờ mùa và đổi chính sách lúc hoãn |
| Quyền/phạm vi | Bộ workflow/manager/title/resume/pin: hai nhóm/hai người, nút/thẻ hết hạn/sai người/sai nhóm, đổi danh tính và nguồn lỗi không lộ dữ liệu hoặc tự chạy |
| Dữ liệu/khôi phục | Lỗi ghi, kho cũ/hỏng/phiên bản chưa hỗ trợ, lifecycleRevision, thẻ trước restart và lượt lịch còn sở hữu đều được chặn đúng nguồn; không tự phát lại prompt |
| Quy mô | `test-workflow-scale.ts`: 1.000 liên kết, đọc cục bộ 138 ms, tìm/đọc ghim 8 ms trong lượt đo; chỉ 10 lời đọc nguồn cho trang, tối đa 2 đồng thời; không ghi trạng thái |
| Không tự mở dịch vụ | `test-opencode-existing-only.ts`: allowStart:false không gọi Service.ensure khi khám phá không có dịch vụ |
| Hồi quy nhập tin kế tiếp | `test-general-input-next-message.ts`: gửi bình thường sau Tìm đi đúng luồng; không lấy tin người khác/chủ đề khác/trả lời tin khác; TTL, Hủy và luồng mới thay luồng cũ |

Chạy kiểm tra kiểu và toàn bộ đơn vị trước; `npm run smoke` cuối. Đã đọc từng
phần menu, chọn chế độ, out-of-band sweep và question relay, không chỉ mã thoát.
Smoke dùng OpenCode thật và Telegram cô lập; không coi đó là thử thiết bị thật.

## Bằng chứng Telegram/OpenCode thật

Chủ đề thử 559, liên kết `5a4c2bffbabc4d9e`. Một đầu vào
`msg_18b7a490a001P8QjJCYHjnkkMy` cho câu hỏi A/B, thẻ tin 566. Người dùng xác
nhận đi từ General/Đang chờ bạn đến đúng thẻ, chọn A; trạng thái nguồn đã hết
form và kết quả ghép đúng input là `CV15_OK A`, không có đầu vào mới sau mở lại.

- Đóng/mở thật giữ nguyên SID/conv, `lifecycleRevision` tăng tới 5.
- Ghim thật đã lưu ở một danh sách người dùng; đổi tên và đóng/mở không mất.
- Tên riêng `<A>` và biểu tượng được Telegram xác nhận. Ca chuỗi dài được rút
  đúng **128 đơn vị UTF-16**, `pending:false`, không có lỗi; ghim vẫn còn.
- `verify-live-workflow-test.ts <link-id> --rename-opencode` kiểm tra đúng
  source/project/birth, phiên thử nghỉ, không còn form/quyền; đổi metadata tên
  **chỉ phiên thử**, nhận session.renamed thật, tên riêng không bị đè rồi phục
  hồi tên OpenCode ban đầu. Không gửi prompt/khởi động dịch vụ khác.
- Đã khởi động bản nghiệm thu để thử lại lỗi tìm; giữ nguyên 7 liên kết, đúng
  tài khoản/tệp trạng thái, một bot và không lỗi polling 409. Lần chốt cuối
  ghi bằng biên nhận triển khai, không lấy PID/nhật ký cũ làm chứng cứ mới.

**Không thử trên nhóm thật:** bật/tắt tên/giờ/bản tin toàn nhóm, nhiều phiên
đồng loạt hoặc hai tài khoản thật. Các ca đó có kiểm thử cô lập, không được ghi
thành đã thử thiết bị thật. Không tự bật chính sách để đạt bảng kiểm.

## Lỗi phát hiện và sửa trong CV15

1. Bộ lọc URL của outbox từ chối dạng chính thức `t.me/c/channel/message?thread=topic`
   do helper câu hỏi tạo. Thẻ gốc vẫn tới chủ đề nhưng bản tin General bị bỏ.
   Ca xuyên suốt nay kiểm tra URL thật đi vào queue; chỉ mở rộng dạng URL hợp lệ.
2. Bấm Tìm rồi gõ tin kế tiếp trả nhầm hướng dẫn mở Manager: chỉ nhánh Reply
   được nhận. Đã có ca đỏ tại Bot.handle, sửa nhận tin kế tiếp đúng người/General
   hoặc Reply đúng tin. Chỉ một luồng nhập/người/nhóm; không lấy lệnh hoặc tin
   đang trả lời nơi khác. Người dùng đã thử lại tìm thành công trên bot thật.
3. Ghim khó tìm trên thẻ chung: vẫn có bước mở thẻ cá nhân để khóa người dùng;
   thẻ do người dùng tạo/mở/khôi phục có Ghim/Bỏ ghim trực tiếp. Thẻ nền không
   biết người xem giữ lối mở cá nhân, không cho người khác sửa danh sách cũ.

## Phạm vi commit và mã chạy

Người dùng yêu cầu giữ riêng sửa đổi song song về **không tự kiểm tra phiên
đã đóng** (`src/session-topics.ts`, các test và phần `/sync` trong `src/bot.ts`).
Chúng không thuộc commit CV15. Phần CV15 được xuất từ index ra bản cô lập để
kiểm tra riêng, không sửa hoặc bỏ các thay đổi của phiên khác.

Người dùng cho phép khởi động lại từ thư mục hiện có sau kiểm thử, biết rằng
tsx sẽ nạp cả phần song song còn chưa commit. Biên nhận triển khai ghi rõ các
tệp bẩn; không mô tả bot đang chạy chỉ một commit sạch. Không đổi cấu hình
nhóm để phù hợp một bản mã hoặc xóa dữ liệu khi quay mã.
