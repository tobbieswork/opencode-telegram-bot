# Review: bài tra cứu "Telegram 2026 + OpenCode events"

- **Ngày:** 2026-10-22
- **Người review:** agent OpenCode (Qwen3.8-27B) trong repo `opencode-telegram-bot`
- **Mục đích:** verify + đóng góp ý kiến cho bài tra cứu Bot API 10.3 trước khi chốt scope implement. Dành cho senior agent đánh giá lại.
- **Phương pháp:** verify trực tiếp từ (a) changelog + docs chính thức `core.telegram.org/bots/api`, (b) type definitions của `@opencode/client@2.1.2` đã cài trong `node_modules/`, (c) code hiện tại của bot (`src/bot.ts`, `src/orchestrator.ts`, `src/telegram.ts`, `src/format.ts`).

## Kết luận chung

Bài tra cứu **đúng ~85%**. Hai trụ cột chiến lược — (1) Telegram 10.1+ có Rich Messages + draft streaming, (2) OpenCode phát ra cả kho event mà bot đang bỏ qua — đều **thật và đã được verify**. Tuy nhiên có **4 lỗi/sai sự thật cần sửa trước khi lập kế hoạch** và **2 synergy giá trị cao mà bài viết bỏ qua**. Ưu tiên đề xuất ở mục 5; Wave 1 đã được implement (mục 7).

---

## 1. Đã verify đúng

| Claim trong bài tra cứu | Kết quả verify |
|---|---|
| `sendRichMessage` / `sendRichMessageDraft` (API 10.1+) | ✔ Changelog 10.1 (11/06/2026) chính thức: `sendRichMessage`, `sendRichMessageDraft`, class `RichMessage`/`InputRichMessage`, field `rich_message` trong `editMessageText` |
| 10.2 thêm block input (bảng, details, map, media, thinking) | ✔ Changelog 10.2 (14/07/2026): `InputRichBlockTable/Details/Map/Animation/Audio/Photo/Video/VoiceNote/Thinking` |
| 10.3 thêm nút trong rich message, quote mở rộng, document | ✔ Changelog 10.3 (24/08/2026): `RichMessageButton`, `RichBlockButtons`, `RichBlockExpandableBlockQuotation`, `RichBlockDocument`, compact tables, ephemeral messages |
| Rich blocks native: code, bảng, block-quote, math, spoiler | ✔ + headings h1–h6, list/task list, footnote, collapsible `<details>`, media, `<tg-map>`, formula LaTeX |
| `session.text.started/ended` + `session.message.content.updated` tồn tại | ✔ Có trong `@opencode/client` types (`promise/generated/types.d.ts`) |
| `session.tool.called/success/failed`, `session.compaction.*`, `session.usage.recorded` tồn tại | ✔ Tồn tại (nhưng `usage.recorded` không dùng được như bài viết — mục 2.2) |
| Bot hiện chỉ xử lý `execution.*`, `form.*`, `permission.*` | ✔ Khớp code: `onOpenCodeEvent` trong `src/bot.ts` + đường worker trong `src/orchestrator.ts` |
| Rich messages "loại bỏ lớp bug unbalanced HTML tag" của `format.ts` | ✔ Đúng cơ chế: rich `markdown` được **Telegram parse phía server** (tương thích GFM) → code span trong backtick an toàn, không cần regex tự viết |
| Loại trừ Ephemeral/Groups/Payments/… cho bot 1:1 cá nhân | ✔ Đồng ý (ephemeral chỉ meaningful trong group) |

## 2. Lỗi / sai sự thật (phải sửa trước khi lập kế hoạch)

### 2.1 `sendMessageTextDraftAction` — KHÔNG TỒN TẠI
Method thật là:
- **`sendMessageDraft`** — stream text thường: `chat_id`, `draft_id` (phải ≠ 0), `text` ≤ **4096** ký tự, `parse_mode`. Cùng `draft_id` → animate; khác → thay thế.
- **`sendRichMessageDraft`** — stream rich message, có thêm tag `<tg-thinking>` riêng.

Typing indicator vẫn là `sendChatAction` như hiện tại.

### 2.2 `session.usage.recorded` KHÔNG phải "token/cost mỗi turn"
Payload chỉ có `source: "title" | "compaction"` — event này **chỉ fire khi sinh title và khi nén context**. Cost mỗi turn phải lấy từ:
- **`session.step.ended`** — mỗi bước LLM: `cost: MoneyUSD` + `tokens: TokenUsageInfo` (+ `files` bị đụng tới), hoặc
- **`session.usage.updated`** — cumulative theo session.

### 2.3 Draft là preview TẠM 30 giây — ràng buộc quan trọng nhất, bài viết bỏ qua
Docs `sendMessageDraft`: *"the streamed draft is ephemeral and acts as a temporary 30-second preview — once the output is finalized, you **must** call `sendMessage` with the complete message to persist it"*. Hệ quả:
- Pipeline bắt buộc: stream draft trong khi sinh → khi turn kết thúc **gửi lại bản final** bằng `sendMessage`/`sendRichMessage`.
- Bản final vẫn có limit 4096 (text) / 32768 (rich) → **chunking final vẫn cần** cho reply dài (rich giảm đáng kể nhờ limit 32K).
- Nếu bot crash giữa stream: draft tự mất sau 30s (không gây orphan message — điểm tốt).

### 2.4 Bỏ sót `session.text.delta` — event quan trọng nhất cho streaming
"Chỉ cần subscribe `text.started/ended`" là chưa đủ mô tả cơ chế: **`session.text.delta`** (`data.delta: string` per-token) mới là nguồn feed cho streaming. Cơ chế đúng: tích lũy deltas + **throttle push** (đề nghị coalesce ~150–250ms/lần push; limit broadcast Bot API ~30 msg/s).

## 3. Hai synergy giá trị cao mà bài viết BỎ QUA

1. **`session.reasoning.delta` + tag `<tg-thinking>` native.** OpenCode phát stream phần suy luận (reasoning) riêng; Telegram draft có khối "Thinking..." native đúng cho mục đích này. Với thinking model (vd Qwen3), UX là thấy cả "đang nghĩ gì" rồi mới thấy câu trả lời. Đây là detail mạnh nhất của cả bài mà bài tra cứu không nhắc.
2. **`can_stop: true` + update `stopped_message_generation`.** Draft có nút stop native: user bấm dừng → bot nhận update → gọi `session.interrupt`. Tính năng "dừng giữa chừng" gần như miễn phí, mạnh hơn /stop gõ tay.

## 4. Rủi ro bài viết chưa đề cập

- **Regression UX đã có báo cáo thực tế:** gửi tất cả message bằng rich format làm mất option **"Quote & Reply"** trên Telegram client (issue `openclaw/openclaw#92258`) — với code-bot mà user hay quote snippet, cần test trên client thật TRƯỚC khi chuyển final sang rich.
- **API mới ~3 tháng** (10.1 ra 06/2026), còn bug client: custom emoji mất khi `editMessageText`, LaTeX `\boxed{}` không render (issues telegram-bot-api #861, #880, #896).
- **Mặt tốt chưa được nhắc:** rich limit **32768 ký tự / 500 blocks** (vs 4096 hiện tại) → gần như hết việc chunk reply dài; LLM output vốn là GFM nên đường final gần như pass-through (`sendRichMessage` với field `markdown`).
- **Lưu ý:** `blocks`/`html`/`markdown` **loại trừ nhau** — mỗi message rich chỉ dùng MỘT cách mô tả nội dung.

## 5. Ưu tiên đề xuất (đã hiệu chỉnh so với bài tra cứu)

### Wave 1 — công sức nhỏ, không đụng đường send (ĐÃ LÀM, xem mục 7)
1. `setMyCommands` — menu lệnh autocomplete
2. Nhận sticker/ảnh/voice + dùng caption làm prompt text
3. **Dòng activity real-time** — `session.tool.called/success/failed` + `session.shell.*` → edit 1 message "🔧 Đang đọc src/bot.ts…". Bài tra cứu xếp item này vào "bonus" là đánh giá thấp: nó là item **giá trị/công sức cao nhất** vì không cần rich message, reuse đường `editMessageText` có sẵn

### Wave 2 — cần probe confirm events live trước (10 phút, 1 script)
4. **Draft streaming P1:** `sendMessageDraft` (plain HTML, reuse `blockToHtml` có sẵn) + `session.text.delta` throttle + `can_stop` + `reasoning.delta`. **Không cần đường render mới** → rẻ hơn bài tra cứu đánh giá.
5. Cost mỗi turn từ **`session.step.ended`** (KHÔNG phải `usage.recorded`) — hiển thị kèm footer "done · Xs"

### Wave 3 — cân nhắc sau khi test Wave 2
6. Final chuyển sang `sendRichMessage` (markdown server-side → giết nhóm bug format.ts, limit 32K) — **test Quote & Reply trước**
7. `sendRichMessageDraft` + `<tg-thinking>` (P3)

### Không làm (đồng ý bài tra cứu)
TTS voice, thread reply, alert popup, ephemeral, group/community features.

## 6. Live probe — service 2.0.23 đã phát những event gì (verify 2026-10-22)

Script: `scripts/probe-events.ts` — tạo session probe, prompt buộc dùng tool `read`, log toàn bộ event stream, xoá session. Kết quả (1 turn thật, 2 LLM steps):

```
session.execution.started → session.reasoning.delta ×4 → session.text.delta ("\n\n")
  → session.tool.input.started  {id: call_…, name: "read"}
  → session.tool.input.ended    {id, text: "{\"path\": \"src/activity.ts\"}"}
  → session.tool.called         {id, input: {path: "src/activity.ts"}, executed: false}
  → session.tool.progress       {id}
  → session.tool.success        {id, executed: false}
  → session.step.ended          {cost, tokens: {input, output, reasoning, cache}, files: []}
  → (step 2: reasoning.delta ×2, text.delta ×2)
  → session.execution.succeeded
```

**Xác nhận cho cả Wave 1 + Wave 2:**
1. **`session.tool.input.started` phát ra cho CẢ tool gọi đơn giản** (không chỉ input streamed) — đây là cách duy nhất lấy tên tool (`name: "read"`); `tool.called` KHÔNG có tên. Activity line hoạt động như thiết kế.
2. **`session.text.delta`** per-token ✓ — draft streaming (P1) khả thi.
3. **`session.reasoning.delta`** ✓ — khối `<tg-thinking>` (P3) khả thi.
4. **`session.step.ended`** mang `cost` + `tokens` + `files` ✓ — cost mỗi turn khả thi (lưu ý: `cost` = 0 với model local; tokens đầy đủ).
5. Event thêm ngoài dự đoán: `session.step.started`, `session.step.streamed`, `session.tool.input.ended` (chứa JSON input), `session.usage.updated`.
6. Text delta bắt đầu TRƯỚC tool call (model sinh text + gọi tool xen kẽ từng step) — code streaming phải xử lý cả hai luồng cùng lúc.

## 7. Câu hỏi mở cho senior agent review

1. **Probe trước Wave 2:** có nên chạy script probe (subscribe event stream + log types trong 1 prompt thật) trước khi viết code streaming? Types trong client có `text.delta`, nhưng cần confirm service đang chạy phát ra event đó với tần suất nào.
1. **Quote & Reply regression:** chấp nhận rủi ro khi chuyển final sang rich (Wave 3) hay giữ HTML cũ? Cần user test trên client của mình.
2. **Dòng activity:** hiện cleanup bằng `deleteMessage` khi turn kết thúc (tránh để line "🔧 đang đọc…" chết bên trên reply). Có UX tốt hơn không (vd giữ làm summary)?
3. **Orphan activity message** sau bot restart (message id chỉ giữ in-memory): có cần persist trong `state.json`? Hiện đánh giá là chấp nhận được (message chết không tự mất, chỉ là 1 dòng còn sót).
4. **Rate limit:** activity line edit ~2–4 lần/s trong turn nặng — cần throttle bao nhiêu là an toàn cho Bot API (limit ~30 msg/s global, 20 msg/min/chat)?
5. **`tool.progress` + `tool.input.ended`:** nên khai thác gì thêm từ 2 event này (progress = cập nhật giữa chừng, input.ended = input đầy đủ nếu bỏ qua input.started)?

## 8. Wave 1 — đã implement trong repo này

| # | Tính năng | File | Ghi chú |
|---|---|---|---|
| 1 | `setMyCommands` | `src/telegram.ts`, `src/bot.ts` (`registerCommands()`, gọi trong `start()`) | 23 lệnh, mô tả tiếng Việt, best-effort (thất bại không chặn start). **Đã verify live** qua `getMyCommands` — menu xuất hiện trên Telegram |
| 2 | Sticker/ảnh/voice + caption | `src/telegram.ts` (loại `Message`), `src/bot.ts` (`handle()`, `noteNonText()`, `hasNonTextContent()`) | Caption = prompt text (đi qua command dispatch bình thường); media không caption → acknowledge ngắn theo loại; người lạ gửi media vẫn bị im lặng như trước |
| 3 | Dòng activity real-time | `src/activity.ts` (pure), `src/bot.ts` (`showActivity/finishActivity/clearActivity`), `src/config.ts`, `scripts/test-activity.ts` | Event: `session.tool.input.started/called/success/failed` + `session.shell.*`; 1 message/conv, edit khi tool đổi; xóa khi turn kết thúc (3 hook: `runPromptTask.finally`, `stopCurrent`, event execution kết thúc); toggle `OPENCODE_TG_ACTIVITY` (mặc định ON). **Đã verify event stream live** (probe mục 6) |

**Chưa làm (cố tình):** streaming draft (Wave 2), cost mỗi turn (Wave 2), rich messages (Wave 3) — chờ probe events + review của senior agent.
