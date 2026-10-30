# Đầu việc 4 — Thông báo ít nhưng đúng lúc

**Trạng thái:** CV10–CV12 đã triển khai và kiểm thử tự động; thử nhóm/thiết bị ở CV15. **Thứ tự:** CV10 → CV11 → CV12.
**Điều kiện bắt đầu:** CV09 đạt kiểm thử tự động; thử thiết bị thật giữ ở CV15 theo
[kế hoạch tổng](../plan-session-workflow-improvements.md).

## Mục tiêu và phạm vi

Giảm thông báo chủ động bị trùng hoặc quá dày, nhưng không che mất câu hỏi,
xin quyền và lỗi cần người dùng xử lý. Không thay đổi việc trả lời trực tiếp
trong chủ đề, không trì hoãn câu trả lời cho một nút/lệnh đang được người dùng
thực hiện và không làm thay đổi hạn chót của công việc.

Hiện lời nhắc tăng khoảng cách theo số lần gửi, có giới hạn và được lưu trong
`pendingPrompts`. `queueReport()` trong bộ điều phối gom báo cáo gửi cho phiên
quản lý; đó là luồng đầu vào của mô hình, **không phải** hàng đợi thông báo cho
người dùng và không được tái sử dụng với tác dụng phụ đó.

## CV10 — Phân loại và chính sách gửi thông báo

### Công việc

- [x] Lập bảng nguồn phát: câu hỏi, xin quyền, lỗi không thể tiếp tục, kết thúc
  công việc, nhắc lại yêu cầu đang chờ, thông báo vận hành và tiến độ thông thường.
- [x] Phân biệt nội dung trực tiếp ở chủ đề với thông báo nhắc ở General.
  Tóm tắt General ưu tiên tên phiên, trạng thái và đường dẫn, không chép toàn bộ
  câu trả lời hoặc nội dung công cụ vào nhóm quản lý.
- [x] Thiết kế module quyết định gửi/gộp/hoãn/bỏ, vị trí dự kiến
  `src/notifications.ts`; nhận phụ thuộc đồng hồ, lưu trữ và giao tin. Các nơi
  phát sự kiện không tự triển khai lại quy tắc.
- [x] Mỗi thông báo có nhóm, phiên, loại, mã yêu cầu/lượt thực thi nếu biết,
  mốc phát sinh và đường dẫn; dữ liệu thiếu định danh không được gộp nhầm vào
  công việc khác chỉ vì cùng tên phiên.
- [x] Đặt mặc định tương thích: không tự bật giờ yên lặng hoặc đổi cách nhận
  thông báo của nhóm cũ khi cập nhật mã. Các chính sách mới có bản xem trước.
- [x] Phân loại mức khẩn theo quy tắc xác định, không nhờ mô hình tự quyết.
  Mặc định đề xuất: câu hỏi/quyền/lỗi chặn việc được báo ngay; tiến độ và hoàn
  tất có thể gộp. Cho người dùng xem rõ quy tắc trước khi bật.

### Kiểm thử và nghiệm thu

- [x] Có bảng kiểm thử cho mọi loại và chế độ; kiểm tra thứ tự ưu tiên.
- [x] Không hoãn trả lời trực tiếp, không gửi dữ liệu khác nhóm, không tạo
  yêu cầu mô hình do phân loại hoặc gom thông báo.
- [x] Thông báo lỗi đặt tên không bị nâng thành lỗi thực thi.

| Loại | Nguồn gốc và định danh | Đầu ra trực tiếp hiện có | Thông báo General khi bật ở CV11 |
| --- | --- | --- | --- |
| Câu hỏi | Bộ chuyển tiếp form; mã form | Thẻ câu hỏi ở chủ đề | Ngay; tên/trạng thái/liên kết, không chép nội dung |
| Xin quyền | Bộ chuyển tiếp permission; mã request | Thẻ xin quyền ở chủ đề | Ngay; không cấp quyền thay người dùng |
| Lỗi chặn | Kết quả đúng mã đầu vào đã đối chiếu | Lỗi/kết quả ở chủ đề | Ngay; không suy từ sự kiện chỉ có sessionID |
| Hoàn tất | Kết quả đúng mã đầu vào hoặc chủ sở hữu lượt lịch | Phản hồi chuyển tiếp cũ | Gộp tóm lược, không chuyển tiếp lại phản hồi |
| Nhắc lại | `pendingPrompts`, mã request và số lần nhắc | Cơ chế nhắc hiện có | Không đặt lại ngân sách; CV12 tích hợp hoãn |
| Vận hành | Sự kiện vận hành có mã thao tác nếu biết | Cảnh báo vận hành hiện có | Gộp theo chính sách, không gọi phiên quản lý |
| Tiến độ | Tín hiệu tiến độ | Bản tiến độ ở chủ đề | Không thêm bản General |
| Lỗi tên | `SessionTopics.titleSync` | Trạng thái tên trên thẻ phiên | Mức riêng, không đổi thành lỗi thực thi |

`src/notifications.ts` sở hữu hợp đồng sự kiện, quyết định và chính sách phiên
bản 1; nhận kho, đồng hồ và cổng giao tin. CV10 chỉ thêm tầng phân loại và trang
**Quy tắc thông báo General**, chưa chuyển các đầu ra cũ sang hàng đợi chưa có.
CV11 tích hợp giao tin; CV12 bổ sung giờ yên lặng và nhắc. Mặc định `enabled=false`,
không có giờ yên lặng tự bật. Chưa có nút bật ở CV10 để tránh áp dụng nửa luồng.

Khóa gồm nhóm, chủ đề, phiên, dấu danh tính, loại và tham chiếu/số lần nếu có;
thiếu tham chiếu thì dùng mã ý định riêng, không gộp theo tên hoặc giờ SSE.
Nội dung trực tiếp được phân loại trước khi đọc chính sách, nên cấu hình mới
không được cản câu trả lời của thao tác người dùng. Không dùng `queueReport()`
làm hàng đợi người dùng. Kiểm thử bảng: `scripts/test-notifications.ts`.

**Tệp liên quan:** `src/bot.ts`, `src/orchestrator.ts`, `src/reminders.ts`,
`src/state.ts`; kiểm thử dự kiến: `scripts/test-notifications.ts`.

## CV11 — Hàng đợi bền vững và gộp kết quả

### Công việc

- [x] Lưu ý định thông báo tối thiểu, khóa chống lặp theo nguồn và trạng thái
  giao tin qua `StateManager`. Giới hạn số lượng, thời gian lưu và kích thước.
- [x] Gộp các báo cáo hoàn tất cùng nhóm trong một khoảng ngắn có giới hạn tối
  đa; công việc phát sinh liên tục không được hoãn bản tin vô hạn.
- [x] Trước khi gửi lại câu hỏi/quyền, kiểm tra nó còn hợp lệ. Đã trả lời, hủy,
  mất quyền sở hữu hoặc không còn thuộc phiên đó thì không gửi nút cũ.
- [x] Giới hạn số lời gọi đồng thời và tôn trọng `retry_after`; một nhóm lỗi
  không làm nghẽn mọi nhóm. Hỗ trợ chỉnh sửa tin nhắn đã biết thay vì tạo bản
  trùng khi đó là thao tác lặp an toàn.
- [x] Xử lý mất phản hồi trung thực: có thể Telegram đã nhận dù bot chưa ghi
  được mã tin. Giữ trạng thái chưa xác nhận, không đánh dấu đã gửi hoặc hứa chỉ
  gửi một lần. Quy tắc thử lại phải được ghi rõ theo loại thao tác; không tự
  gửi lại mù quáng tin mới có kết quả không rõ.
- [x] Khi khởi động lại, khôi phục phần chưa xử lý nhưng không phát lại toàn
  bộ thông báo cũ. Dọn dữ liệu chỉ sau trạng thái cuối hoặc hết thời gian lưu
  đã quy định; không xóa một câu hỏi còn chờ chỉ vì đã hết lượt nhắc.
- [x] Giữ luồng chuyển tiếp câu trả lời hiện có với `lastRelayedTime`; không
  cùng gửi một kết quả từ cả hàng đợi mới và bộ chuyển tiếp cũ.
- [x] Đối chiếu phạm vi với phần giao tin trong
  [kế hoạch ổn định](../plan-reliability-hardening.md); chỉ dùng chung phần đã
  chứng minh có cùng trách nhiệm, không coi toàn bộ phần đó đã được giải quyết.

### Kiểm thử và nghiệm thu

- [x] Sự kiện trùng; hai lượt cùng phiên; nhiều nhóm; 429; lỗi ghi trước/sau
  gửi; mất phản hồi; khởi động lại; câu hỏi đã giải quyết khi thông báo đang chờ.
- [x] Dòng sự kiện liên tục vẫn có bản tin trong hạn tối đa đã chọn.
- [x] Không mất lời nhắc đang chờ hoặc đặt lại ngân sách nhắc sau khởi động lại.

Hàng đợi phiên bản 1 ở mục General của `StateManager`: tối đa 500 ý định,
hạn giữ 7 ngày; từ chối sự kiện gốc quá hạn thay vì coi kết nối lại là sự kiện
mới. Gộp 5 giây từ mục đầu, tối đa 8 mục/tin; không trượt hạn khi có dòng mới.
Hai nhóm được xét đồng thời, quay vòng; một nhóm lỗi không chặn nhóm khác.
Bật riêng có xem trước gắn người/nhóm/mốc 10 phút, mặc định vẫn tắt.

Lưu `sending` trước HTTP. Thành công cần mã tin dương và lưu xác nhận. 429
chờ đúng `retry_after` của nhóm; 4xx khác dừng ở lỗi. Mất mạng/5xx/hết thời gian
khi tạo tin giữ `unknown`, không tự gửi mới. Khởi động gặp `sending` cũng giữ
chưa rõ. **Kiểm tra/sửa tin đã biết** chỉ xếp edit theo mã tin đã biết, kiểm
tra lại nguồn; no-op edit hợp lệ. Không biết mã thì kiểm tra bảng điều khiển,
không phát lại bản tin. Không bảo đảm chống trùng khi mất cả kho/bản ghi.

Đọc lại danh tính/quyền sở hữu và danh sách form/permission trước gửi; nội
dung chỉ tên/trạng thái/đường dẫn, không mang nút cấp quyền cũ. Kết quả chỉ
phát từ phản hồi ghép đúng input, không suy từ SSE chỉ có sessionID. Lỗi tên
là loại riêng. Không chuyển thẻ gốc/đáp án hoặc phản hồi sang hàng đợi, không
sửa `lastRelayedTime`, không gọi mô hình Manager. Nhắc và ngân sách vẫn do
`pendingPrompts` quản lý; CV12 nối phần hoãn. Cảnh báo máy/PR và thẻ vận hành
có nút chuyên biệt hiện có không âm thầm bị thay bằng bản tin tối giản.

**Đối chiếu PR5 của kế hoạch ổn định:** dùng cùng nguyên tắc phân loại thao
tác, 429, lưu trước gửi và trạng thái chưa rõ, nhưng chỉ cho tóm lược General.
Chưa giải quyết final reply nhiều mảnh, tiến độ từng mảnh, khôi phục từng mảnh
hay thứ tự với orphan sweep của PR5. Không đánh dấu toàn bộ PR5 hoàn thành.
Kiểm thử: `scripts/test-notification-queue.ts`.

**Tệp liên quan:** module thông báo dự kiến, `src/state.ts`, `src/bot.ts`,
`src/telegram.ts`, `src/reminders.ts`; mở rộng kiểm thử giao tin và nhắc.

## CV12 — Giờ yên lặng và tạm hoãn lời nhắc

### Công việc

- [x] Thêm trang cấu hình trong General: bật/tắt, khoảng giờ, múi giờ IANA,
  loại được báo ngay và cách gộp sau giờ yên lặng. Không tự chọn giờ cho người
  dùng; giá trị gợi ý chỉ có hiệu lực sau xác nhận.
- [x] Lưu múi giờ riêng cho thông báo; có thể gợi ý từ cấu hình hiện có nhưng
  không thay múi giờ của lịch chạy hoặc suy ra từ độ lệch UTC cố định.
- [x] Xử lý khoảng qua nửa đêm, giờ đổi mùa và giờ bắt đầu/kết thúc. Với khoảng
  không hợp lệ, báo lỗi trước khi lưu thay vì im lặng áp dụng giá trị khác.
- [x] Thêm nút tạm hoãn nhắc cho đúng yêu cầu; hiển thị thời điểm nhắc lại và
  nút bỏ tạm hoãn. Không coi tạm hoãn là trả lời/hủy/cấp quyền.
- [x] Lưu mốc tạm hoãn qua khởi động lại. Tạm hoãn không đặt lại số lần nhắc,
  không kéo dài hạn chót lượt lịch hoặc nhả chỗ thực thi đang bị giữ.
- [x] Hết giờ yên lặng chỉ gửi bản gộp còn liên quan; không bắn dồn mọi mốc nhắc
  bị bỏ qua. Khi yêu cầu được giải quyết từ nơi khác, gỡ nó khỏi phần đang hoãn.
- [x] Nếu thay đổi chính sách trong khi có thông báo chờ, tính lại theo dữ liệu
  mới nhất và kiểm tra quyền trước khi gửi; không hồi sinh thông báo đã xong.

### Kiểm thử và nghiệm thu

- [x] Dùng đồng hồ giả cho ranh giới thời gian, đổi ngày/múi giờ/giờ mùa, tạm
  hoãn quá hạn, khởi động lại và chính sách đổi trong lúc chờ.
- [x] Thông báo khẩn đi đúng quy tắc đã xác nhận; câu trả lời trực tiếp vẫn
  đến ngay; lịch thực thi không đổi hạn chót.
- [x] Không có loạt thông báo dồn khi hết giờ yên lặng hoặc khi mạng trở lại.

Lối vào: **Thông báo và giờ yên lặng** ở `/sessions`, hoặc quy tắc trên thẻ
phiên. Nhập bằng trả lời đúng tin General, dạng `HH:MM HH:MM IANA`, rồi xem
trước/xác nhận trong 10 phút. Không tự chọn giờ. Có ba cấu hình báo ngay để
chọn trước xác nhận: câu hỏi/quyền/lỗi chặn; chỉ lỗi chặn; không loại nào.
Tắt giờ riêng không bật/tắt bản tin General. Giờ áp dụng cho nhắc tự động
kể cả khi chưa bật bản tin General; thẻ gốc/đáp án, cảnh báo máy/PR và hạn lịch
không bị đổi. Không tự bật nhắc nếu `OPENCODE_TG_REMIND` đang tắt.

`src/notification-time.ts` theo giờ địa phương bằng IANA/Intl, không dùng UTC
offset cố định. Đầu giờ tính vào, cuối giờ tính ra. Giờ lặp áp dụng ở cả hai
lần nếu đồng hồ đang trong khoảng; giờ bị bỏ qua kết thúc ở mốc đầu ngoài
khoảng. Tính ranh giới có giới hạn và bộ nhớ tạm theo nhóm/chính sách, không
quét lịch sử. Sau giờ chỉ xử lý mục còn liên quan, tối đa 8 mục và giãn bản
tin không khẩn 5 giây, không tạo lại các nhịp nhắc đã bỏ qua.

**Đang chờ bạn** có Hoãn 15 phút/1 giờ và Bỏ hoãn từng mục. Kiểm tra lại chủ
sở hữu và request sống trước lưu; lưu `snoozedUntil` và mốc nhắc cũ, giữ nguyên
`remindersSent`/`firstShownAt`. Hiển thị lại thẻ/khởi động lại không mất hoãn.
Bỏ hoãn dùng mốc đã có, không cấp ngân sách mới. Trước nhắc đọc nguồn lại;
đã giải quyết thì gỡ lời nhắc, không trả lời hay cấp quyền thay người dùng.
HTTP đang bay không thể rút lại khi chính sách vừa đổi; các mục chưa gửi được
xét lại. Kiểm thử: `scripts/test-notification-time.ts` và bộ nhắc hiện có.

Chính sách giờ dùng phiên bản 2: mã CV11 cũ không hiểu nên dừng bản tin thay
vì bỏ qua giờ yên lặng. Khi quay lại mã cũ, phải tắt nhắc trong cấu hình trước
và giữ trạng thái; không hứa mã cũ hiểu mọi trường hoãn/giờ mới. Khôi phục mã
mới để chỉnh chính sách qua giao diện, không xóa dữ liệu để chữa lỗi.

**Tệp liên quan:** module thông báo dự kiến, `src/reminders.ts`, `src/bot.ts`,
`src/state.ts`, `src/config.ts` nếu cần giá trị mặc định; kiểm thử thời gian,
chuyển tiếp câu hỏi và lượt lịch.

## Điều kiện bàn giao nhóm tính năng

- [x] CV10–CV12 đạt kiểm thử tự động; quy tắc đang bật/tắt hiện rõ và có nút tắt.
- [x] Tài liệu ghi trung thực giới hạn chống gửi trùng và cách xử lý chưa xác nhận.

**Tiếp theo:** [CV13–CV14 — Tìm kiếm và ghim](05-session-search.md).
