# Plannotator — Báo cáo kiến trúc & UX (dành cho bot quản lý agent qua Telegram)

Repo: `plannotator` (local browser-based review surface cho AI coding agents: OpenCode, Claude Code, Codex…). Người đọc: đội làm bot Telegram quản lý OpenCode workers (checkpoint cards → Accept/Redo/notes → worker session). Mọi claim đều dẫn `file:line` đã đọc trực tiếp trong source.

---

## 1. Non-blocking review + reply routing (kiến trúc cốt lõi)

### 1.1. Nguyên lý: không có blocking IPC nào cả

Toàn bộ "non-blocking" của Plannotator dựa trên một hợp đồng 3 vế, không dùng IPC chờ/khóa gì:

1. **Tool call trả về ngay lập tức.** Khi agent gọi tool `plannotator` (hoặc chạy slash command), host mod spawn một CLI con **detached** (`plannotator review|annotate|plan …`) chạy server browser cục bộ. Tool "returns as soon as the server is up, with the session id and the url, while the child keeps running in the background" — `apps/opencode-plugin/plannotator-tool.ts:6-11`.
2. **Text trả về ra lệnh cho agent KẾT THÚC turn.** Hàm `plannotatorToolOpenedText` (`packages/shared/plannotator-tool.ts:473-500`) trả về đúng các dòng:
   > "The reviewer is looking at it now. **End your turn now and wait**: their decision arrives later as a message in this conversation that starts with \"Plannotator:\"."
   > "Do not poll, reopen it, or run the plannotator CLI for this session."
   
   "Chờ" ở đây là **prompt contract** (lệnh trong text), không phải cơ chế kỹ thuật — agent không thể block được, nên cách duy nhất để "chờ" là kết thúc turn.
3. **Decision về sau được tiêm vào đúng session đó như một user turn mới.** Không có message queue chờ agent đọc: host plugin (chạy *bên trong* tiến trình agent) inject thẳng một prompt mới vào conversation.

### 1.2. Cách định danh session đích

- Mỗi launch được cấp một id dạng `pn-` + 6 hex: `PLANNOTATOR_SESSION_ID_PREFIX = 'pn-'` (`packages/shared/plannotator-tool.ts:214`), sinh bởi `plannotatorSessionId(hex6)` (:225).
- Launch có một **thư mục riêng** (`sessions/<pn-id>/` hoặc `host/<pn-id>/`) chứa `result.json` do CLI viết khi người dùng ra quyết định. Đây là "envelope" vật lý nối review server với agent session.
- **Claude Code**: mod là plugin hooks chạy trong chính session Claude Code, nên `$.prompt.submit({ text })` (origin `plannotator`, `apps/hook/hooks/mod/register.ts:182,248`) rơi thẳng vào conversation đó.
- **OpenCode**: "one `InboxWake` per root session (a subagent's call is signed by, and woken in, the root session the person works in)" (`apps/opencode-plugin/inbox.ts:14-20`); `session.prompt({ sessionID, … })` nhắm đúng session bằng id.

### 1.3. Envelope/protocol của decision

**HostResultRecord** (JSON, ghi vào `result.json`):
- Interface: `apps/hook/server/host-result.ts:41`; validation trong `parseHostResult` (`apps/hook/hooks/mod/delivery.ts:53-71`):
  - `v: 1`
  - `surface: "plan" | "review" | "annotate" | "annotate-last"`
  - `decision: "approved" | "annotated" | "dismissed" | "denied" | "answered"`
  - `message: string` (feedback markdown), `noop: boolean`
  - `annotationCount?`, `approvedPlan?`, `withNotes?`, `target?`
- Ghi atomic (temp + rename) bởi `writeHostResult` (`apps/hook/server/host-result.ts:117`); CLI nhận đường dẫn file qua env `PLANNOTATOR_HOST_RESULT_FILE` (:34).

**Vòng đời delivery phía host** (Claude Code mod — `apps/hook/hooks/mod/controller.ts`):
- Controller **poll** launch dir, giữ **watcher lease** (`watcher.json` với `instanceId`, `holdLease` :1699-1719) để 2 tiến trình Claude Code không delivery trùng — "a lease race can never deliver" (:222).
- Khi có `result.json` → `settle(launch, record)` (:1726-1775):
  - `deliveryFor(record, …)` (`apps/hook/hooks/mod/delivery.ts:110+`) dựng text: heading `plannotatorDecisionHeading` = `Plannotator: <subject> (pn-abc123) — <outcome>.` + dòng `Target:` (`packages/shared/plannotator-tool.ts:511-521`), rồi body feedback. Outcome được nói bằng `outcomeOf` (delivery.ts:82-108): "Approved with notes · 3 comments", "Changes requested · 2 comments", "Questions answered"…
  - **Overflow**: feedback dài hơn `INLINE_LIMIT_BYTES = 12 * 1024` (delivery.ts:46) được ghi ra file riêng, message chỉ trỏ đến file — không bao giờ cắt bớt.
  - `submitDecision` (:1784-1800) gọi `host.submit` = `$.prompt.submit({ text })`. Comment tại controller.ts:1759-1762: "`$.prompt.submit` resolves once Claude was idle and took the turn" — tức là **đợi Claude rảnh rồi mới vào**, không ngắt turn đang chạy. Nếu `PromptDropped` (người dùng vừa stop), decision được giữ lại và thử lại sau prompt/turn kế tiếp (:1789-1800).

**OpenCode** (`apps/opencode-plugin/inbox.ts`):
- `deliver`: `session.prompt({ sessionID, id, text, delivery: "queue" })` — "the decision runs as a turn of its own once the session is idle. **Never 'steer'**" (:713-721, comment :714-716).
- Nút "Send now" của người xem: `delivery: "steer"` — "a steer joins that run at its next step" (:730-750); nếu không thấy delivered trong grace → fallback thành queued turn (:744-750).
- Busy detection có cross-check: "a session that reads running with no event for 20 s is checked against OpenCode itself … so a lost end event cannot hold replies forever" (:704-711).

**Kết luận kiến trúc:** "Non-blocking" = **fire-and-forget + message contract**. Decision được persist thành file/record; host plugin (chạy trong tiến trình agent, per-session) đưa decision về như một **queued user turn** vào đúng conversation được định danh bằng `pn-id` / sessionID. Agent không poll, không block; nó chỉ nhận message bắt đầu bằng `Plannotator:` ở turn kế tiếp.

---

## 2. Guided review (chaptered diffs)

### 2.1. Ai xếp chương: LLM, có schema ràng buộc — không deterministic

Guide là một **agent job** (spawn CLI provider), "Structurally it follows the Code Tour provider: schema-constrained structured output" (`adr/decisions/006-…:Decision.3`). Ba engine path trong `packages/server/guide/guide-review.ts`:

- **Claude**: `buildGuideClaudeCommand` (:88-107) → `claude -p --output-format stream-json --json-schema <GUIDE_SCHEMA_JSON> …`
- **Codex**: `buildGuideCodexCommand` (:141-166) → `codex exec --output-schema <path> -o <file> …`
- **Marker engine** (Cursor/OpenCode/Pi — không có schema flag): JSON block bị giới hạn bởi marker tag mang **nonce** (`plannotator-review-json:pn<12hex>`) nhúng trong prose (:175-192).

### 2.2. Output schema

`packages/core/guide.ts`:
- `CodeGuideOutput` (:90-96): `{ title, intent, overview?, sections: GuideSection[], unplacedFiles? }`
- `GuideSection` (:38-53):
  - `title` — "Concept-level title … **never a filename paraphrase**"
  - `overview` — "Markdown prose: what changed, why it exists, and its key implications. **Semantic order (core first, consequences next, glue grouped last) is carried by the array position, not by any label field.**"
  - `diffs: GuideDiffRef[]` (:25-36) — `file` (repo-relative path, phải khớp DiffFile trong patch), `summary?` ("1-2 sentence semantic description of what changed in THIS file, written from the diff hunks alone"), `notes?`
  - `diagram?` (mermaid/html, format v5)
- `unplacedFiles` — file model không xếp được, render thành chương cuối "Everything else".

### 2.3. Prompt phương pháp (trích, `packages/core/guide-prompt.ts`)

- `GUIDE_REVIEW_PROMPT` bắt đầu tại :83 ("# Guided Review Organizer").
- Thứ tự ngữ nghĩa (:281-282): "**core** implementation … then **consequences**, then one trailing grouped chapter for **glue and low-signal changes**".
- (:165) "Then the consequences, in decreasing signal: call sites updated, …"; (:235) "…ground to avoid writing an overview. A glue/wiring/config file usually [gets its own trailing chapter]".
- Có coverage rule (mọi file changed phải được xếp hoặc explicit unplaced) và hard constraints (không bịa, research budget có giới hạn) trong cùng prompt.
- Reviewer có thể thêm standing instructions: được **append** vào prompt như section riêng, "never replacing the built-in organizer prompt" (`composeGuideMethodology`, `guide-review.ts:58-92`).

### 2.4. Chế độ thứ hai: builder increment qua MCP tools

Thay vì 1-shot JSON, agent (trong VS Code extension) xây guide từng bước qua 11 tools (`packages/core/guide-builder-tools.ts:73-228`):
`guide_set_header` (title+intent), `guide_set_overview`, `guide_add_chapter` ("Concept-level title, never a file name", max 10 chương — `GUIDE_BUILDER_MAX_CHAPTERS`, `guide-builder.ts:36`), `guide_update_chapter`, `guide_move_chapter`, `guide_remove_chapter`, `guide_place_file` (kèm `focus`: hint dòng/hunk), `guide_move_file`, `guide_unplace_file`, `guide_read`, `guide_finish`. Draft có `version`, id chương ổn định (`c1, c2…`, "so reordering never breaks a reference" — `guide-builder.ts:66`).

### 2.5. Render chương cạnh diff thật

- `packages/guide-viewer/GuideView.tsx`: resolve `section.diffs` → các `DiffFile` thật từ patch hiện tại (:51-80); link `chapter:N` / `code:path` trong overview nhảy đến chương/file (:158-193).
- `GuideSectionCard.tsx:296-297`: chỉ số `01 / 04`, checkbox **Reviewed** — checked thì collapse chương (`isCollapsed = showReviewed ? … : …`).
- Diff render bằng **cùng** Pierre `CodeView` của view diff thường — "Annotation parity is a hard constraint … Reuse, not copies. An annotation made in a guide is indistinguishable from one made in the diff view" (ADR 006, Decision.5).
- Snapshot versioned v1→v5, tương thích ngược nghiêm ngặt: "a version-1 reader (an old pinned viewer, which rejects unknown fields) is never handed a field it cannot read" (`packages/core/guide-format.ts:24-45`).
- Portable export: một file HTML duy nhất, "size is the diff, never the app" (ADR 007, D1); share link E2E-encrypt, key nằm trong URL fragment `#key=`, host chỉ giữ ciphertext (ADR 007, addendum D11, `apps/guides-show/`).

---

## 3. Structured feedback format

Hai tầng: **(a) JSON annotation có cấu trúc** (cho PR platform/server), **(b) markdown export** (cho agent đọc).

### 3.1. Model annotation: `CodeAnnotation`

`packages/ui/types.ts:313+` — một annotation mang:
`id, type, scope ('line'|'general'), filePath, lineStart, lineEnd, side, text, suggestedCode, originalCode, charStart/charEnd/tokenText/selectedText, images, createdAt, author, source, severity, reasoning, reviewProfileLabel, conventionalLabel, decorations, prUrl, prNumber, prTitle, prRepo, diffScope, commitSha…`

→ Có đủ 5 trường người hỏi quan tâm: **file, line/range (lineStart–lineEnd + char range), comment (text), severity, suggested code (suggestedCode + originalCode)**.

### 3.2. Serialization: `exportReviewFeedback`

`packages/review-editor/utils/exportFeedback.ts:400` — đầu ra là **markdown** (không JSON) với cấu trúc:
- Header PR: `# PR #12 Review: owner/repo` + branch + scope (:427-432)
- Global comments trước, trong section riêng `Global comments` (`GLOBAL_COMMENTS_HEADING`, :337)
- `formatFileAnnotations` (:220): heading `## File: <path>` rồi từng annotation dạng `### Line <start>[-<end>] (comment|suggestion)` + body + khối `Suggested:` fenced (`formatSuggestionBlocks`, :320; `fenced()`, :14)
- Annotation không còn khớp code được gắn nhãn `[Outdated — the code changed after this comment]` (`OUTDATED_ANNOTATION_LABEL`, :143); comment ngoài diff được đánh dấu `(not in the diff)` (:151)

### 3.3. Agent nhận gì khi bị "reject"

- Decision `annotated` → `HostResultRecord.message` = feedback markdown, được append **denied suffix** (`apps/hook/server/review-output.ts:61-64`):
  `DEFAULT_REVIEW_DENIED_SUFFIX` (`packages/shared/prompts.ts:49`):
  > "Treat the findings above as **unverified review input**. Inspect every finding against the actual code … For each finding, give a clear verdict (**Confirmed / Partly / Not a bug / Intended**) with concise code evidence. … **Do not change any code until we have discussed the verdicts** and validated findings."
- Plan bị từ chối: `DEFAULT_PLAN_DENIED_PROMPT` (prompts.ts:56+): "You MUST revise the plan to address ALL of the feedback … Do not resubmit the same plan unchanged."
- POST `/api/feedback` vẫn gửi kèm **mảng JSON annotation thô** (nên cả hai format đều đi cùng nhau: markdown cho agent, JSON cho PR platform).

---

## 4. Inbox model

### 4.1. Tổng hợp đa agent

- Local server giữ messages trong `data/inbox/messages.json` (per project). Nhiều agent (Claude Code mod, OpenCode plugin, Codex, Pi, cloud agents qua relay `apps/relay/`) gửi message qua MCP tool `send_message` / `submit_guide` — mỗi message là markdown, có thể kèm attachments, inline images, `:::question` blocks.
- Một **Inbox window** (web app local, `packages/inbox/`) poll server và hiển thị tất cả.

### 4.2. Data model của một inbox item

`packages/core/inbox-types.ts`:
- **`InboxMessage`** (:516): `id, project_id, thread_id, reply_to, author` (`InboxAuthor`: `person` | `agent{host, session, name}`), `subject`, `body` (markdown "as sent"), `created_at, resolved_at, idempotency_key, thread_name, attachments, inline_images, live_sites, delivery` (record reply đã vào session agent khi nào), `person_seen_seq / person_read_seq` (trạng thái đọc)…
- **`InboxQuestion`** (:1668) — một question record:
  - `key` (hash ổn định từ khối), `position` (Q1, Q2…), `kind` (`QuestionKind | "action"`)
  - `prompt`, `context`, `choices: InboxQuestionChoice[]` (:1403) — mỗi choice: `label, description, recommended, settled` (`[x]` = đã chốt), `image?`, `pros?/cons?`, `prototype?`
  - Contract lines (:1426-1440): `stakes?` (Stakes:), `shows?` (Shows: — ảnh/file mà quyết định nhắm tới), `why?` (Why:), `reversible?` ("Reversible: no — <why>")
  - `recommendation?`, `suggested_text?` (free-text gợi ý)
  - `state: "open" | "picked" | "sent" | "closed" | "superseded"` (:1658), `stopped`, `holds_up: string[]` (reasons)
  - `answer: QuestionAnswer { selected, other, text, note, skipped, by_reply }`, `picked_by, picked_at, sent_reply_id, superseded_by?, set_aside?, action?`
- **Grammar phía agent** — `:::question` directive block trong markdown (`packages/core/question-block.ts:1-120`): kinds `question` / `question-multi` / `question-text`; choices `- [ ] Label — description`; `Recommended:`; `Replaces:`; parser "line-oriented and tolerant", "a document that carries questions still reads correctly in any other viewer (GitHub, an editor, a terminal)".

### 4.3. "Grouped by what each needs" = 6 sections

`INBOX_SECTIONS` (`inbox-types.ts:1819-1829`), thứ tự cố định:
1. **Stopped on you** — question có cờ `Stopped:`
2. **Holding up work** — question có `Holds up: <reason>`
3. **Waiting on you** — question mở khác
4. **New since you looked** — agent message mới / "Answered, not sent" / draft
5. **Sent** — reply của người dùng chưa được agent đọc
6. **Quiet** — còn lại (kèm Archived riêng)

Mỗi thread nằm **đúng một** section; "the first rule that holds wins" (rule table 1-10, `adr/implementation/inbox-thread-state.md` §Sections). Trạng thái **derived, never stored**; có test "chạy event sequence qua store thật và model độc lập, kiểm mọi invariant sau mỗi bước". Agent được chủ động khai báo mức cần: `Stopped:` / `Holds up:` trong question block.

### 4.4. "Answer a question with a click" — click gửi về gì?

1. Agent viết `:::question` + choices → Inbox parse thành question record (state `open`).
2. Người dùng **click một choice** → state `picked` (lưu pick, chưa gửi; undo được).
3. Nút **Send** → reply = lời người dùng + section `## Answers to your questions` do `formatQuestionAnswersSection` (`question-block.ts:2308-2380`) sinh ra:
   - `### Q1. <prompt> (line N)` rồi `Answer: "Label" (your recommendation)` / `Answer:` + bullet picks / `Other: …` / `Skipped` / `Note: …` (`formatQuestionAnswerLines`, :2216-2262)
   - Câu tổng kết: "N of M questions answered. K already settled in the document were left as is."
   - Question chưa trả: section `Unanswered`.
4. Reply được **deliver vào session agent như một turn** qua `InboxWake` (`packages/shared/inbox/agent-link.ts:551+` — poll claims, lease, backoff; OpenCode: `session.prompt` queue/steer, §1.3). Có `idempotency_key` cho pick/send (events table, thread-state doc).
5. Cơ chế phụ trợ: **supersede** (`Replaces:` — agent thay question cũ), **Mark read** (đóng question chưa trả thành skip + gửi set-aside note cho agent), **Re-ask**, **Undo** — cả thread state model đều document trong `adr/implementation/inbox-thread-state.md`.

---

## 5. ADRs + design rationale

Tree `adr/`: `0001`, `0002` (top-level), `decisions/` (001-007), `implementation/` (5 docs), `research/` (SPIKEs + syntheses), `specs/` (13), `recap-*`. Các ADR liên quan nhất:

| ADR | Quyết định + rationale (1-2 dòng) |
|---|---|
| `adr/0001` | Dùng chuẩn ADR của Nygard (meta). |
| `adr/0002-add-webtui-agent-panel-for-annotate-mode` | Thêm terminal agent (WebTUI/PTY) cho annotate mode; lazy start, Node sidecar cách ly runtime rủi ro. Không đụng tới non-blocking story. |
| `decisions/001-005` | Nhỏ: recreate-on-save, PR context warm cache, live PR context updates, annotate PR description, publish document UI as packages, since-base GitHub view default. Không liên quan 5 area. |
| `decisions/006-guided-review-first-class-feature` | Xây Guided Review làm first-class: guide = chuỗi trang có title/overview/diff thật; **generation là agent job** (schema-constrained, theo Code Tour precedent); **annotation parity là hard constraint** (reuse, không copy); screen takeover kiểu Notion. Rationale: "Large changesets are hard to review file-by-file; Linear's Guides showed a better shape". |
| `decisions/007-portable-guided-reviews` | 12 quyết định (D1-D12): artifact = 1 file HTML nhỏ "size is the diff, never the app"; **một renderer hai host** (no visual drift structural); snapshot versioned strict; capture diff tại lúc launch; CDN immutable pinned; export là pure function 3 callers; share link E2E-encrypt, key trong URL fragment. |
| `implementation/inbox-thread-state` | Model thread-state của Inbox: 6 sections, **derived never stored**, first-rule-wins, mọi invariant có test; trace fixtures cho phone replay. |
| `implementation/portable-guided-reviews`, `guide-share-hosting`, `inbox-mobile` | Spec triển khai chi tiết (verification matrix, wire contract). |

**Nhận xét:** ADR **đáng chú ý nhất về non-blocking — thiết kế tool trả về ngay + decision-as-turn — KHÔNG có ADR riêng**; nó chỉ được document trong docstrings của code (`apps/hook/hooks/mod/register.ts:1-60`, `apps/opencode-plugin/inbox.ts:1-33`, `apps/opencode-plugin/plannotator-tool.ts:1-23`). Đây là gap: quyết định quan trọng nhất của repo lại được giữ ở tầng code comment. Không ADR nào mâu thuẫn với "non-blocking story"; ADR 006/007 (guided review) và inbox-thread-state củng cố cùng triết lý: **agent tự khai báo trạng thái, state của người xem là derived, delivery đi qua "turn" chuẩn của host**.

---

## Áp dụng cho bot Telegram

Xếp theo giá trị/effort. "Poor fit" được nói thẳng.

### Ý tưởng 1 (cao nhất): Checkpoint card với inline-keyboard choices — câu trả về worker là queued prompt có heading máy đọc được

- **(a) Plannotator làm gì:** agent hỏi bằng `:::question` có choices `- [ ]`, `Recommended:`, `Stakes:`; người dùng click → `picked` (chưa gửi, undo được) → Send → reply chứa section `Answers to your questions` (`Q1 … Answer: "…" (your recommendation)`) → **đưa vào session agent như một queued turn** vào đúng lúc session rảnh. Trạng thái question là state machine: `open → picked → sent → closed/superseded`.
- **(b) Bằng chứng:** `packages/core/question-block.ts:1-120` (grammar), `:2216-2380` (answer format); `packages/core/inbox-types.ts:1403-1560` (question record), `:1658-1710` (state); `apps/opencode-plugin/inbox.ts:713-721` (delivery "queue"); `adr/implementation/inbox-thread-state.md` §Question states.
- **(c) Cho bot Telegram:** checkpoint card của worker = 1 message Telegram với **inline keyboard 2-4 nút** (Accept / Approve with note / Redo — mỗi nút callback). Callback → bot gửi **queued prompt** vào worker session (không interrupt turn đang chạy — đúng "delivery: queue"), text bắt đầu bằng dòng heading máy đọc được, ví dụ `Checkpoint: T6 — ACCEPT` hoặc `Checkpoint: T6 — REDO` + notes của manager phía dưới. Hệ thống prompt của worker: "khi nhận message bắt đầu bằng 'Checkpoint:', đó là quyết định review; xử lý rồi ack." Không cần web UI: inline keyboard của Telegram là bản đồ tự nhiên cho pick/choice.
- **(d) Effort:** M. **Risk:** thấp. Đây là ý tưởng đáng làm trước nhất — Telegram inline keyboard khớp gần như 1-1 với model question/pick của plannotator.

### Ý tưởng 2: Protocol "deny suffix" — feedback Redo phải qua bước verdict trước khi sửa

- **(a) Plannotator làm gì:** khi reviewer từ chối, feedback gửi về agent luôn kèm suffix: coi findings là **unverified**, agent phải inspect từng finding với code thật, cho verdict `Confirmed / Partly / Not a bug / Intended` kèm bằng chứng, và **"Do not change any code until we have discussed the verdicts"**. Plan bị từ chối: "revise the plan … do not resubmit unchanged".
- **(b) Bằng chứng:** `packages/shared/prompts.ts:49` (`DEFAULT_REVIEW_DENIED_SUFFIX`), `:56+` (`DEFAULT_PLAN_DENIED_PROMPT`); `apps/hook/server/review-output.ts:61-64` (nơi suffix được append).
- **(c) Cho bot Telegram:** khi manager gửi notes/Redo, worker trước tiên trả về 1 message **verdict ngắn từng ý** (Confirm/Reject + lý do) rồi mới sửa code; sau đó mới post checkpoint mới. Ngăn worker "fix" mù theo feedback đọc sai — đúng failure mode hay gặp khi review qua Telegram (không có diff bên cạnh). Đây chỉ là prompt engineering: thêm suffix tương đương vào template Redo message.
- **(d) Effort:** S (chỉ prompt). **Risk:** thấp. Rất đáng làm vì rẻ và giải quyết pain point thật.

### Ý tưởng 3: Sections "Stopped / Holding up / Waiting" làm dashboard trạng thái worker

- **(a) Plannotator làm gì:** inbox không group theo agent hay project mà theo **điều mỗi thứ cần**: agent chủ động khai `Stopped:` (work đang chặn chờ người) / `Holds up: <reason>`; list row = thread, đặt vào đúng 1 trong 6 sections theo first-rule-wins, tất cả derived không stored, có test invariant.
- **(b) Bằng chứng:** `packages/core/inbox-types.ts:1819-1829` (6 sections + labels); `adr/implementation/inbox-thread-state.md` §Sections (rule table 1-10) và §"Where the rules live".
- **(c) Cho bot Telegram:** payload checkpoint card cho phép worker khai mức ưu tiên: `blocked` (chờ hành động chỉ người làm được — ví dụ credentials, deploy) / `holding` (khối việc khác đang chờ nó) / `waiting` (hỏi ý kiến thường). Bot duy trì **1 message summary (pinned) hoặc topic riêng** trong group, liệt kê workers theo nhóm Blocked > Holding > Waiting > New > Sent (đang chờ agent) — manager mở app ra thấy ngay "ai đang chặn". Không cần UI phức tạp: 1 message markdown bot tự rewrite mỗi khi có sự kiện.
- **(d) Effort:** M. **Risk:** thấp. Giá trị cao khi chạy nhiều worker song song — đúng mô hình của chúng ta.

### Ý tưởng 4: Chaptered review cho diff lớn (guided review) — partial fit, làm sau

- **(a) Plannotator làm gì:** LLM (agent job, schema-enforced `--json-schema` / `--output-schema` / nonce marker) xếp diff thành chương `sections[{title, overview, diffs[{file, summary}]}]` theo luật "core → consequences → glue last"; render mỗi chương cạnh **diff thật** (cùng CodeView, annotation parity); format snapshot versioned; portable HTML + share link E2E-encrypted.
- **(b) Bằng chứng:** `packages/core/guide.ts:25-96` (schema); `packages/server/guide/guide-review.ts:88-166` (3 engine paths); `packages/core/guide-prompt.ts:83,281-282` (luật thứ tự); `adr/decisions/006` (Decision 1, 3, 5); `adr/decisions/007` (D1, D5, addendum); `packages/guide-viewer/GuideView.tsx:51-80,296` (render + Reviewed).
- **(c) Cho bot Telegram:** trước khi dump diff lớn, worker (hoặc review agent) sinh "chương chỉ mục": 3-5 chương có title + file list + 1 dòng overview, post thành 1 message với inline keyboard **tên chương**; manager bấm chương → bot gửi diff của các file chương đó (code block, hoặc link tới 1 file HTML hosted kiểu `guides.show` xem trên điện thoại — đây là điểm plannotator làm tốt: guide là file HTML tự chứa, mở được ở bất cứ đâu). Telegram **không phải** medium tốt cho inline annotation (không có line-anchored comments), nên chỉ lấy "chương chỉ mục + on-demand diff", không lấy annotation UI.
- **(d) Effort:** L (LLM cost mỗi checkpoint, thêm job pipeline). **Risk:** trung bình (chất lượng chương phụ thuộc prompt; tốn token). **Xếp sau** 1-3.

### Ý tưởng xếp thấp hơn (nói thẳng: poor fit)

- **Inline line-annotation model** (`CodeAnnotation` với char range, severity, suggested code — §3): phụ thuộc code view để anchor; Telegram không anchor được. Có thể giữ *tương tự* bằng convention text `file.ts:123-140 — note` trong notes, nhưng UX yếu hơn nhiều so với web. Không port model đầy đủ.
- **Web takeover screen / Notion-like guide UI** (ADR 006 Decision.4, `packages/guide-viewer/`): không có web surface trong luồng Telegram; phần giá trị chuyển qua ý tưởng 4 (hosted HTML link) là hết.
- **Agent terminal panel (ADR 0002), mobile push relay (`apps/relay/`), feedback-service (product feedback):** không transferable cho bot.

---

## TL;DR

Insight kiến trúc lớn nhất: **"non-blocking" của plannotator không phải cơ chế gì cả — nó là hợp đồng message.** Tool call trả về ngay với câu lệnh "end your turn and wait"; decision được persist thành JSON record (`pn-<id>` launch dir); host plugin chạy *trong* tiến trình agent inject decision như một **queued user turn** (`$.prompt.submit` / `session.prompt{delivery:"queue"}`) vào đúng conversation — agent không poll, không block, không IPC chờ. Mọi thứ còn lại (inbox sections, question states, guide chapters) đều là **derived state trên message log** với first-rule-wins và test invariant.

Top 2 ý tưởng cho bot:
1. **Checkpoint card = inline-keyboard question; đáp án về worker là queued prompt với heading máy đọc được** (`Checkpoint: T6 — REDO …`) — bản đồ 1-1 với model `:::question`/pick/delivery-queue của plannotator (M, low risk).
2. **Redo feedback kèm "deny suffix"**: worker phải cho verdict từng finding (Confirmed/Partly/Not a bug/Intended) trước khi sửa — 1 dòng prompt, chặn hẳn failure mode "fix mù theo feedback" (S, low risk).
