# Tiến độ triển khai cải tiến luồng phiên

Thực hiện theo [kế hoạch tổng](plan-session-workflow-improvements.md). Mỗi đầu
việc một commit; sau commit phải khởi động lại bot và kiểm tra trạng thái trước
khi bắt đầu đầu việc tiếp theo. Không bật chính sách mới trên nhóm thật ngầm định.

| Đầu việc | Trạng thái | Bằng chứng hoặc giới hạn |
| --- | --- | --- |
| CV00 | Hoàn thành | `d216950`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 4 liên kết |
| CV01 | Hoàn thành | `4237cde`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 4 liên kết; bộ nhớ tạm 30 giây, tối đa 1000 bản ghi |
| CV02 | Hoàn thành | `7d490f2`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 4 liên kết; bảng điều khiển 10 hàng/trang |
| CV03 | Đã triển khai và áp dụng | `980450f`; kiểu, đơn vị, đầu-cuối đạt; khởi động lại giữ 4 liên kết; thử mở liên kết trên thiết bị Telegram thật để nghiệm thu ở CV15 |
| CV04 | Hoàn thành | `ba59ed1`; kiểu, đơn vị và ghép đầu vào OpenCode thật đạt; đã khởi động lại, giữ 5 liên kết |
| CV05 | Hoàn thành | `026f3ec`; kiểu, đơn vị và đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV06 | Hoàn thành | `e688e11`; kiểu, đơn vị và đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV07 | Đã triển khai và áp dụng | `aa57067`; kiểu, đơn vị và đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết; thử thiết bị/nhóm thật giữ riêng cho CV15 |
| CV08 | Đã triển khai và áp dụng | `23795e2`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV09 | Đã triển khai và áp dụng | `267f30e`; kiểu, đơn vị và đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV10 | Đã triển khai và áp dụng | `61435b2`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV11 | Đã triển khai và áp dụng | `a1d17f3`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV12 | Đã triển khai và áp dụng | `e4944c5`; kiểu, đơn vị, đầu-cuối đạt; đã khởi động lại, giữ 5 liên kết |
| CV13 | Đã triển khai, chờ chốt commit và khởi động lại | Tìm không dấu/Unicode trong nhóm, lọc và trang 10 hàng, tách quản lý/khám phá gắn; thẻ bất biến đúng người và phạm vi |
| CV14 | Chưa bắt đầu | Ghim |
| CV15 | Chưa bắt đầu | Nghiệm thu tổng hợp |

Mã commit của một đầu việc được ghi ở bản cập nhật tiến độ kế tiếp để không sửa
lại commit sau khi đã khởi động lại. Tác vụ chưa được kiểm tra thực tế trên nhóm
thử nghiệm phải được ghi rõ, không đánh dấu đã nghiệm thu phần đó.
