# Đầu việc 3 — Quay lại phiên và tiếp tục công việc có xác nhận

**Trạng thái:** CV08–CV09 đã triển khai và kiểm thử tự động. **Thứ tự:** CV08 → CV09.
**Điều kiện bắt đầu:** CV07 đạt kiểm thử tự động; nghiệm thu thiết bị/nhóm thật
được giữ rõ ở CV15, chưa đánh dấu hoàn tất. Dùng dữ liệu hoạt động của CV04 trong
[kế hoạch tổng](../plan-session-workflow-improvements.md).

## Mục tiêu và giới hạn

Giúp người dùng hiểu phiên đã làm gì, đang vướng gì và có thể làm gì tiếp theo
trước khi quyết định. Xem tóm tắt là thao tác chỉ đọc; mở lại phiên là thao tác
vòng đời; tiếp tục công việc là một yêu cầu thực thi mới. Ba hành động này không
được gộp thành một nút có tác dụng ngoài dự kiến.

Trong đợt này không gọi mô hình để suy luận tóm tắt hoặc tự nghĩ ra bước tiếp
theo. Nếu nguồn chỉ có một đoạn kết quả, ghi rõ phạm vi; nếu chưa biết bước tiếp
theo, hiển thị **Chưa có bước tiếp theo được ghi nhận**.

## CV08 — Bản tóm tắt chỉ đọc có nguồn và mốc dữ liệu

### Công việc

- [x] Thêm nút **Xem tóm tắt** trên thẻ phiên, bao gồm phiên đã đóng nếu còn
  dữ liệu được phép xem; không tự khôi phục phiên để đọc.
- [x] Thiết kế module trình bày bản tóm tắt, vị trí dự kiến
  `src/session-summary.ts`, nhận dữ liệu đã kiểm tra từ CV01/CV04 thay vì tự
  đọc toàn bộ trạng thái hoặc tự gọi các công cụ thực thi.
- [x] Hiển thị mục tiêu/yêu cầu gần nhất, kết quả đã quan sát, vướng mắc hoặc
  yêu cầu đang chờ, bước tiếp theo đã có trong dữ liệu, thời gian và nguồn.
- [x] Phân biệt kết quả đã xác minh với lời mô hình tự báo hoàn thành; không
  suy ra đã sửa tệp/đã kiểm thử chỉ từ một câu trả lời nếu không có bằng chứng.
- [x] Với dữ liệu thiếu/cũ, cung cấp **Làm mới thông tin** có giới hạn số tin
  cần đọc và thời hạn. Không quét lịch sử mọi phiên hoặc gọi mô hình ngầm.
- [x] Gắn bản tóm tắt với mã phiên và mốc công việc. Ghi rõ nó có thể đã cũ
  khi có đầu vào mới; không lấy thời gian mở thẻ làm mốc thực thi.
- [x] Chỉ hiển thị **Đến chủ đề**, **Làm mới** và hành động phù hợp vòng đời;
  phiên đang chờ người dùng ưu tiên đường đến yêu cầu chờ.

### Kiểm thử và nghiệm thu

- [x] Phiên chưa có tin, dữ liệu cũ, đang chạy, đang chờ, đã đóng và cần can
  thiệp đều có mô tả trung thực, không bịa kết quả hoặc bước tiếp theo.
- [x] Xem và làm mới không gửi yêu cầu, chiếm chỗ, sửa hướng dẫn hoặc đổi mốc
  chuyển tiếp phản hồi `lastRelayedTime`.
- [x] Nội dung dài/HTML/ký tự đặc biệt an toàn; không dùng dữ liệu khác nhóm.

`src/session-summary.ts` là module thuần nhận hàng đã kiểm tra của bảng điều
khiển, không có cổng thực thi. Bản tóm tắt lấy đoạn yêu cầu/kết quả CV04, không
lấy `WorkerInfo.task` hoặc câu tự báo hoàn thành làm bằng chứng đã kiểm thử.
Chưa có dữ liệu bước tiếp theo thì nói rõ chưa có, không gọi mô hình suy luận.

**Làm mới thông tin** chỉ đọc phiên được chọn: metadata, tối đa 40 tin giảm
dần và trạng thái/câu hỏi/quyền từ mô hình đọc CV01. Lịch sử có hạn 3 giây;
trạng thái có hạn hiện có 8 giây. Gộp yêu cầu cùng liên kết, giữ khoảng cách
5 giây cho các lần bấm liên tục; bộ nhớ tối đa 1000 liên kết. Không quét lịch
sử mọi phiên. Đọc được phiên đã đóng nếu sở hữu/danh tính hợp lệ, không đổi
trạng thái lưu trữ hay mở chủ đề. Kết quả trả muộn không ghi đè mốc mới hơn.

Thẻ đọc có người sở hữu, nhóm, liên kết/danh tính và thời hạn 10 phút. Mốc công
việc lấy từ hoạt động và nội dung đã quan sát, không từ thời điểm mở thẻ. Chỉ
cập nhật bản ghi hoạt động phụ; không đổi dung lượng, hướng dẫn, câu trả lời,
lượt nhắc hoặc `lastRelayedTime`. Nguồn lỗi hoặc thiếu ranh giới đầu vào vẫn
hiển thị chưa rõ; không chuyển thành đã hoàn tất.

**Tệp liên quan:** `src/bot.ts`, `src/state.ts`, `src/opencode.ts`, module đọc
bảng điều khiển. Kiểm thử dự kiến: `scripts/test-session-summary.ts`.

## CV09 — Xác nhận tiếp tục đúng phiên và đúng mốc công việc

### Công việc

- [x] Thêm hành động riêng **Chuẩn bị tiếp tục**; hiển thị chính xác nội dung
  sẽ gửi, phiên/thư mục đích và nguồn mốc tóm tắt. Nếu chưa có nội dung đủ rõ,
  yêu cầu người dùng nhập mục tiêu trong luồng có thể hủy; không tự suy đoán.
- [x] Lưu xác nhận có thời hạn, gắn người dùng, nhóm, liên kết, phiên và mốc
  công việc. Bấm nút ở General không tự mở lại phiên đã đóng: phải qua luồng
  mở lại rõ ràng rồi xem/chuẩn bị lại khi cần.
- [x] Khi xác nhận, đọc lại danh tính, quyền, vòng đời, độ mới của mốc, trạng
  thái thực thi và các yêu cầu đang chờ. Nếu có hoạt động mới, hủy bản xác nhận
  cũ và yêu cầu xem lại, không gửi nội dung đã lỗi thời.
- [x] Đi qua cùng cơ chế nhận công việc như tin nhắn/nút đang có; không gọi
  thẳng OpenCode để vượt giới hạn tác vụ, điều kiện bận hoặc chủ sở hữu lượt lịch.
- [x] Không tiếp tục bằng đường này khi lượt chạy lịch còn được sở hữu hoặc
  việc kết thúc chưa xác minh. Khi đã kết thúc, mọi hành động mới vẫn theo quy
  tắc hiện có, không hồi sinh lượt lịch hoặc cấp lại hạn chót cho lượt cũ.
- [x] Ghi nhận xác nhận đã dùng trước khi gửi; định danh đầu vào mới để theo
  dõi. Bấm lặp hoặc đồng thời chỉ được nhận một lần; kết quả gửi không rõ đi
  qua khôi phục/kiểm tra, không tự gửi lại.
- [x] Rà soát nút chạy tiếp sau lỗi hiện có để chia sẻ kiểm tra cần thiết,
  nhưng giữ ý nghĩa của nút đó; không biến mọi lần mở phiên thành chạy tiếp.

### Kiểm thử và nghiệm thu

- [x] Bấm đôi; hai người bấm; xác nhận hết hạn; phiên đổi trạng thái; có đầu
  vào mới; phiên chờ cấp quyền; chỗ thực thi đã đầy; lượt lịch chưa kết thúc.
- [x] Mất phản hồi trước/sau khi gửi, khởi động lại và lỗi lưu không gây gửi
  trùng hoặc báo thành công giả. Không tự phát lại sau khởi động lại.
- [x] Kiểm thử qua đường vào Telegram và đường nhận công việc thật trong bot,
  không chỉ giả lập lời gọi gửi yêu cầu.
- [x] Cả xem tóm tắt lẫn mở lại phiên đều không tạo thực thi mới nếu chưa có
  xác nhận riêng của người dùng.

**Tệp liên quan:** `src/bot.ts`, `src/continue.ts`, `src/orchestrator.ts`,
`src/state.ts`; chỉ tích hợp với chủ sở hữu lượt lịch, không thay quy tắc trong
`src/scheduled-run.ts`. Kiểm thử dự kiến:
`scripts/test-session-resume.ts`, mở rộng kiểm thử chạy tiếp và nút/lệnh lịch.

`src/session-resume.ts` chỉ sở hữu sổ xác nhận phiên bản 1, tối đa 20 mục mỗi
chủ đề. Luồng nhập đòi trả lời đúng tin General của đúng người trong 10 phút;
có nút hủy và `/cancel`. Xem trước hiện nguyên văn đầu vào, kể cả chỉ dẫn
giao diện đầu tiên nếu cơ chế chuẩn sẽ thêm, cùng phiên, thư mục và mốc nguồn.

Khi xác nhận, kiểm tra nguồn lại không dùng khoảng đệm 5 giây của thao tác
đọc thông thường; kiểm tra lần nữa ngay trước gửi sau khi nhận chỗ. Đầu vào
được định danh và lưu trước cổng gửi. Phiên quản lý đi qua `promptManager`,
phiên làm việc đi qua `runPrompt`/`beginWorkerTurn`; không thêm cơ chế cấp chỗ.
`lifecycleRevision` tăng khi đổi pha/cấu hình, nên đóng rồi mở lại cùng phiên
cũng làm xác nhận cũ hết hiệu lực, không bị lẫn với sửa tên.

Lưu đánh dấu dùng trước khi gọi bộ nhận; lỗi lưu chặn gửi. Sau điểm gọi cổng
gửi, mất phản hồi giữ chưa xác minh, không kết nối rồi tự gửi lại yêu cầu này.
Chỉ quan sát đúng mã user trong lịch sử/đúng phản hồi mới ghi nhận đã thấy ở
nguồn. Khởi động lại không phát lại; thẻ chưa dùng của tiến trình cũ cũng phải
chuẩn bị mới. Nếu chưa đối chiếu được, người dùng dùng Làm mới/đến chủ đề để
kiểm tra, không bấm lại hoặc mặc định yêu cầu đã thất bại. Không khởi động hay
cấp lại hạn cho lượt lịch. Sổ đã dùng không bị xóa khi đóng/mở chủ đề.

Nút chạy tiếp sau lỗi của diễn đàn quản lý vẫn gửi câu chạy tiếp cũ, nhưng dùng
chung kiểm tra/sổ nhận một lần theo đúng lượt lỗi; nút lỗi cũ không chạy lượt
mới. Đăng ký trạng thái đang chuẩn bị sớm để `/stop` chặn trước gửi, kể cả khi
đang chờ cập nhật hướng dẫn. Kiểm thử qua `Bot.handle` và bộ nhận công việc
thật, có lỗi lưu đánh dấu/mã đầu vào, nguồn lịch hỏng, chờ quyền/câu hỏi,
đổi vòng đời rồi mở lại, dừng khi chuẩn bị và khởi động lại.

## Điều kiện bàn giao nhóm tính năng

- [x] CV08–CV09 đạt kiểm thử tự động; phân biệt rõ xem, mở lại và tiếp tục.
- [x] Có hướng dẫn xử lý bản tóm tắt cũ và kết quả gửi chưa rõ, không yêu cầu
  người dùng thao tác ở thiết bị đầu cuối.

**Tiếp theo:** [CV10–CV12 — Thông báo](04-notifications.md).
