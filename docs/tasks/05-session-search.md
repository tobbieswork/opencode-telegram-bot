# Đầu việc 5 — Tìm và ghim phiên

**Trạng thái:** CV13–CV14 đã triển khai và kiểm thử tự động; thử nhóm/thiết bị ở CV15. **Thứ tự:** CV13 → CV14.
**Điều kiện bắt đầu:** CV12 đạt kiểm thử tự động; thử nhóm thật ở CV15. Dùng bảng điều khiển CV01–CV04.
Xem [kế hoạch tổng](../plan-session-workflow-improvements.md).

## Mục tiêu và phạm vi

Tìm lại phiên bằng tên, thư mục/dự án và đoạn tóm tắt đã được phép lưu; ghim các
phiên thường dùng mà không đổi liên kết. Không lập chỉ mục toàn bộ hội thoại,
mã nguồn, phiên mọi nhóm hoặc gửi truy vấn ra công cụ tìm kiếm bên ngoài.

Hai loại kết quả phải tách biệt:

- **Phiên đang quản lý:** tìm trong các liên kết của nhóm, có thể bao gồm đã
  đóng khi người dùng chọn bộ lọc tương ứng; bấm tên chỉ mở chi tiết/điều hướng.
- **Phiên có thể gắn:** giữ quy tắc khám phá đang có — phiên cũ của nhóm và
  phiên gốc chưa có nơi sở hữu trong thư mục đang chọn, không lấy phiên nhóm
  khác, phiên con hoặc phiên lưu trữ ngoài phạm vi. Chọn gắn vẫn cần kiểm tra lại.

## CV13 — Tìm kiếm có phạm vi và phân trang

### Công việc

- [x] Thêm nút **Tìm phiên** trong bảng điều khiển; có thể bổ sung lệnh ngắn
  nếu thống nhất vào danh mục lệnh. Không biến mọi tin ở General thành truy vấn
  hoặc yêu cầu mô hình một cách ngầm định.
- [x] Luồng nhập từ khóa có người sở hữu, nhóm, thời hạn và nút Hủy. Không
  nhận nhầm tin nhắn từ chủ đề làm việc hoặc người khác làm từ khóa.
- [x] Thiết kế phần tìm kiếm trên mô hình đọc của CV01; vị trí dự kiến
  `src/session-search.ts`. Ưu tiên lọc dữ liệu nhỏ trong bộ nhớ, chưa cần một hệ
  thống lập chỉ mục riêng nếu số phiên thực tế chưa đòi hỏi.
- [x] Chuẩn hóa Unicode và chữ hoa/thường; hỗ trợ gõ không dấu tiếng Việt.
  Tìm theo tên, đường dẫn và các đoạn có giới hạn từ CV04. Không giả vờ có thể
  tìm nội dung chưa từng thu thập; ghi rõ phạm vi trên giao diện.
- [x] Xếp hạng ổn định: khớp tên đầy đủ, khớp tên một phần, thư mục/tóm tắt,
  rồi mốc hoạt động và mã liên kết. Ghim chỉ ưu tiên trong các kết quả thực sự
  khớp và được phép xem, không đưa phiên ngoài phạm vi vào kết quả.
- [x] Kết hợp bộ lọc trạng thái và phân trang tối đa 10 hàng; giữ nguyên từ
  khóa/bộ lọc khi chuyển trang, có nút xóa bộ lọc và quay lại bảng điều khiển.
- [x] Bấm kết quả thuộc phiên đã quản lý không tự mở lại/chạy tiếp. Bấm kết
  quả có thể gắn đi qua `SessionTopics.attach`, không dùng kết quả tìm kiếm cũ
  làm bằng chứng quyền sở hữu hoặc trạng thái nghỉ.
- [x] Khóa bộ nhớ kết quả theo nhóm/người/thẻ; kiểm tra lại khi bấm, làm mới
  hoặc phân trang. Thay thư mục ở General chỉ ảnh hưởng phạm vi khám phá, không
  thay thư mục của phiên/chủ đề đang làm việc.

### Kiểm thử và nghiệm thu

- [x] Tìm có dấu/không dấu, Unicode tổ hợp, biểu tượng, ký tự HTML, từ khóa
  trống/quá dài, nhiều kết quả đồng hạng, dữ liệu đổi giữa hai trang.
- [x] Hai nhóm có cùng tiêu đề; phiên con/lưu trữ; phiên đã được nhóm khác sở
  hữu sau lúc tìm; không còn kết nối OpenCode; dữ liệu tóm tắt chưa có.
- [x] Tìm không tải toàn bộ lịch sử, không gọi mô hình, không tạo/gắn/mở lại
  phiên chỉ vì liệt kê; thao tác gắn vẫn bị chặn khi phiên bận hoặc xung đột.

**Tệp liên quan:** `src/bot.ts`, `src/commands.ts`, mô hình đọc bảng điều khiển,
`src/session-topics.ts`, `src/format.ts`; mở rộng
`scripts/test-session-picker.ts`, kiểm thử bảng điều khiển, HTML và kiểm thử
tìm kiếm dự kiến `scripts/test-session-search.ts`.

`src/session-search.ts` chuẩn hóa NFKD, bỏ dấu kết hợp và chuyển đ→d; xếp hạng
tên đầy đủ, tên một phần, rồi đường dẫn/đoạn CV04, sau đó hoạt động và mã ổn
định. Không dùng toàn bộ hội thoại hoặc `WorkerInfo.task` làm chỉ mục. Từ khóa
1–120 ký tự, nhập bằng trả lời đúng tin General trong 10 phút; Hủy và `/cancel`
không đổi phiên. Bộ nhớ tối đa 100 bản nhập, 500 thẻ. Mỗi trang có mã thẻ mới
và danh sách chọn bất biến, nên nút trang cũ không bị trỏ sang chỉ số trang mới.

Mặc định không kèm phiên đóng; có nút kèm hoặc lọc Đã đóng. Giữ từ khóa/bộ lọc
khi phân trang 10 hàng; Bỏ bộ lọc và Bảng điều khiển là hai hành động riêng.
Làm mới chỉ đọc trạng thái trang được chọn, không tải lịch sử. Tách chế độ
**Đang quản lý** và **Có thể gắn**; chế độ gắn dùng chính bộ khám phá hiện có
qua `attachmentChoices`, loại nhóm khác/phiên con/lưu trữ. Đổi thư mục khám
phá làm kết quả gắn cũ không còn áp dụng; không đổi thư mục liên kết đang chạy.
Khi bấm gắn, đọc lại danh sách/phạm vi rồi gọi `SessionTopics.attach`, không
dùng danh sách làm bằng chứng đã nghỉ. Nguồn lỗi vẫn có thể tìm dữ liệu đã lưu,
nhưng gắn không được vượt kiểm tra nguồn. Kết quả trong General là tin chung,
không phải tin riêng tư của người sở hữu nút.

## CV14 — Ghim phiên theo người dùng trong từng nhóm

### Công việc

- [x] Thêm **Ghim/Bỏ ghim** trên thẻ phiên và bộ lọc **Đã ghim**. Đây là danh
  sách ưa dùng của từng người trong từng nhóm, không phải thao tác ghim tin
  Telegram và không yêu cầu thêm quyền quản trị ngoài quy tắc bot hiện có.
- [x] Lưu bằng mã liên kết ổn định, kèm nhóm/người dùng; không lưu theo tên
  hoặc số thứ tự trên trang. Đổi tên không làm mất ghim.
- [x] Giới hạn đề xuất tối đa 20 ghim/người/nhóm, báo rõ khi đầy; giá trị cuối
  cùng phải được ghi trong tài liệu triển khai và kiểm thử.
- [x] Bấm lặp và bấm đồng thời cho kết quả xác định. Người dùng chỉ sửa danh
  sách của mình; thẻ tạo cho người này không sửa danh sách người khác.
- [x] Phiên đã đóng vẫn có thể được ghim nhưng hiển thị đã đóng. Ghim không
  tự khôi phục, mở chủ đề, nhận công việc hay thay quyền xem.
- [x] Khi liên kết/phiên không còn xác minh được, hiển thị không khả dụng và
  cho bỏ ghim; không xóa ghim chỉ vì một lần lỗi mạng hoặc tạo phiên thay thế.
- [x] Khởi động lại giữ danh sách. Danh sách chỉ đọc lại các liên kết còn thuộc
  đúng nhóm, không làm lộ dữ liệu nếu sở hữu đã thay đổi hoặc dữ liệu lưu bị lỗi.

### Kiểm thử và nghiệm thu

- [x] Hai người và hai nhóm, cùng phiên/cùng tên; đổi tên; đóng/mở lại;
  lỗi truy vấn; mã ghim không hợp lệ; vượt giới hạn; khởi động lại; ghi lỗi.
- [x] Bộ lọc ghim phối hợp đúng từ khóa/trạng thái và không vượt kiểm tra phạm vi.
- [x] Không có lời gọi thay đổi phiên hoặc thực thi khi chỉ ghim/bỏ ghim.

**Tệp liên quan:** `src/state.ts`, `src/bot.ts`, module đọc/tìm kiếm dự kiến;
kiểm thử tìm kiếm, lưu trạng thái và đường vào Telegram.

`src/session-pins.ts` sở hữu bản ghi phiên bản 1 tại General, tách người dùng
và kiểm tra nhóm. Tối đa **20 ghim/người/nhóm**, 500 danh sách người dùng/nhóm;
không gọi API ghim tin Telegram. Ghim theo mã liên kết và dấu danh tính phiên,
không theo tên/chỉ số trang. Đổi tên/đóng/mở không làm mất ghim; chuyển chủ hoặc
thay danh tính làm mục không khả dụng, không trỏ sang phiên thay thế. Mất nguồn
hiển thị chưa xác minh, không xóa. Mã ghim hỏng còn đọc được theo định dạng lưu
thì hiển thị không khả dụng và cho bỏ; phiên bản lưu chưa hỗ trợ giữ nguyên.

Thẻ có người sở hữu có nút Ghim/Bỏ ghim trực tiếp. Thẻ vận hành chung không
biết người xem có lối mở thẻ ghim cá nhân trước. Nút ghi gắn người/nhóm/mốc
10 phút và ý định **đặt trạng thái**, không đảo qua lại khi bấm đôi. Lưu lỗi
không báo thành công. `/sessions` thêm Đã ghim và Quản lý ghim cá nhân; vẫn ưu
tiên yêu cầu chờ người dùng, ghim ưu tiên trong cùng nhóm xếp hạng. Tìm kiếm có
Chỉ kết quả đã ghim phối hợp trạng thái/từ khóa; không đưa ghim không khớp hay
ngoài quyền vào kết quả. Kiểm thử: `scripts/test-session-pins.ts`.

## Điều kiện bàn giao nhóm tính năng

- [x] CV13–CV14 đạt kiểm thử tự động; tìm/ghim bằng nút hoặc luồng nhập có
  thể hủy, không cần tìm mã phiên.
- [x] Tài liệu ghi rõ phạm vi tìm kiếm và tính cá nhân của ghim trong General
  dùng chung; không tuyên bố tin gửi trong nhóm là riêng tư với từng người.

**Tiếp theo:** CV15 trong
[kế hoạch tổng](../plan-session-workflow-improvements.md#6-cv15--nghiệm-thu-tổng-hợp-và-triển-khai).
