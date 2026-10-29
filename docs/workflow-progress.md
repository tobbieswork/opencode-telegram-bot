# Tiến độ triển khai cải tiến luồng phiên

Thực hiện theo [kế hoạch tổng](plan-session-workflow-improvements.md). Mỗi đầu
việc một commit; sau commit phải khởi động lại bot và kiểm tra trạng thái trước
khi bắt đầu đầu việc tiếp theo. Không bật chính sách mới trên nhóm thật ngầm định.

| Đầu việc | Trạng thái | Bằng chứng hoặc giới hạn |
| --- | --- | --- |
| CV00 | Hoàn thành | `d216950`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 4 liên kết |
| CV01 | Hoàn thành | `4237cde`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 4 liên kết; bộ nhớ tạm 30 giây, tối đa 1000 bản ghi |
| CV02 | Đã triển khai, chờ chốt commit và khởi động lại | Bảng điều khiển 10 hàng/trang, 5 bộ lọc, thẻ theo người/nhóm và lối gắn phiên riêng; kiểm thử đường vào công khai |
| CV03 | Chưa bắt đầu | Đang chờ bạn |
| CV04 | Chưa bắt đầu | Hoạt động gần nhất |
| CV05 | Chưa bắt đầu | Mô hình chính sách tên |
| CV06 | Chưa bắt đầu | Bật/tắt theo nhóm/chủ đề |
| CV07 | Chưa bắt đầu | Tên riêng và cạnh tranh |
| CV08 | Chưa bắt đầu | Tóm tắt chỉ đọc |
| CV09 | Chưa bắt đầu | Tiếp tục có xác nhận |
| CV10 | Chưa bắt đầu | Phân loại thông báo |
| CV11 | Chưa bắt đầu | Hàng đợi và gộp |
| CV12 | Chưa bắt đầu | Giờ yên lặng, tạm hoãn |
| CV13 | Chưa bắt đầu | Tìm kiếm |
| CV14 | Chưa bắt đầu | Ghim |
| CV15 | Chưa bắt đầu | Nghiệm thu tổng hợp |

Mã commit của một đầu việc được ghi ở bản cập nhật tiến độ kế tiếp để không sửa
lại commit sau khi đã khởi động lại. Tác vụ chưa được kiểm tra thực tế trên nhóm
thử nghiệm phải được ghi rõ, không đánh dấu đã nghiệm thu phần đó.
