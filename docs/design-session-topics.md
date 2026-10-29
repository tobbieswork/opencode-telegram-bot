# Thiết kế quản trị phiên ở General, làm việc trong chủ đề riêng

**Trạng thái:** đã triển khai mã ở chế độ bật riêng từng nhóm qua `/setup`;
chưa chuyển nhóm thật hoặc nghiệm thu giao diện Telegram thật.

Tài liệu này mô tả thiết kế mới theo yêu cầu người dùng. Các chat cũ giữ hành vi
cũ cho đến khi chọn chuyển đổi; không tự đổi cấu hình, gắn lại hoặc dọn phiên cũ.
Hướng dẫn vận hành và giới hạn hiện tại: [session-topics-operations.md](session-topics-operations.md).

## 1. Quyết định đã chốt

- Dùng **một nhóm Telegram bật Topics**. General là nơi quản trị phiên/chủ đề.
- Mỗi chủ đề làm việc gắn cố định với **một phiên OpenCode**. Không tạo hoặc
  thay phiên trong chủ đề đó.
- Đóng phiên mới đóng chủ đề; kết thúc một lượt trả lời không phải đóng phiên.
- Nếu yêu cầu đóng khi phiên đang xử lý hoặc chờ câu hỏi/quyền: yêu cầu dừng
  đúng công việc, chờ xác nhận kết thúc, rồi lưu trữ phiên và đóng chủ đề.
  Chưa xác nhận được thì báo đang đóng, không báo thành công giả.

“Đóng phiên” trong thiết kế này là **lưu trữ**, không xóa lịch sử. Xóa dữ liệu
vĩnh viễn là thao tác khác, không đi kèm nút Đóng.

## 2. Hai nơi tương tác

### General — nơi quản trị

General là bảng điều khiển bằng lệnh/nút, không phải một phiên LLM ngầm:

- Liệt kê các phiên bot quản lý và trạng thái đồng bộ của chúng.
- Tạo phiên mới với thư mục, mô hình và tác nhân được chọn.
- Gắn một phiên OpenCode có sẵn khi người dùng chọn rõ ràng.
- Đi tới chủ đề của phiên; đóng hoặc mở lại phiên.
- Quản trị lịch chạy và chính sách giao việc tự động.
- Hiển thị lỗi tạo chủ đề, thiếu quyền, chờ xác nhận dừng và cần can thiệp.

Không mặc định đưa mọi phiên OpenCode hoặc phiên con của tác nhân vào nhóm.
Việc gắn phiên có sẵn phải kiểm tra quyền và liên kết đang tồn tại, không làm
lộ phiên của cuộc hội thoại khác.

### Chủ đề riêng — nơi làm việc

- Tin nhắn được gửi tới đúng phiên đã gắn, không có bước tự tạo phiên thay thế.
- Câu trả lời, câu hỏi, xin quyền và tiến độ trở về đúng chủ đề đó.
- Cho phép thao tác công việc như xem trạng thái và dừng lượt xử lý.
- Không cho `/new`, `/use`, `/clear` hay bất kỳ nút cũ nào thay liên kết.
- Nếu liên kết mất/hỏng hoặc phiên đã bị xóa: báo rõ và dẫn về General;
  tuyệt đối không tự tạo phiên mới từ tin nhắn tiếp theo.

Danh mục lệnh cần khai báo phạm vi dùng. Lệnh và nút bấm phải qua cùng kiểm tra,
không chỉ ẩn nút hoặc kiểm tra tên lệnh. Các đường chọn thư mục, tiếp nối mạch,
chuyển chế độ và thao tác nội bộ cũng không được âm thầm thay phiên.

## 3. Các bất biến

1. Trong phạm vi bot quản lý, một phiên chỉ có một liên kết chủ đề; một chủ đề
   chỉ gắn một phiên. Phiên không được chiếm bởi hai cuộc hội thoại.
2. Mã phiên trong liên kết không thay đổi. Đổi tên chủ đề hoặc cấu hình mô hình
   không thay đổi danh tính phiên.
3. Chỉ module quản lý vòng đời phiên–chủ đề được tạo/sửa liên kết; các bộ xử lý
   lệnh, sự kiện và lịch không tự ghi `sessionID`.
4. Lưu trữ không gỡ liên kết. Mở lại dùng chủ đề cũ, không sinh bản trùng.
5. Trạng thái thực thi và trạng thái vòng đời độc lập: đang rảnh, chạy, chờ câu
   hỏi, thành công hay thất bại không tự đồng nghĩa đã lưu trữ phiên.
6. Không nhận công việc mới vào liên kết đang tạo, đang đóng, đã đóng, cần can
   thiệp hoặc chưa đồng bộ xong.
7. Không nhả quyền sở hữu lượt chạy/slot chỉ vì chủ đề đã đóng hoặc đã gửi yêu
   cầu dừng. Việc này vẫn do chủ sở hữu lượt chạy xác nhận.

## 4. Các luồng chính

### Tạo hoặc gắn phiên từ General

1. Kiểm tra người dùng, nhóm được phép và yêu cầu trùng lặp.
2. Ghi nhận thao tác tạo cùng danh tính đối chiếu trước khi gọi hệ thống ngoài.
3. Tạo phiên và chủ đề, hoặc xác minh phiên có sẵn chưa thuộc chủ đề khác.
4. Ghi liên kết thành công trước khi nhận prompt; gửi nút đi tới chủ đề.

Nếu phiên đã có chủ đề, trả về chủ đề đó thay vì tạo thêm. Nếu thất bại giữa
chừng, giữ thông tin đủ để tìm lại tài nguyên và thông báo tại General. Telegram
không cung cấp khóa chống trùng cho tạo chủ đề: mất phản hồi không được tự gọi
lại mù quáng. Chưa rõ đã tạo hay chưa thì cần xác minh/can thiệp, chưa gửi prompt.

### Làm việc trong chủ đề

Tra liên kết cố định → kiểm tra trạng thái/quyền → giao cho chủ sở hữu lượt xử
lý → trả kết quả/câu hỏi đúng phiên và chủ đề. Kết thúc lượt chỉ cập nhật trạng
thái công việc. Không tự đóng hoặc mở lại chủ đề chỉ vì có tin nhắn mới.

### Đóng từ General

1. Ghi trạng thái đang đóng và chặn công việc mới cho liên kết.
2. Nếu còn công việc, yêu cầu chủ sở hữu lượt dừng và chờ bằng chứng kết thúc.
   Với lượt lịch, không bỏ các ràng buộc identity/recovery đã chốt trong PR1.
3. Lưu trữ đúng phiên OpenCode, sau đó đóng đúng chủ đề Telegram.
4. Chỉ báo hoàn tất khi đã xác nhận các bước cần thiết. Lỗi mạng/quyền phải
   hiển thị còn bước nào chưa xong và có đường thử đồng bộ lại.

Đang đóng không phải đã đóng. Câu hỏi/quyền cũ không được tiếp tục nhận thao tác
để khởi động lại công việc sau yêu cầu dừng; vẫn giữ danh tính để đối chiếu và
dọn đúng khi kết thúc được xác nhận.

### Đóng hoặc mở lại từ OpenCode

- `session.archived`: đồng bộ đóng chủ đề tương ứng; không suy ra rằng mọi
  execution đã dừng và không nhả slot dựa trên sự kiện lưu trữ.
- `session.unarchived`: đồng bộ mở lại chủ đề cũ sau khi xác minh phiên/liên kết.
- `session.deleted`: đóng chủ đề, đánh dấu phiên không còn; không xóa lịch sử
  Telegram hoặc tự tạo phiên thay thế.
- Sự kiện thành công/thất bại/ngắt lượt xử lý chỉ cập nhật công việc.

Kết nối lại hoặc bot khởi động lại phải đối chiếu trạng thái phiên hiện tại,
không chỉ nghe sự kiện trực tiếp. Chỉ coi phiên mất khi nhận lỗi không tìm thấy
đúng nghĩa; lỗi quyền/kết nối không phải bằng chứng phiên đã bị xóa.

Đồng bộ trạng thái lưu trữ hiện tại không thay thế đọc bù lịch sử execution:
giới hạn durable replay của OpenCode hiện tại vẫn chặn phần recovery lịch PR1,
nhưng không mặc định chặn toàn bộ chức năng quản trị phiên–chủ đề.

## 5. Module sở hữu vòng đời

Module `SessionTopics` nhận các yêu cầu nghiệp vụ tạo/gắn, đóng,
mở lại, tra cứu và đối chiếu. Module sở hữu toàn bộ:

- Liên kết cố định, kiểm tra duy nhất và điều phối đồng thời theo liên kết.
- Trạng thái tạo/mở/đang đóng/đã đóng/đồng bộ lỗi/phiên mất.
- Thao tác dở dang, chống bấm trùng, xử lý lỗi từng phần và khôi phục sau restart.
- Áp dụng chính sách chung cho lệnh, nút bấm và sự kiện OpenCode.

Ẩn chi tiết thứ tự gọi Telegram/OpenCode và lưu trạng thái khỏi bên gọi. Giữ
JSON hiện có với phiên bản/migration rõ ràng; không thêm database hay lớp lưu
trữ tổng quát chỉ vì thiết kế mới. Bên gọi không nhận tham chiếu mutable để tự
thay liên kết. `StateManager` không trở thành chủ sở hữu vòng đời thứ hai.

Chủ sở hữu lượt xử lý vẫn chịu trách nhiệm prompt, capacity, deadline, dừng và
bằng chứng kết thúc. `SessionTopics` phối hợp với chủ sở hữu đó, không tạo một
cơ chế theo dõi execution cạnh tranh. Hai hệ thống ngoài không có transaction
chung: trạng thái chờ đồng bộ phải hiển thị được, không giả định atomic.

## 6. Hệ quả với các tính năng hiện có

- **Lịch:** mỗi lượt theo thiết kế PR1 dùng phiên mới, nên cần chủ đề mới và
  danh tính worker riêng cho lượt đó. Không tìm worker cũ rồi thay phiên trong
  chủ đề của nó. Lịch và lượt chạy lịch vẫn là hai khái niệm khác nhau.
- **Tiếp nối/fork:** nếu giữ tính năng, thực hiện từ General và mở chủ đề mới;
  không thay phiên nguồn hoặc tự đóng phiên nguồn.
- **Manager:** nếu giữ tác nhân này, cần chủ đề/phiên riêng. Quyền giao việc và
  chính sách duyệt quản lý ở General; không biến General trở lại thành phiên
  LLM. Mã hiện tại mở/mở lại chủ đề Manager bằng `/manager on` và lưu trữ bằng
  `/manager off`; thẻ duyệt giao việc ở General.
- **Mô hình/tác nhân/thư mục:** các thay đổi có thể áp dụng vào phiên hiện tại
  không được lén tạo phiên khác. Thao tác bắt buộc phiên mới phải trở về General.
- **Xóa chủ đề ngoài bot:** không xem đó là đồng ý xóa phiên hoặc worktree.
  Phương án sửa liên kết/tạo lại chủ đề cần chốt; trước hết giữ dữ liệu và báo lỗi.

## 7. Chuyển đổi và kiểm chứng

Không tự dọn các phiên/liên kết cũ trong lúc triển khai thiết kế:

1. Sao lưu và khảo sát state: phiên dùng chung, phiên trong chat chính, chủ đề
   không có phiên, thao tác đang chạy và trạng thái lưu trữ.
2. Đưa quyền sở hữu liên kết về module mới; thêm kiểm thử qua các luồng nghiệp
   vụ trước khi thay bộ định tuyến lệnh.
3. Áp dụng phân phạm vi General/chủ đề cho cả lệnh, nút và đường gọi nội bộ.
4. Thay auto-close theo kết thúc lượt bằng đồng bộ theo vòng đời phiên.
5. Chuyển lịch/Manager và liên kết cũ theo phương án được duyệt; không âm thầm
   cắt phiên đang xử lý hoặc chuyển hội thoại hiện tại của người dùng.
6. Kiểm thử nhóm Telegram riêng, sau đó mới triển khai bot; không chạy hai bot
   polling cùng token và không thay máy chủ OpenCode ngoài phạm vi được duyệt.

Các ca bắt buộc: hai yêu cầu tạo/gắn đồng thời; một phiên bị gắn hai nơi; mọi
đường thay phiên từ chủ đề bị chặn; kết thúc lượt không đóng chủ đề; đóng khi
đang chạy/chờ câu hỏi/mất kết nối; sự kiện cũ đến muộn; thiếu quyền Telegram;
archive thành công nhưng đóng chủ đề lỗi; mất phản hồi tạo chủ đề; restart giữa
thao tác; sự kiện archive/unarchive/delete bị lỡ; lượt lịch mới không thay liên
kết cũ; không xóa dữ liệu khi người dùng chỉ muốn đóng.

## 8. Các điểm chưa chốt

- Nhóm Telegram cụ thể và quyền quản lý chủ đề của bot; chưa thay cấu hình.
- Chính sách giữ/mở lại các phiên cũ đang nằm ngoài nhóm mới.
- Lượt lịch đã hoàn tất có tự lưu trữ phiên theo chính sách riêng hay chờ thao
  tác ở General. Mặc định hiện tại là chờ thao tác ở General, không tự lưu trữ.
- Chính sách tự động hóa sâu hơn cho Manager; mặc định vẫn cần duyệt giao việc.

## 9. Căn cứ kỹ thuật

- Kiểm tra trước khi triển khai cho thấy `/new` thay phiên trong cùng chủ đề, `/use`
  cho gắn trùng, bộ định tuyến bỏ qua archive/delete, và auto-close hiện chạy
  theo kết thúc lượt. Bộ kiểm chứng tạm:
  `T/opencode/audit-session-topic.mts` trong thư mục tạm được cấp của môi trường.
- [OpenCode V2 HTTP API](https://opencode.ai/v2/docs/api): cập nhật phiên có
  `archived`; OpenAPI máy chủ hiện chạy cũng đã được đối chiếu.
- [Sự kiện OpenCode 2.1.4](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts):
  `session.archived`, `session.unarchived`, `session.deleted` độc lập với execution.
- Telegram: [đóng chủ đề](https://core.telegram.org/bots/api#closeforumtopic),
  [mở lại chủ đề](https://core.telegram.org/bots/api#reopenforumtopic). Bot cần
  quyền phù hợp trong supergroup; tên phương thức mở lại là `reopenForumTopic`,
  không phải `openForumTopic`. Không nuốt mọi lỗi rồi báo đóng/mở thành công.

## 10. Phần đã kiểm chứng và giới hạn

- `npm run test:session-topics`: giao diện module, lệnh/nút công khai và hai
  adapter; bao gồm dừng chưa xác nhận, slot của lượt lịch, gắn phiên trùng,
  lỗi từng phần, crash và sự kiện muộn.
- `npm run smoke:session-topics`: OpenCode thật, phiên rỗng riêng, Telegram giả
  lập; kiểm chứng archive/restore/delete và khởi động lại trạng thái bot mà
  không gửi prompt LLM hay thay chủ đề Telegram thật.
- Tạo tài nguyên không rõ kết quả được giữ để can thiệp, không tự tạo lại.
  Phiên bản trạng thái không hỗ trợ hoặc danh tính mâu thuẫn bị chặn an toàn.
- Chuyển phiên khác chat, sửa chủ đề đã bị xóa và xóa dữ liệu vĩnh viễn chưa
  được tự động hóa. Các thao tác này không đi kèm triển khai chế độ mới.
