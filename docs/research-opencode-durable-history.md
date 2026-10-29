# Khảo sát durable session event replay của OpenCode V2

Ngày khảo sát: **28/10/2026**. Phạm vi: chỉ đọc tài liệu V2, source/tag/commit và metadata phát hành công khai. **Khảo sát này chưa được duyệt triển khai thay đổi OpenCode, chuyển kiến trúc bot sang SDK, nâng phiên bản hoặc khởi động lại máy chủ.** Không tạo host SDK, session, prompt, không thử ghi lại, không đọc/sửa database. Agent khảo sát không gọi API local; phiên cha chỉ đọc thông tin phiên bản/tính năng, không gọi API ghi trong giai đoạn khảo sát.

## 1. Kết luận để quyết định

1. **Có đường bật persistence hợp lệ ngay trong source release `v2.1.4`:** `ServerOptions.events.persist`, được chuyển tới `Bus.configured({ persist: ... })`. Promise SDK và Effect SDK đều nhận tùy chọn **`events: { persist: true }`** qua `OpenCode.create(...)`. Test upstream xác nhận nhận tùy chọn và replay được payload. Không cần tự thay Bus nếu dùng đường này. [S2][S3][S4][S5][S6]
2. **Không tìm thấy đường bật cho CLI/shared service chuẩn bằng `opencode.json(c)`, biến môi trường hay CLI flag** trong các đường khởi tạo đã kiểm tra của `v2.1.4`. CLI gọi server với danh sách tùy chọn tường minh nhưng không truyền `events`. `service.json` cũng không có trường đó. Đây là thiếu đường nối từ CLI tới tùy chọn server, không phải HTTP client chưa biết bật một tham số. [S7][S8][S9][S10]
3. **Mặc định `persist=false` giải thích rất sát hiện tượng đã báo:** sequence và projection vẫn được ghi, nhưng payload không được giữ; `log.synced.seq` tăng không chứng minh có lịch sử để đọc bù. `follow=true` của session log cũng đọc payload từ kho event sau mỗi thông báo, không phải chuyển sang live payload trực tiếp. Kênh `event.subscribe` riêng vẫn phát live nhưng không bù được lúc mất kết nối. [S1][S11][S12]
4. **Không nên nâng lên `2.2.0` chỉ để mong tự hết lỗi:** source tag `v2.2.0` vẫn mặc định `false`; thay đổi liên quan được phát hành là tối ưu bỏ encode payload không lưu, không phải bật durable replay cho CLI. [S16][S17][S18]
5. **Không thể bổ sung payload quá khứ chưa được lưu.** Bật tùy chọn chỉ bảo đảm lưu các event được commit sau khi host đã dùng cấu hình mới. Sequence/projection hiện có không phải bản sao của toàn bộ lịch sử event. Không được suy execution từ latest outcome, coi marker là payload, hay gửi lại prompt để “khôi phục”. [S1][S11][S19]

**Khuyến nghị:** giữ fail-closed hiện tại. Nếu muốn giữ bot dùng HTTP như hiện nay, xin duyệt riêng một trong hai phương án A/B ở mục 6. Không có thay đổi triển khai nào đã được thực hiện bởi khảo sát này.

## 2. Độ tin cậy và phiên bản

### Bằng chứng local do phiên cha cung cấp, không tái kiểm thử

- Server báo `2.1.4`, client cài `@opencode/client` `2.1.2`.
- Client và HTTP `GET /api/experimental/session/{id}/log?after=0&follow=false` chỉ nhận `log.synced` có sequence tăng, không có payload.
- Controlled session đã được tạo rồi đổi tên nhưng không replay được event; mã PR1 mới đã được kiểm thử chặn trước admission, **chưa triển khai lên bot đang vận hành**.

Đây là **đầu vào khảo sát**, không phải phép đo mới trong tài liệu. Không lặp lại thử ghi. Không đưa session ID, nội dung hội thoại, credential hay auth header vào báo cáo.

### Source đã khóa phiên bản

| Mốc | Commit SHA đã xác minh | Ý nghĩa |
| --- | --- | --- |
| Tag `v2.1.4` | `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824` | Nguồn chính cho kết luận về phiên bản server được báo. |
| Tag `v2.2.0` | `1097e2668b1e08ad63bdf0b1c4860b9bc01e420c` | Đối chiếu phiên bản mới hơn, không cài đặt. |
| Nhánh `dev` tại lúc đọc | `45b53fe6fee909dbf6a24e6ee067d420c27202ff` | Chỉ bổ trợ lịch sử upstream, không thay cho source release. |

Các ref được kiểm tra qua GitHub API; npm công khai có `2.1.4` và tại thời điểm khảo sát trỏ `latest` của SDK/server/CLI/client tới `2.2.0`. [S20][S21]

**Giới hạn:** đã tìm được source đúng **tag release `v2.1.4`**, không còn chỉ dựa vào `dev`. Tuy nhiên chưa xác minh checksum/provenance của binary đang chạy để chứng minh binary local được build đúng commit tag này; chưa chạy thử cấu hình persistence trên binary đó. Tài liệu V2 trên website là tài liệu hiện hành, không phải snapshot riêng cho `2.1.4`; các chi tiết quyết định dưới đây đều đối chiếu source tag. [S20][D1][D2][D3]

## 3. Cơ chế replay và ảnh hưởng của `persist=false`

### 3.1 Ghi event khác với giữ event payload

Trong `packages/core/src/bus.ts` của `v2.1.4`:

- `Options.persist?: boolean`, mặc định `const persist = options?.persist ?? false`; `Bus.node = configured()`.
- Durable publish chạy projector và commit hook trong transaction, cập nhật `EventSequenceTable` dù không bật persistence.
- Insert payload vào `EventTable` được đặt dưới `if (persist)`; đường batch `publishAll` cũng như vậy.
- Sau commit, Bus đánh thức các reader durable và `notify` cho listener/live subscriber. Vì vậy tên loại event là `durable` và event có sequence **không đồng nghĩa payload đang được giữ lại**. [S1]

Test upstream **`projects durable events without retaining their payloads`** chạy với Bus mặc định: projection tồn tại, sequence là `0`, `EventTable` rỗng. Đây là bằng chứng test trực tiếp, không chỉ suy luận từ tên tùy chọn. [S11]

### 3.2 Đọc lịch sử và theo đuôi

Đường gọi thực tế:

```text
GET /api/experimental/session/:sessionID/log
  -> handler session.log({ sessionID, after, follow })
  -> Session.log kiểm tra session tồn tại
  -> Bus.log({ aggregateID: sessionID, after, follow })
  -> lọc durable session events và giữ log.synced
```

Endpoint chỉ có `after` và `follow`, không có tùy chọn bật lưu payload theo request. `after` là **exclusive**; bỏ `after` khi cần đọc từ đầu. `after=0` bỏ event sequence `0`, không có nghĩa là “đọc tất cả”. Đây là chi tiết cursor cần giữ đúng khi nghiệm thu, không phải lời giải thích thay thế cho thử đổi tên đã thất bại. [S12][S13][S14]

Bus capture watermark từ bảng sequence rồi đọc các row payload trong `EventTable` có `seq > after` và `seq <= watermark`; cuối phần replay phát **một** marker `log.synced`. Với `follow=true`, Bus subscribe vào kênh wake trước khi đọc lịch sử; mỗi wake chỉ dẫn đến một lượt đọc thêm `EventTable`. **Wake không mang payload.** [S1]

Hệ quả khi không lưu payload, suy ra trực tiếp từ source:

| Đường đọc | Hành vi khi event mới không được giữ payload |
| --- | --- |
| `session.log`, `follow=false` | Có thể chỉ có marker với sequence hiện tại rồi kết thúc. |
| `session.log`, `follow=true` | Replay có thể chỉ có marker; event mới đánh thức reader nhưng reader không thấy row payload, nên không phát payload đó. Không phải cách lách persistence. |
| `event.subscribe` | Nhận payload live từ thời điểm subscribe trong cùng tiến trình; không có lịch sử trước đó hoặc qua disconnect. Không đủ cho recovery yêu cầu durable. |

Nếu database đã có event được giữ từ trước, log vẫn có thể đọc các row đó dù host hiện tắt persistence: code đọc không có điều kiện `if (persist)`. Do đó không khẳng định mọi session trên mọi máy đều luôn chỉ có marker. [S1]

**Marker không phải cam kết coverage:** source `Session.log` ghi rõ marker có thể cao hơn event cuối do các loại durable khác dùng chung không gian sequence; reader cũng bỏ loại không có trong durable manifest. Không được coi chênh lệch sequence là tự động hỏng log, cũng không được coi marker cao là chứng minh đã nhận đủ bằng chứng execution cần thiết. [S1][S14]

### 3.3 Test upstream thực sự xác nhận gì?

- Test không persistence xác nhận projection/sequence còn, payload không được giữ. Không có test trực tiếp trong phần đã đọc khẳng định `follow=true` không phát payload khi tắt persistence; kết luận đó là **phân tích đường đọc source**, không giả nhận là test đã chạy. [S1][S11]
- Các test replay/tail, handoff khi publish đúng lúc chuyển replay sang live, phân trang và marker chạy trên fixture **chủ động bật `persist:true`**. Vì vậy không thể viện các test đó để bảo đảm replay với Bus mặc định. [S11]
- Server test chấp nhận `events.persist:true`; Promise SDK test dùng tùy chọn đó và assert session log chứa `session.created`. Effect SDK embedded test cũng bật nó và đọc được `session.inbox.delivered`/`session.model.selected`. **Chỉ đọc test upstream, chưa chạy lại.** [S4][S5][S6]

## 4. Có thể bật qua bề mặt nào?

| Bề mặt | Kết quả source `v2.1.4` | Có đổi shared service đang chạy không? |
| --- | --- | --- |
| `opencode.json(c)` / `experimental` | Không có field event persistence trong `Config.Info` hoặc `ConfigExperimental.Info`. Không đưa `events.persist` vào config này. [S9][S10] | Không. |
| Env / `serve` / shared-service config | Đường `ServerProcess.run -> start(...)` không truyền `events`; schema/keys service config chỉ gồm các trường vận hành như hostname/port/cors/env. Không tìm thấy env/flag persistence có hiệu lực trong đường này. [S7][S8][S22] | Không có công tắc công khai đã xác minh. |
| HTTP `session.log` / generated network client | Chỉ yêu cầu đọc `after`/`follow`; client không sở hữu Bus server. [S12][S13][D4] | Không. Nâng client không tự bật lưu phía server. |
| `@opencode/server` bootstrap | `ServerOptions.events.persist` là tùy chọn có thật; `createRoutes` chuyển nó vào Bus; `process.start` chuyển options tới routes. [S2][S3][S15] | Chỉ khi đổi cách khởi tạo tiến trình server; không hot-toggle bằng API. |
| Promise SDK `@opencode/sdk` | `CreateOptions` kế thừa host options; host kế thừa ServerOptions. Test dùng `OpenCode.create({ events: { persist: true } })`. [S5][S6] | Tạo embedded host riêng, không cấu hình lại server hiện tại. |
| Effect SDK `@opencode/sdk/effect` | Cùng host options; `OpenCode.create` và `OpenCode.layer` nhận tùy chọn này. [S6] | Như trên. |
| Effect SDK embedding override | Tham số thứ hai `embed.overrides` được chuyển vào graph; có thể thay `Bus.node` bằng `Bus.configured({persist:true})`. Đây là seam source-level, **không cần dùng** khi `events.persist` đã đủ. [S3][S6] | Không; chỉ host mới tự sở hữu. |
| Workerd / Cloudflare Durable Objects | Tài liệu V2 nói lưu durable events cho eviction recovery; source profile ép `events:{persist:true}`. Nhưng profile thay các dịch vụ filesystem/process, không phải bản vá cấu hình nhỏ cho bot chạy workspace local. [D5][S23] | Không. Không chọn làm hướng tối thiểu ở đây. |

`events.persist` là **tùy chọn khởi tạo server/SDK**, không phải khóa cấu hình project và không phải biến môi trường đã được tài liệu hóa. SDK docs hiện không giải thích riêng trường này; sự hỗ trợ được xác nhận bằng type/source/test đúng tag, không đoán từ docs tổng quát. [D1][D2][S2][S5][S6]

Ví dụ định hình cho **phương án embedded trong tương lai**, chưa chạy và không phải hướng dẫn sửa cấu hình hiện tại:

```ts
import { OpenCode } from "@opencode/sdk"

// Chỉ dùng trong host tự sở hữu, sau khi được duyệt triển khai.
const host = await OpenCode.create({
  events: { persist: true },
  database: { path: "/duong-dan-rieng-da-duoc-duyet/opencode.db" },
})
```

**Hai điều kiện độc lập:** bật giữ payload và dùng database có lưu bền. Embedded host mặc định `database.path = ":memory:"`; chỉ bật `persist:true` mà giữ DB trong RAM không đáp ứng restart recovery. Ví dụ trên chỉ minh họa options, không bao gồm bootstrap/lifecycle hoàn chỉnh và chưa xác minh runtime/package resolution trên máy này. Không trỏ thử nghiệm vào database của shared service đang chạy. [S6][S24]

## 5. Lịch sử upstream và bản phát hành mới hơn

- Commit **`120e4e7388af61c1b9274b58a16b6e3f9878699c`**, 05/08/2026, tên `fix(core): make event persistence opt-in`, thêm mặc định `false`, tùy chọn ServerOptions và test không lưu payload. Đây là thay đổi có chủ đích của upstream, không có bằng chứng là do client `2.1.2` đọc sai payload. [S19]
- `v2.1.4` đã có đường opt-in server/SDK và test tương ứng; không cần đợi phiên bản mới chỉ để có primitive này. [S2][S4][S5][S6][S20]
- Commit **`2d91ed57aef9b9aae8c3799c50ad34968d3d6f81`**, 25/10/2026, PR **#58923**, tên `perf(core): skip encoding durable event payloads that aren't persisted`, chỉ dời encode vào đường cần lưu. Changelog `v2.2.0` nêu rõ tối ưu này; test mới `Bus without persistence` vẫn khẳng định mặc định không giữ payload. [S17][S18]
- Source `v2.2.0` giữ `persist ?? false`, ServerOptions vẫn có `events.persist`, đường CLI vẫn không truyền trường này. **Chưa tìm thấy fix phát hành biến CLI mặc định thành durable replay hoặc bổ sung công tắc CLI cho nhu cầu này trong các nguồn đã khảo sát.** Không khẳng định đã rà mọi PR chưa merge hoặc mọi nightly. [S16][S18]

## 6. Ba phương án nhỏ nhất có thể nghiệm thu

Các phương án sau là **đề xuất cần duyệt**, không phải công việc đã làm. Tất cả chỉ bảo đảm lịch sử mới từ lúc bật; **không phục hồi payload cũ chưa lưu**. Việc giữ lại snapshot/message/project vẫn có thể hữu ích cho người vận hành, nhưng không tự chứng minh được terminal thuộc đúng execution. [S1][S19]

| Phương án | Thay đổi tối thiểu | Patch upstream / build riêng? | Khởi động lại / cutover? | Dữ liệu cũ |
| --- | --- | --- | --- | --- |
| **A. Nối opt-in vào CLI/shared service** | Thêm một flag/env opt-in được kiểm tra rõ ràng, truyền `events:{persist:true}` tại bootstrap CLI; thêm test plumbing. Không đổi mặc định toàn cục nếu không cần. | **Có patch CLI**; build riêng nếu upstream chưa nhận/phát hành. | **Có**, thay binary và khởi tạo lại service sau khi duyệt; không phải config hot reload. | Chỉ các event mới được lưu. Không chữa khoảng trống cũ. |
| **B. Launcher server riêng bằng ServerOptions hiện có** | Wrapper quanh `@opencode/server/process.start` hoặc routes, truyền `events:{persist:true}`, DB lưu bền, auth và endpoint được quản lý rõ ràng; bot vẫn dùng HTTP. | **Không cần patch upstream** theo source tag; **có launcher/deployment riêng**, phải xác minh package/runtime và giữ lifecycle/auth/service discovery tương đương phần đang cần. | **Có** khởi động host mới và cutover có kiểm soát; nếu thay service hiện tại thì phải dừng/thay nó theo phê duyệt. | Có thể giữ projection nếu kế hoạch chuyển đổi được kiểm chứng; không có bảo đảm tự khôi phục event thiếu. Không vận hành hai host trên cùng DB. |
| **C. Embedded SDK cho phần scheduled execution** | Dùng Promise/Effect SDK với `events.persist:true` và DB lưu bền riêng; sửa adapter/lifecycle để bot sở hữu host. | **Không cần patch upstream**; có thay đổi ứng dụng/dependencies, không cần rebuild CLI. | Khởi tạo host mới, thường cần restart bot/cutover; **không tự động đổi shared service**. | Tạo miền identity/source mới; không tự nhập/khôi phục execution cũ. |

Cơ sở kỹ thuật cho A/B: tùy chọn và forwarding đã có, chỉ CLI thiếu forwarding. Cơ sở cho C: SDK là embedded host dùng router in-memory, không phải network client cấu hình một server từ xa. [S2][S3][S7][S15][D1][D2]

**Chọn thực dụng:** A nhỏ nhất về mô hình vận hành hiện tại nếu chấp nhận tự build; B tránh fork upstream nhưng thêm trách nhiệm vận hành/auth nên không gọi là “chỉ đổi một dòng config”. C chỉ nên chọn khi thật sự muốn ứng dụng sở hữu OpenCode, không phải lối tắt bật replay cho session nằm trên server cũ. Đây là đánh giá thiết kế, chưa phải kết quả chạy thử.

### Bộ nghiệm thu bắt buộc sau khi có phê duyệt

Chỉ chạy ở môi trường/host kiểm thử được duyệt; không thực hiện trong khảo sát này:

1. **Kiểm tra capability có payload:** session kiểm thử mới có create/update event phải replay được qua HTTP/client, không chỉ marker; đọc từ đầu bằng cách bỏ `after`, kiểm tra exclusive cursor. Thử `follow=false` và `follow=true`, bao gồm publish trong handoff. [S11][S12]
2. **Chứng minh lưu qua tiến trình:** đóng rồi mở lại host dùng cùng DB kiểm thử và đọc lại payload đã biết, gồm input và execution lifecycle. Đây là nghiệm thu bổ sung cần làm, không giả nhận test upstream in-memory đã chứng minh restart durability. [S6][S24]
3. **Admission:** persist run identity, session/source/project binding, message/inbox identity và baseline trước prompt. Capability chưa chứng minh được thì fail-closed trước admission. Không thay bằng “marker có seq” hoặc latest outcome.
4. **Recovery đúng execution:** ngắt observer sau admission, để execution tiếp tục, reconnect và replay từ checkpoint; chứng minh chuỗi enqueue/deliver/start/terminal thuộc đúng run; không gửi lại prompt. Test thêm terminal cũ, input ngoài, nhiều start, sai source/session/project/metadata và khởi động lại observer để bảo đảm không nhận nhầm kết quả.
5. **Ràng buộc schema:** `Execution.Started/Succeeded` chỉ có `sessionID`; failed/interrupted thêm error/reason, **không có executionID riêng** trong payload `v2.1.4`. Inbox event có `inboxID`. Vì thế identity execution phải được chứng minh bằng session được sở hữu riêng + ranh giới start event/sequence + quan hệ inbox theo thứ tự log đầy đủ; nếu không chứng minh được duy nhất thì fail-closed, không nới recovery thành “session đang idle”. [S25]
6. **Gap trước thời điểm bật:** test một run có evidence cần thiết nằm trong khoảng không lưu; phải báo chưa đủ bằng chứng và giữ recovery/conflict phù hợp, không tự kết luận success/failure, không tạo lại input. Marker không được xóa bỏ yêu cầu evidence. [S1][S14]

Mục 3–6 là tiêu chí thiết kế theo yêu cầu ownership/recovery của phiên cha, không khẳng định upstream cung cấp sẵn bảo đảm nghiệp vụ scheduled-run. Persistence chỉ cung cấp nền tảng event, không tự hoàn thiện thuật toán ownership.

## 7. Những gì còn chưa xác minh

- Binary local có đúng build từ tag `v2.1.4` không; deployment hiện dùng đường CLI chuẩn hay wrapper riêng. Không đọc credential/service config local để đoán.
- SDK/server published package trên runtime triển khai có dùng được bootstrap đề xuất ngay hay cần điều chỉnh packaging/native dependencies; chưa cài hoặc khởi tạo thử.
- Replay sau restart đột ngột, retention/dung lượng và chi phí I/O khi giữ toàn bộ payload; source đã đọc không đủ để đưa cam kết production về các điểm này.
- Với run cũ, chỉ có thể tiếp tục nếu tồn tại **bằng chứng đã được giữ độc lập từ trước và khớp đầy đủ identity**. Không có bằng chứng rằng các run đang quan tâm đã có bản lưu đó; không dùng giả thuyết này làm đường admission/recovery.

## Nguồn primary

Các URL GitHub dưới đây khóa SHA; mốc `v2.1.4` là nguồn mặc định trừ khi ghi rõ khác.

- [D1] [V2 SDK overview](https://opencode.ai/v2/docs/build/sdk).
- [D2] [V2 Effect SDK](https://opencode.ai/v2/docs/build/sdk/effect).
- [D3] [V2 API reference](https://opencode.ai/v2/docs/api).
- [D4] [V2 network client](https://opencode.ai/v2/docs/build/client).
- [D5] [V2 Cloudflare SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare).
- [S1] [`core/src/bus.ts`, `v2.1.4`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts): Options/default, commit, live notify, readAfter, subscribeDurable, log.
- [S2] [`server/src/options.ts`, dòng 19–25](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/options.ts#L19-L25).
- [S3] [`server/src/routes.ts`, dòng 81–151](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/routes.ts#L81-L151).
- [S4] [`server/test/options.test.ts`, dòng 24–26](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/test/options.test.ts#L24-L26).
- [S5] [`sdk/test/promise.test.ts`, dòng 8–25](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/test/promise.test.ts#L8-L25).
- [S6] SDK source: [`internal/host.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/host.ts), [`promise.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/promise.ts), [`opencode.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/opencode.ts), [`effect/opencode.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/effect/opencode.ts), [`test/embedded.test.ts`, dòng 199–248](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/test/embedded.test.ts#L199-L248).
- [S7] [`cli/src/server-process.ts`, dòng 66–144](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/cli/src/server-process.ts#L66-L144).
- [S8] [`cli/src/services/service-config.ts`, schema và keys dòng 15–32](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/cli/src/services/service-config.ts#L15-L32).
- [S9] [`schema/src/config.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/config.ts).
- [S10] [`schema/src/config/experimental.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/config/experimental.ts).
- [S11] [`core/test/bus.test.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/test/bus.test.ts): fixture dòng 101–112; không persistence dòng 281–299; replay/tail dòng 592–692; marker/paging/handoff dòng 1284–1407.
- [S12] [`protocol/src/groups/session.ts`, dòng 665–681](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L665-L681).
- [S13] [`server/src/handlers/session.ts`, dòng 581–589](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/handlers/session.ts#L581-L589).
- [S14] [`core/src/session.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session.ts): contract dòng 173–183; implementation dòng 435–445.
- [S15] [`server/src/process.ts`, start và forwarding dòng 48–105](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/process.ts#L48-L105).
- [S16] Source `v2.2.0`: [`core/src/bus.ts`](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/core/src/bus.ts), [`server/src/options.ts`](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/server/src/options.ts), [`cli/src/server-process.ts`](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/cli/src/server-process.ts).
- [S17] [Commit `2d91ed57…`, PR #58923](https://github.com/anomalyco/opencode/commit/2d91ed57aef9b9aae8c3799c50ad34968d3d6f81); [`bus-unpersisted.test.ts` trong `v2.2.0`](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/core/test/bus-unpersisted.test.ts).
- [S18] [Release `v2.2.0`, 27/10/2026](https://github.com/anomalyco/opencode/releases/tag/v2.2.0).
- [S19] [Commit `120e4e73…`: make event persistence opt-in](https://github.com/anomalyco/opencode/commit/120e4e7388af61c1b9274b58a16b6e3f9878699c).
- [S20] GitHub ref API: [`v2.1.4`](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v2.1.4), [`v2.2.0`](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v2.2.0), [commit dev đã đọc](https://github.com/anomalyco/opencode/commit/45b53fe6fee909dbf6a24e6ee067d420c27202ff).
- [S21] npm registry: [`@opencode/sdk`](https://registry.npmjs.org/@opencode/sdk), [`@opencode/server`](https://registry.npmjs.org/@opencode/server), [`@opencode/cli`](https://registry.npmjs.org/@opencode/cli), [`@opencode/client`](https://registry.npmjs.org/@opencode/client). Dist-tags là dữ liệu thay đổi theo thời gian.
- [S22] [`cli/src/commands/handlers/serve.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/cli/src/commands/handlers/serve.ts).
- [S23] [`server/src/workerd.ts`, dòng 66–69](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/workerd.ts#L66-L69).
- [S24] [`core/src/database/database.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/database/database.ts): Options.path dòng 21–24; layer/node mặc định memory.
- [S25] [`schema/src/session-event.ts`](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts): Base dòng 29–37; inbox dòng 208–240; execution dòng 244–263.
