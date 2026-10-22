# Đánh giá ứng dụng OpenCode Telegram Bot

- **Ngày đánh giá:** 21/10/2026
- **Phiên bản trong `package.json`:** `0.1.0`
- **Phạm vi:** mã nguồn, cấu hình mẫu, tài liệu và script kiểm tra tại thời điểm khảo sát.

## 1. Kết luận tổng quan

Ứng dụng là một công cụ điều khiển OpenCode từ Telegram, phù hợp cho lập trình viên sử dụng cá nhân. Các tính năng chính khá đầy đủ, đặc biệt là duyệt thư mục và trả lời câu hỏi của agent bằng nút bấm.

Đây là **MVP có giá trị sử dụng thực tế**, nhưng cơ chế phục hồi tác vụ, quản lý session và xử lý lỗi còn cần hoàn thiện trước khi dùng chung cho nhiều người hoặc vận hành liên tục.

Ưu tiên phát triển tiếp theo nên là **độ tin cậy của luồng thực thi và phục hồi**, trước khi mở rộng thêm tính năng.

## 2. Phương pháp và giới hạn đánh giá

Các hoạt động đã thực hiện:

- Đọc toàn bộ mã nguồn trong `src/`, hai script trong `scripts/`, README, bài viết giới thiệu và cấu hình mẫu.
- Phân tích cấu trúc, độ phức tạp và quan hệ gọi hàm.
- Cài dependencies theo lockfile và chạy `npm run typecheck`: **thành công**.
- Chạy mô phỏng cục bộ với client giả lập và thư mục tạm để kiểm chứng các hành vi cụ thể.

Các mô phỏng không gọi Telegram hoặc OpenCode thật. Chưa chạy kiểm thử end-to-end, tải lớn hoặc kiểm toán bảo mật đầy đủ. Những nhận định về rủi ro vận hành được suy ra từ mã nguồn; không có nghĩa sự cố đó đã xảy ra trong môi trường thực tế.

Các vị trí dòng được dẫn bên dưới tương ứng với mã nguồn tại thời điểm khảo sát và có thể thay đổi khi dự án được cập nhật.

## 3. Kiến trúc và công nghệ

```text
Telegram ↔ Bot Node.js/TypeScript ↔ OpenCode service ↔ Agent/model
                    ↓
               state.json
```

Bot là lớp cầu nối. Khả năng đọc code, sửa file, chạy lệnh và suy luận đến từ OpenCode và model được cấu hình.

| Thành phần | Vai trò |
| --- | --- |
| `src/index.ts` | Khởi động, kết nối service, chạy polling và xử lý tín hiệu dừng. |
| `src/config.ts` | Đọc biến môi trường và kiểm tra cấu hình. |
| `src/telegram.ts` | Gọi Telegram Bot API bằng `fetch`, nhận update qua long polling. |
| `src/opencode.ts` | Bao bọc OpenCode client, quản lý session, prompt và event stream. |
| `src/bot.ts` | Điều phối lệnh, tác vụ nền, trình duyệt thư mục và câu hỏi tương tác. |
| `src/state.ts` | Lưu cấu hình theo chat vào JSON. |
| `src/fsbrowser.ts` | Liệt kê và điều hướng thư mục. |
| `src/format.ts` | Escape, chuyển Markdown sang HTML và chia tin nhắn dài. |

Ứng dụng dùng Node.js 20+, TypeScript strict và một dependency nghiệp vụ chính là `@opencode/client`. Không cần database riêng hoặc public endpoint để nhận Telegram update.

## 4. Tính năng hiện có

| Nhóm tính năng | Khả năng |
| --- | --- |
| Giao việc bằng tin nhắn | Gửi nội dung Telegram thành prompt; trả câu trả lời, kết quả thực thi và thời gian xử lý. |
| Quản lý session | Tạo mới, liệt kê, chuyển session; xem lịch sử và trạng thái. |
| Chọn project | Đặt thư mục bằng `/dir`; duyệt bằng `/browse` với nút bấm, phân trang và tùy chọn hiện thư mục ẩn. |
| Chọn model và agent | Liệt kê và yêu cầu chuyển model/agent cho session. |
| Hỏi đáp tương tác | Hiển thị câu hỏi của OpenCode dưới dạng nút lựa chọn; nhận câu trả lời tự nhập và hỗ trợ hủy. |
| Điều khiển tác vụ | Prompt chạy nền; `/stop` yêu cầu ngắt. Mỗi chat chỉ nhận một prompt đang chạy qua bot. |
| Ghi nhớ cấu hình chat | Lưu session, thư mục, model và agent vào JSON để dùng lại sau restart. |
| Kiểm soát truy cập | Allowlist theo Telegram user ID, áp dụng cho tin nhắn và callback từ nút bấm. |
| Kết nối | Tự tìm OpenCode service, hỗ trợ URL chỉ định, thông tin Basic Auth và retry một số lỗi mạng. |
| Trình bày kết quả | Chuyển một tập con Markdown sang HTML, loại bỏ tag nội bộ và chia phản hồi dài. |

### Giới hạn tính năng

- Chỉ xử lý đầu vào văn bản; chưa hỗ trợ ảnh, giọng nói hoặc file đính kèm.
- Chưa có hàng đợi công việc; tin nhắn mới bị từ chối khi chat còn tác vụ đang chạy.
- Chưa hiển thị tiến độ thực thi hoặc nội dung trả lời liên tục trong quá trình chạy.
- Ghi nhớ cấu hình chat chưa bao gồm phục hồi tác vụ đang chạy hoặc kết quả chưa gửi.
- Hỗ trợ câu hỏi chọn nhiều đáp án còn thiếu, như mô tả tại mục 6.6.

## 5. Điểm mạnh

### 5.1. Thiết kế gọn, dễ triển khai

- Ít dependency, không cần framework bot hoặc database riêng.
- Long polling giúp triển khai trên máy cá nhân mà không cần cấu hình webhook/public endpoint.
- Các phần kết nối, lưu trạng thái, duyệt thư mục và định dạng đã được tách thành các file riêng.
- README có hướng dẫn thiết lập, biến môi trường, lệnh sử dụng và xử lý sự cố cơ bản.

### 5.2. Trải nghiệm trên điện thoại thực dụng

Duyệt project bằng nút bấm và trả lời câu hỏi của agent ngay trong Telegram là hai điểm nổi bật. Người dùng có thể chọn nơi làm việc và cung cấp quyết định cho agent mà không cần quay lại terminal.

Trình duyệt thư mục chỉnh sửa nội dung trong cùng một tin nhắn, giúp hạn chế làm đầy khung chat.

### 5.3. Có xử lý tình huống thực tế

Mã nguồn đã tính đến tác vụ dài, yêu cầu ngắt, kết nối service thay đổi, câu trả lời dài và việc lấy nhầm phản hồi của lượt trước. Đây là nền tảng tốt, dù một số cơ chế cần hoàn thiện để xử lý chính xác khi có sự cố.

### 5.4. Có kiểm soát truy cập mặc định

Cấu hình yêu cầu allowlist nếu không chủ động bật chế độ cho phép mọi người. Việc kiểm tra user ID được áp dụng cho cả tin nhắn và callback.

### 5.5. Có nền tảng kiểm tra tĩnh

TypeScript strict được bật và `npm run typecheck` chạy thành công sau khi cài dependencies. Phân tích cấu trúc không phát hiện vòng lặp import.

## 6. Điểm yếu và vấn đề cần cải thiện

### 6.1. Có thể chạy trùng yêu cầu khi mất kết nối

**Mức ưu tiên: cao. Bằng chứng: đã mô phỏng cục bộ.**

Khi lỗi mạng xảy ra ở bước chờ kết quả, `runPromptTask` reconnect rồi chạy lại toàn bộ `promptAndWait`, bao gồm gửi prompt lần nữa.

Mô phỏng một yêu cầu người dùng, với bước gửi prompt thành công nhưng bước chờ lỗi mạng, cho kết quả:

```json
{
  "userRequests": 1,
  "acceptedPromptCalls": 2,
  "waitCalls": 4,
  "reconnects": 1
}
```

Ngoài ra, lỗi transport ở bước gửi không chứng minh server chưa nhận yêu cầu. Retry thao tác tạo/gửi cần xét đến khả năng yêu cầu đã được xử lý nhưng phản hồi bị mất.

**Ảnh hưởng:** có thể tăng chi phí model, lặp công việc hoặc lặp thao tác sửa file/chạy lệnh.

**Hướng cải thiện:** tách gửi prompt khỏi chờ kết quả; sau reconnect, đối soát tác vụ hiện tại trước khi quyết định gửi lại. Dùng cơ chế chống trùng yêu cầu nếu hợp đồng API hỗ trợ.

**Vị trí:** `src/bot.ts:222`, `src/opencode.ts:227`.

### 6.2. Phục hồi sau restart hoặc mất event chưa đầy đủ

**Mức ưu tiên: cao. Bằng chứng: mã nguồn và hợp đồng event stream.**

File JSON chỉ lưu cấu hình chat. Tác vụ đang chạy, câu hỏi đang chờ và trạng thái trình duyệt thư mục nằm trong RAM. Chưa có bản ghi kết quả nào đã gửi hoặc đang chờ gửi.

Bot có hàm `listForms` nhưng chưa gọi để khôi phục câu hỏi chờ khi khởi động hoặc reconnect. Event stream của client chỉ cung cấp sự kiện trực tiếp, không phát lại sự kiện đã bỏ lỡ.

**Ảnh hưởng:** restart có thể làm mất bước chuyển kết quả về Telegram; câu hỏi phát sinh trong khoảng mất kết nối có thể không được hiển thị để người dùng trả lời.

**Hướng cải thiện:** lưu trạng thái vòng đời tác vụ và tiến độ giao kết quả; đối soát session và form đang chờ khi khởi động/reconnect.

**Vị trí:** `src/state.ts`, `src/bot.ts:93`, `src/opencode.ts:305`.

### 6.3. Vòng đời session thiếu nhất quán

**Mức ưu tiên: cao. Bằng chứng: mã nguồn và mô phỏng cục bộ.**

- `/new` hủy việc chờ ở bot nhưng không gọi interrupt session cũ trên OpenCode. `/clear` và thao tác mở session từ trình duyệt cũng dùng cơ chế hủy cục bộ này.
- Cờ `guided` không được reset khi tạo session mới, khiến hướng dẫn sử dụng question tool có thể không được gửi cho session mới.
- `/use` chỉ ghi session ID, chưa kiểm tra session tồn tại hoặc đồng bộ thư mục/model/agent. Lệnh này cũng không xử lý tác vụ đang chạy trước khi chuyển liên kết session.

**Ảnh hưởng:** tác vụ cũ có thể tiếp tục chạy sau khi người dùng chuyển ngữ cảnh; trạng thái hiển thị có thể không khớp session thực tế.

**Hướng cải thiện:** thống nhất quy trình dừng, tạo và chuyển session; phân biệt hủy chờ cục bộ với ngắt thực thi phía service; lưu/reset thông tin hướng dẫn theo session.

**Vị trí:** `src/bot.ts:257`, `292`, `314`, `531`, `659`.

### 6.4. Chưa có cách ly quyền theo người dùng và project

**Mức ưu tiên: cao nếu dùng chung. Bằng chứng: mã nguồn và mô phỏng symlink.**

Allowlist xác định ai được dùng bot, nhưng chưa xác định người đó được dùng session hoặc project nào:

- `/ls` lấy danh sách session từ service chung.
- `/use` nhận session ID trực tiếp, chưa kiểm tra quyền sở hữu.
- Trạng thái gắn theo chat, không phải từng người trong một nhóm.
- `/dir` không áp dụng giới hạn browse roots.

Giới hạn `/browse` kiểm tra đường dẫn dạng chuỗi bằng `resolve`, trong khi trình duyệt cho phép đi vào symlink trỏ đến thư mục. Mô phỏng xác nhận một symlink bên trong root cho phép vẫn duyệt được thư mục đích bên ngoài root.

**Ảnh hưởng:** browse roots chưa phải ranh giới bảo mật; người dùng được allowlist có quyền thao tác rộng trên service chung.

**Hướng cải thiện:** xác định rõ mô hình sử dụng cá nhân hay nhiều người dùng; nếu cần cách ly, kiểm tra quyền sở hữu session/project và đường dẫn thực sau khi phân giải symlink.

**Vị trí:** `src/fsbrowser.ts:14–41`, `src/bot.ts:303–330`, `src/state.ts:53–58`.

### 6.5. Cấu hình và thông báo thành công có thể không phản ánh thực tế

**Mức ưu tiên: trung bình. Bằng chứng: đã mô phỏng cục bộ.**

- `OPENCODE_DEFAULT_AGENT` và `OPENCODE_DEFAULT_MODEL_*` được đọc vào cấu hình nhưng chưa được dùng khi tạo session.
- `/model` và `/agent` ghi state trước khi gọi API; nếu API thất bại, lỗi chỉ được log nhưng bot vẫn thông báo đã áp dụng cho session hiện tại.

Mô phỏng API chuyển model thất bại vẫn nhận được phản hồi thành công từ bot.

**Ảnh hưởng:** người dùng có thể tưởng đang dùng model/agent mong muốn trong khi session thực tế chưa đổi.

**Hướng cải thiện:** áp dụng default khi khởi tạo; chỉ xác nhận thành công và đồng bộ trạng thái sau khi thao tác phía service thành công.

**Vị trí:** `src/config.ts:78–82`, `src/bot.ts:584–619`.

### 6.6. Relay câu hỏi chưa hỗ trợ đầy đủ kiểu dữ liệu

**Mức ưu tiên: trung bình. Bằng chứng: đã mô phỏng cục bộ.**

Với field `multiselect`, bot gửi ngay một giá trị đơn sau lần bấm đầu tiên, thay vì thu thập danh sách lựa chọn. Mô phỏng cho kết quả `{"q":"A"}`.

Nhập tự do cũng được chuyển thành chuỗi, chưa có xử lý riêng cho kiểu boolean, number hoặc integer.

**Ảnh hưởng:** một số form có thể bị từ chối hoặc nhận dữ liệu không đúng kiểu yêu cầu.

**Hướng cải thiện:** xử lý theo loại field; với multiselect, bổ sung trạng thái chọn nhiều và nút xác nhận trước khi gửi.

**Vị trí:** `src/bot.ts:732–844`.

### 6.7. Độ bền lưu trữ và gửi tin còn hạn chế

**Mức ưu tiên: trung bình đến cao tùy yêu cầu vận hành. Bằng chứng: mã nguồn.**

- JSON được ghi trực tiếp, chưa có ghi nguyên tử hoặc backup.
- Lỗi đọc/ghi state bị bỏ qua, có thể mất trạng thái mà không có cảnh báo.
- Xử lý Telegram 429 hiện nằm ở vòng nhận update; gửi kết quả chưa có hàng đợi hoặc retry tương ứng.
- Chưa có cơ chế lưu kết quả chưa gửi để tiếp tục giao sau sự cố.
- `editMessageText` bỏ qua mọi lỗi 400, dù không phải lỗi 400 nào cũng là trường hợp nội dung không thay đổi.

**Ảnh hưởng:** OpenCode có thể đã hoàn thành công việc nhưng người dùng không nhận được kết quả hoặc thấy giao diện cũ.

**Hướng cải thiện:** ghi state nguyên tử, báo lỗi lưu trữ, quản lý hàng đợi gửi và phân loại lỗi Telegram theo nguyên nhân.

**Vị trí:** `src/state.ts:27–67`, `src/telegram.ts:45–85`, `103–122`, `147–175`.

### 6.8. Kiểm thử và khả năng bảo trì còn yếu

**Mức ưu tiên: trung bình. Bằng chứng: cấu trúc mã nguồn và script kiểm tra.**

- Script smoke chủ yếu in kết quả. Một số điều kiện không đạt chỉ được log, không làm tiến trình kiểm thử thất bại.
- Smoke phụ thuộc OpenCode thật; chưa có bộ kiểm thử độc lập cho lỗi mạng, restart và chuyển session.
- `scripts/` chưa nằm trong phạm vi typecheck của `tsconfig.json`.
- `src/bot.ts` dài 846 dòng, tập trung routing, tác vụ, trình duyệt thư mục và form.
- Có nhiều `any`, đặc biệt quanh client, làm giảm khả năng phát hiện sai hợp đồng API khi typecheck.

**Ảnh hưởng:** khó phát hiện hồi quy và khó thay đổi một chức năng mà không ảnh hưởng chức năng khác.

**Hướng cải thiện:** ưu tiên kiểm thử hồi quy cho các lỗi đã xác nhận; tách điều phối tác vụ, trình duyệt thư mục và form khi cần thay đổi các phần đó; tận dụng kiểu dữ liệu của client.

**Vị trí:** `scripts/smoke.ts`, `scripts/test-question.ts`, `tsconfig.json`, `src/bot.ts`, `src/opencode.ts`.

## 7. Lộ trình cải thiện đề xuất

| Thứ tự | Công việc | Kết quả cần đạt |
| --- | --- | --- |
| 1 | Tách retry gửi prompt khỏi retry chờ kết quả. | Lỗi ở bước chờ không làm gửi lại prompt đã được nhận. |
| 2 | Chuẩn hóa dừng/chuyển session và phục hồi sau restart/reconnect. | Tác vụ cũ được xử lý rõ ràng; tìm lại được câu hỏi chờ và kết quả chưa gửi. |
| 3 | Sửa default model/agent, thông báo thành công sai và multiselect. | Cấu hình có hiệu lực, thông báo đúng trạng thái, form gửi đúng kiểu dữ liệu. |
| 4 | Xác định và thực thi mô hình quyền session/project. | Nếu dùng chung, mỗi người chỉ truy cập đúng phạm vi được cấp; giới hạn thư mục xét đường dẫn thực. |
| 5 | Làm bền lưu trữ và giao kết quả. | Sự cố ghi file hoặc Telegram không làm mất trạng thái/kết quả một cách âm thầm. |
| 6 | Bổ sung kiểm thử hồi quy và cải thiện cấu trúc. | Các tình huống lỗi quan trọng được kiểm tra tự động, độc lập với model/service thật. |

Nếu triển khai cho nhiều người dùng ngay từ đầu, mục quyền truy cập cần được đưa lên cùng nhóm ưu tiên cao nhất.

## 8. Mức độ phù hợp sử dụng

| Bối cảnh | Đánh giá |
| --- | --- |
| Cá nhân điều khiển OpenCode trên máy của mình | Phù hợp về tính năng; cần chú ý các lỗi retry và vòng đời session đã xác nhận. |
| Nhóm nhỏ, cùng mức tin cậy và quyền trên máy | Có thể cân nhắc sau khi cải thiện độ tin cậy; chưa có cách ly session/project. |
| Dịch vụ nhiều người dùng cần phân quyền độc lập | Chưa đáp ứng về cách ly quyền, phục hồi và kiểm soát vòng đời tác vụ. |
| Vận hành liên tục, yêu cầu không mất hoặc lặp công việc | Cần hoàn thiện chống trùng, lưu trạng thái tác vụ và cơ chế giao kết quả bền vững. |

## 9. Tài liệu tham chiếu

- [Hướng dẫn dự án](../README.md).
- [Bài viết về quá trình phát triển](../blog-vi.md).
- [Cấu hình mẫu](../.env.example).
- [OpenCode V2 JavaScript client](https://opencode.ai/v2/docs/build/client): cách kết nối, request options và đặc tính event stream trực tiếp, không replay.
