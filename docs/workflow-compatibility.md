# Dữ liệu, nâng cấp và quay mã luồng phiên

## Chủ sở hữu và giới hạn

Tất cả trường nghiệp vụ dưới đây ở `STATE_FILE`, mặc định `data/state.json`.
Không tạo cơ sở dữ liệu khác, không chuyển thư mục phiên cũ khi `/browse` đổi.

| Vị trí | Ý nghĩa và giới hạn |
| --- | --- |
| `__machine__.sessionTopics` phiên bản 1 | Nhóm đã bật, liên kết cố định, danh tính nguồn/phiên, pha và `lifecycleRevision`; không xóa lịch sử khi đóng |
| `titlePolicies` phiên bản 1, `link.titlePolicy`, `link.titleSync`, `titleRetryAt` | Công tắc nhóm/ngoại lệ, tên riêng một lần, ý định và lỗi/thời gian thử; chỉ tên đã có xác nhận mới là kết quả |
| `sessionActivity` phiên bản 1 của chủ đề | Một đầu vào gần nhất (đoạn tối đa 1.200 ký tự) và kết quả ghép đúng input (1.800), nguồn/mốc/bằng chứng; không lưu toàn hội thoại |
| `resumeConfirmations` phiên bản 1 ở General | Tối đa 20 bản, hạn 10 phút, theo người/nhóm/liên kết/mốc; ghi đã dùng và mã đầu vào trước gửi; không tự phát lại |
| `notificationSettings` phiên bản 1 hoặc 2 ở General | Mặc định tắt bản tin. Phiên bản 2 có giờ IANA và các loại báo ngay do người dùng xác nhận |
| `notificationQueue` phiên bản 1 ở General | 500 mục/nhóm, 7 ngày, gộp 5 giây/tối đa 8 mục, 2 nhóm đồng thời; trạng thái pending/sending/sent/unknown/dropped/failed |
| `pendingPrompts` của chủ đề | Mã tin gốc, ngân sách và lịch nhắc; `snoozedUntil`/`snoozeBaseAt` giữ hoãn và mốc cũ, không nhả dung lượng công việc |
| `sessionPins` phiên bản 1 ở General | Nhóm/người/mã liên kết/dấu danh tính, 20 ghim/người/nhóm, 500 danh sách người dùng/nhóm; không lưu theo tên |

Mô hình đọc giữ tạm 30 giây/tối đa 1.000 mục. Bảng điều khiển/tìm kiếm tối đa
10 hàng/trang, làm mới chỉ trang được chọn, hai phiên đồng thời. Làm mới tóm
tắt đọc tối đa 40 tin, không gọi mô hình. Trạng thái nguồn thiếu/lỗi là chưa
xác minh, không suy thành hoàn tất. Các đoạn kết quả không chứng minh độc lập
việc sửa tệp hoặc kiểm thử của mô hình.

Các thẻ/nút có người sở hữu và bản nhập ở General hạn 10 phút. Tin kế tiếp
của đúng người trong đúng General hoặc Trả lời đúng tin nhập được nhận; tin
người khác/chủ đề khác/câu trả lời cho tin khác không được lấy. Mở luồng nhập
mới hủy bản nhập cũ. Lệnh không bị lấy làm nội dung; Hủy và `/cancel` không
hủy công việc. Xác nhận trước khởi động lại phải chuẩn bị mới.

## Nâng cấp

1. Giữ nguyên `STATE_FILE`, thư mục quản lý và kho lịch. Không xóa để làm mới
   giao diện hoặc chữa liên kết chưa rõ.
2. Dữ liệu cũ thiếu trường mới dùng mặc định: không tự bật thông báo/giờ yên
   lặng/ghim, không tự gọi mô hình hoặc quét toàn lịch sử để bù đoạn yêu cầu.
   Cờ đồng bộ tên cũ đã được chủ nhóm bật vẫn có hiệu lực; cập nhật không tự
   bật cho nhóm chưa chọn. Khi ghi chính sách mới, di chuyển cờ cũ một lần.
3. Phiên bản không hiểu hoặc bản ghi hỏng giữ nguyên và chặn thao tác tương
   ứng; không diễn giải là kho trống để tạo lại tài nguyên hay phát lại việc.
4. Bật bản tin/giờ/tên bằng giao diện có xem trước; không thay thông báo cảnh
   báo máy/PR hoặc hàng đợi báo cáo cho mô hình Manager.

## Giao tin chưa rõ

Ghi `sending` trước HTTP. Nếu mất mạng/5xx/hết thời gian khi tạo tin, giữ
`unknown`; không biết mã tin thì không tự gửi một tin mới thay thế. 429 là từ
chối chắc chắn, chờ `retry_after` đúng nhóm. Chỉ edit khi đã biết mã tin, kiểm
tra lại nguồn trước edit; no-op edit hợp lệ. Dùng bảng điều khiển/Đang chờ bạn
khi chưa rõ, không cấp quyền hoặc gửi lại yêu cầu mô hình để chữa thông báo.
Không bảo đảm chống trùng nếu mất cả kho/bản ghi lưu. Đây không thay thế phần
final reply nhiều mảnh và orphan sweep của kế hoạch ổn định PR5.

## Khởi động lại và quay mã

- macOS: `npm run restart:local -- --check` kiểm tra đúng cwd/tài khoản/tệp
  và một bot; `npm run restart:local` lưu bản trước dừng và bản ổn định sau dừng
  vào thư mục `backups/` cạnh `STATE_FILE` (quyền 0600), chờ toàn cây cũ thoát
  mới chạy một `npm start`. Nhật ký ở thư mục tạm được phê duyệt `opencode/`.
- Sau thành công có biên nhận `deployments/deployment-*.json`: commit, tệp mã
  còn chưa commit, backup, nhật ký, số liên kết. Mã chạy qua tsx là nội dung thư
  mục làm việc, **không chỉ** Git HEAD. Không khẳng định commit sạch khi còn
  thay đổi song song; phải xin phép trước khi nạp chúng.
- Linux: dùng dịch vụ `opencode-bot` đã cấu hình và journal; Node đổi phiên
  bản phải cập nhật đường dẫn ghim của unit. Không mở thêm tiến trình polling.
- Quay **mã** không đồng nghĩa phục hồi tệp trạng thái cũ: giữ dữ liệu mới để
  không mất lịch sử/câu hỏi/mốc chuyển tiếp. Chỉ phục hồi backup khi đã dừng
  đúng bot, hiểu phần dữ liệu sau backup sẽ mất và có xác nhận rõ.
- Mã CV00–CV04 không hiểu ngoại lệ tên: bản ghi chính sách mới để cờ cũ rỗng
  nhằm dừng tự đổi tên khi quay mã; không dùng nút bật tên của bản cũ.
- Mã trước CV12 không hiểu giờ phiên bản 2 nên dừng bản tin. Phải tắt nhắc ở
  cấu hình trước khi quay về mã không hiểu giờ/hoãn, không hứa mã cũ tuân thủ
  mọi trường mới. Không xóa chính sách phiên bản 2 để ép mã cũ chạy.
- Không tự quay mã hay thay trạng thái đang chạy chỉ vì một lỗi truy vấn;
  trạng thái chưa kết thúc vẫn giữ dung lượng và độc quyền lượt lịch.
