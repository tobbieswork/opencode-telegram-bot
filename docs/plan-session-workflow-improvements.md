# Kế hoạch cải tiến quản lý phiên và chủ đề Telegram

- **Ngày lập:** 2026-10-29.
- **Trạng thái:** đang triển khai tuần tự từ CV00 theo yêu cầu người dùng;
  xem [tiến độ và bằng chứng](workflow-progress.md).
- **Phạm vi:** năm nhóm tính năng đã trao đổi với người dùng.
- **Ưu tiên đầu tiên:** bảng điều khiển và danh sách **Đang chờ bạn**.
- **Cách thực hiện:** tuần tự; nghiệm thu một đầu việc trước khi chuyển sang đầu
  việc kế tiếp. Người dùng đã cho phép triển khai, mỗi đầu việc một commit và
  khởi động lại bot sau từng commit; việc bật chính sách mới vẫn cần xác nhận
  riêng trong General.

## 1. Điểm xuất phát

Các chức năng sau đã có, cần mở rộng thay vì xây lại:

- General quản lý; chủ đề làm việc gắn cố định với một phiên OpenCode.
- `/sessions` hiển thị thẻ liên kết và danh sách chọn phiên có tên, phân trang.
- Phiên quản lý có nút mở thống nhất, dùng lại hoặc khôi phục đúng phiên cũ.
- Đồng bộ tên một chiều từ OpenCode, có xem trước và xác nhận theo nhóm; có
  hàng đợi, kiểm tra danh tính, giới hạn tần suất và thử lại sau lỗi.
- Câu hỏi, xin quyền và lịch nhắc được lưu theo cuộc hội thoại; có đối chiếu lại
  khi kết nối lại. Kết quả đối chiếu lỗi là **chưa rõ**, không phải **không còn**.
- Tác vụ có kết quả gần nhất trong `WorkerInfo.lastResult`; `WorkerInfo.task`
  chỉ mô tả công việc ban đầu, không bảo đảm là yêu cầu mới nhất.
- Nút chạy tiếp sau lỗi đã tồn tại, có kiểm tra riêng; không được dùng nó làm
  đường tắt bỏ qua điều kiện nhận công việc.

Nguồn khảo sát: `src/bot.ts`, `src/session-topics.ts`, `src/state.ts`,
`src/orchestrator.ts`, `src/reminders.ts`, `src/continue.ts`. Kiểm tra lại mã và
thay đổi chưa lưu thành bản ghi Git khi bắt đầu từng đầu việc; không mặc định
các nhận xét trong tài liệu cũ vẫn đúng với mã hiện tại.

## 2. Thứ tự bắt buộc

| Thứ tự | Mã | Đầu việc | Tài liệu chi tiết |
| --- | --- | --- | --- |
| 0 | CV00 | Chốt mốc kiểm thử, dữ liệu mẫu và các bất biến | Mục 4 của tài liệu này |
| 1 | CV01 | Mô hình đọc trạng thái phiên và độ mới dữ liệu | [Bảng điều khiển](tasks/01-session-dashboard.md) |
| 2 | CV02 | Bảng điều khiển gọn, bộ lọc và phân trang | [Bảng điều khiển](tasks/01-session-dashboard.md) |
| 3 | CV03 | Danh sách Đang chờ bạn và đi tới đúng yêu cầu | [Bảng điều khiển](tasks/01-session-dashboard.md) |
| 4 | CV04 | Ghi nhận yêu cầu/kết quả gần nhất có nguồn đối chiếu | [Bảng điều khiển](tasks/01-session-dashboard.md) |
| 5 | CV05 | Mô hình chính sách tên và tương thích dữ liệu cũ | [Kiểm soát tên](tasks/02-topic-title-controls.md) |
| 6 | CV06 | Bật/tắt đồng bộ theo nhóm và chủ đề | [Kiểm soát tên](tasks/02-topic-title-controls.md) |
| 7 | CV07 | Đặt tên riêng và vô hiệu hóa thao tác đổi tên cũ | [Kiểm soát tên](tasks/02-topic-title-controls.md) |
| 8 | CV08 | Tóm tắt để quay lại phiên, không gọi mô hình | [Quay lại công việc](tasks/03-session-resume.md) |
| 9 | CV09 | Xác nhận tiếp tục đúng phiên, đúng mốc công việc | [Quay lại công việc](tasks/03-session-resume.md) |
| 10 | CV10 | Phân loại thông báo và quy tắc gửi | [Thông báo](tasks/04-notifications.md) |
| 11 | CV11 | Hàng đợi thông báo có lưu trạng thái và gộp kết quả | [Thông báo](tasks/04-notifications.md) |
| 12 | CV12 | Giờ yên lặng và tạm hoãn lời nhắc | [Thông báo](tasks/04-notifications.md) |
| 13 | CV13 | Tìm phiên theo tên, thư mục và tóm tắt đã lưu | [Tìm kiếm và ghim](tasks/05-session-search.md) |
| 14 | CV14 | Ghim phiên theo người dùng trong từng nhóm | [Tìm kiếm và ghim](tasks/05-session-search.md) |
| 15 | CV15 | Nghiệm thu tổng hợp, tài liệu và triển khai | Mục 6 của tài liệu này |

Thứ tự trên ưu tiên bàn giao từng phần sử dụng được, không phải yêu cầu gom tất
cả vào một lần triển khai. Phụ thuộc dữ liệu chính: CV03 dùng CV01; CV08 và
CV13 dùng CV04; CV07 cần CV05–CV06; CV12 cần CV10–CV11; CV14 cần CV13.

Mỗi mã là một đơn vị bàn giao có kiểm thử và tiêu chí hoàn thành riêng. Nếu cần
chia nhỏ bản ghi thay đổi, giữ nguyên mã để theo dõi; không đánh dấu hoàn thành
chỉ vì đã có phần giao diện.

## 3. Bất biến xuyên suốt

1. Không tạo/thay phiên trong chủ đề làm việc; `SessionTopics` tiếp tục sở hữu
   liên kết và vòng đời. General không trở thành phiên mô hình ngầm.
2. Xem danh sách, tìm kiếm, ghim, xem trước và đọc tóm tắt không được gửi yêu cầu
   thực thi, dừng công việc, mở lại phiên hoặc chiếm chỗ thực thi.
3. Trạng thái vòng đời, thực thi, chờ người dùng, đồng bộ tên và giao thông báo
   là các chiều khác nhau. Không biến lỗi đổi tên thành lỗi công việc.
4. Không dùng dữ liệu cũ hoặc mất kết nối làm bằng chứng đã kết thúc. Mọi hành
   động ghi phải kiểm tra lại quyền, nhóm, danh tính và trạng thái hiện tại.
5. Không thay đổi quy tắc dung lượng, hạn chót và khôi phục của lượt chạy lịch;
   không phát lại yêu cầu chưa rõ đã gửi hay chưa. Xem
   [thiết kế lượt chạy lịch](design-scheduled-run.md).
6. Phạm vi đọc/ghi luôn gắn với nhóm và phiên được phép. Không lộ phiên nhóm
   khác, phiên con hoặc phiên gốc ngoài phạm vi tìm phiên đang được cho phép.
7. Dữ liệu mới phải có giới hạn kích thước, kiểm tra hình dạng, lưu nguyên tử và
   đọc được dữ liệu cũ. Không xóa `data/state.json` để xử lý lỗi.
8. Nội dung động gửi Telegram phải mã hóa HTML; dữ liệu nút không quá 64 byte.
   Nút cũ, bấm lặp và thao tác đồng thời phải được kiểm thử ở đường vào công khai.
9. Không mặc định máy chủ có lịch sử sự kiện bền vững. Dữ liệu hiện tại và mốc
   quan sát được phải đủ để hiển thị trung thực; không yêu cầu sửa/khởi động lại
   OpenCode chỉ để bổ sung các tính năng này.
10. Không hứa chỉ gửi đúng một lần khi Telegram mất phản hồi sau khi đã nhận
    yêu cầu. Phân biệt đã xác nhận, đang chờ và chưa rõ kết quả.

## 4. CV00 — Chốt mốc trước khi triển khai

### Công việc

- [x] Ghi nhận nhánh, bản ghi Git hiện tại và các thay đổi có sẵn; không ghi đè
  công việc của người dùng.
- [x] Chạy `npm run typecheck` và `npm run test:unit`; tách lỗi có sẵn khỏi lỗi
  phát sinh trong đợt cải tiến.
- [x] Tạo dữ liệu mẫu: nhóm chưa bật quản lý; nhóm được quản lý; hai nhóm có tên
  phiên giống nhau; phiên đã đóng; phiên cần can thiệp; câu hỏi/quyền chưa rõ;
  lỗi đồng bộ tên; lượt lịch còn giữ chỗ thực thi.
- [x] Chuẩn bị đồng hồ giả, bộ hẹn giờ điều khiển được và lời hứa có thể chủ động
  cho hoàn thành để kiểm thử cạnh tranh mà không phải chờ thời gian thật.
- [x] Chốt quy ước mốc dữ liệu: thời gian quan sát, mã phiên, mã đầu vào/lượt
  thực thi nếu có và lý do chưa xác minh. Không dùng thời gian hiển thị tin nhắn
  làm định danh duy nhất của công việc.
- [x] Kiểm tra nơi lưu dữ liệu và cách đọc phiên bản không hỗ trợ: dừng thao tác
  mới an toàn, báo lỗi, giữ dữ liệu để kiểm tra.

**Hoàn thành khi:** có kết quả kiểm thử ban đầu, dữ liệu mẫu tái sử dụng được và
các bất biến được kiểm tra qua đường vào của bot, không chỉ qua hàm giả lập ghi
nhận lời gọi.

## 5. Quy ước thực hiện từng đầu việc

- Tên tệp mới trong các tài liệu chi tiết là **dự kiến**, chưa tồn tại và chưa
  phải quyết định kiến trúc bắt buộc. Chỉ tạo module khi nó thực sự tập trung
  quy tắc dùng chung, không thêm lớp chỉ chuyển tiếp lời gọi.
- Viết kiểm thử hành vi trước hoặc cùng thay đổi. Với lỗi tái hiện được, chạy
  kiểm thử thất bại trước khi sửa để chứng minh kiểm thử bắt đúng lỗi.
- Đưa giao diện nút mới vào General, kiểm tra cùng quy tắc với lệnh văn bản.
  Người dùng không cần tìm mã phiên hoặc thao tác trong thiết bị đầu cuối.
- Không thêm cuộc gọi mô hình trả phí để tạo tên, tóm tắt hoặc tìm kiếm trong
  đợt này. Tóm tắt là trình bày lại dữ liệu có nguồn đối chiếu, không tự suy diễn.
- Dùng `StateManager` cho lưu trữ; không tạo đường ghi riêng cho cùng dữ liệu.
  Không đưa bộ nhớ tạm về danh sách vào cấu trúc sở hữu lượt chạy lịch.
- Sau từng đầu việc: kiểm tra kiểu → kiểm thử đơn vị → kiểm thử tích hợp liên
  quan. Kiểm thử đầu-cuối thật chạy cuối cùng khi chuẩn bị bàn giao bản mã.
- Chỉ ghi `[x]` ở đầu việc và tiêu chí đã được xác minh; ghi rõ việc còn thiếu,
  giới hạn và bằng chứng kiểm thử ngay trong bản bàn giao tương ứng.

## 6. CV15 — Nghiệm thu tổng hợp và triển khai

### Kiểm thử tổng hợp

- [ ] Một kịch bản xuyên suốt: tạo phiên → gửi yêu cầu → có câu hỏi → xuất hiện
  trong Đang chờ bạn → trả lời trong chủ đề → hoàn tất → xem tóm tắt → tìm và
  ghim phiên → đóng → mở lại đúng liên kết.
- [ ] Một kịch bản tên: bật nhóm → tắt một chủ đề → đặt tên riêng → đổi tiêu đề
  OpenCode → kiểm tra tên riêng không bị hàng đợi cũ ghi đè → bật theo OpenCode
  với xem trước → khởi động lại và kiểm tra chính sách.
- [ ] Một kịch bản thông báo: bật giờ yên lặng → nhiều phiên hoàn tất → có câu
  hỏi khẩn → khởi động lại → chỉ còn thông báo hợp lệ, không gửi dồn lời nhắc cũ.
- [ ] Hai nhóm và hai người dùng: không lộ dữ liệu, dùng nhầm bản xem trước,
  xác nhận hoặc danh sách ghim của nhau; nút cũ bị kiểm tra lại.
- [ ] Lỗi mạng, giới hạn tần suất, thiếu quyền, lỗi lưu, dữ liệu cũ/hỏng, khởi
  động lại giữa thao tác và kết quả gửi không rõ đều có hành vi đã kiểm thử.
- [ ] `npm run typecheck`, `npm run test:unit`, các kiểm thử tích hợp bổ sung và
  cuối cùng `npm run smoke` đều đạt. Đọc các phần menu, chọn chế độ, chuyển tiếp
  phản hồi bị bỏ lỡ và chuyển tiếp câu hỏi; không chỉ nhìn mã thoát.
- [ ] Kiểm tra nhóm Telegram thử nghiệm cho liên kết tới câu hỏi, giới hạn tên,
  thao tác nút và quyền thực tế; không dùng nhóm thật để tạo dữ liệu kiểm thử
  hàng loạt mà chưa xin phép.

### Tài liệu và vận hành

- [ ] Cập nhật `README.md`, `docs/session-topics-operations.md`, danh mục lệnh
  nếu có thay đổi, hướng dẫn lỗi và cách tắt từng tính năng mới.
- [ ] Ghi rõ trường dữ liệu mới, giá trị mặc định, giới hạn lưu, cách nâng dữ
  liệu cũ và cách quay về bản mã đã triển khai trước đó mà không mất dữ liệu.
- [ ] Kiểm tra cấu hình triển khai hiện tại thay vì dùng lại mã tiến trình hoặc
  đường dẫn nhật ký cũ. Xác minh đúng tài khoản bot và đúng tệp trạng thái.
- [ ] Khi được phép triển khai: sao lưu trạng thái cần thiết; dừng đúng tiến
  trình cũ và chờ thoát trước khi chạy bản mới. Linux dùng dịch vụ systemd đang
  cấu hình; máy macOS hiện tại dùng tiến trình `npm start` tách nền.
- [ ] Kiểm tra nhật ký khởi động, chỉ một tiến trình thăm dò Telegram, không có
  lỗi 409 và các liên kết phiên/chủ đề cũ được giữ nguyên.
- [ ] Không bật hàng loạt chính sách tên, giờ yên lặng hoặc thông báo mới khi
  cập nhật mã. Đưa ra nút xem trước/cấu hình trong General cho người dùng chọn.

**Hoàn thành khi:** có bằng chứng cho cả kiểm thử, tương thích dữ liệu và vận
hành; người dùng dùng được hoàn toàn qua Telegram, không mất liên kết/lịch sử và
không phát sinh công việc mô hình ngoài những gì họ đã xác nhận.

## 7. Ngoài phạm vi của kế hoạch

- Chuyển cơ sở dữ liệu, đổi khung ứng dụng hoặc chạy nhiều tiến trình bot.
- Tự sửa mã, tự thực thi bước tiếp theo hay khởi động lại lượt lịch từ tóm tắt.
- Đồng bộ tên hai chiều hoặc tự ghi đè tiêu đề OpenCode.
- Tìm kiếm ngữ nghĩa bằng mô hình, lập chỉ mục toàn bộ hội thoại/mã nguồn hoặc
  gửi dữ liệu sang nhà cung cấp tìm kiếm bên ngoài.
- Thay thế toàn bộ kế hoạch ổn định cũ. Các phần liên quan đến lưu trữ và giao
  tin cần đối chiếu [kế hoạch ổn định](plan-reliability-hardening.md), không mặc
  định các đầu việc trong tài liệu đó đã hoàn thành.
