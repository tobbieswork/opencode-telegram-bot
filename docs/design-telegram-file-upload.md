# Design: bot nhận file từ Telegram (đăng ký media → agent xử lý)

- **Ngày:** 2026-10-31
- **Trạng thái:** design-only (chưa implement — doc này là spec cho worker implement)
- **Scope:** file mới `src/uploads.ts` + `scripts/test-uploads.ts`; diff nhỏ vào `src/telegram.ts`, `src/bot.ts`, `src/config.ts`, `src/commands.ts`, `src/index.ts`, `package.json`. Feature gate `OPENCODE_TG_UPLOADS` (mặc định OFF).
- **Liên quan:** `noteNonText` (src/bot.ts:1140 — thông báo từ chối hiện tại), `hasNonTextContent` (src/bot.ts:64), Telegram client tự viết không framework (src/telegram.ts), `ChatState.directory` (src/state.ts:113).

## 0. Hiện trạng (kết quả khảo sát code)

### 0.1 Media đã đến được bot — chỉ bị bỏ ở lớp dispatch

- `allowed_updates` đã có `"message"` (src/telegram.ts:484) → mọi update media (photo/document/video/audio/…) **đã tới** polling loop.
- Type `Message` đã khai báo đủ fields: `sticker/photo/video/voice/audio/document/animation` + `caption` (src/telegram.ts:18-36).
- `Bot.handle()` (src/bot.ts:715) tính `text = (msg.text ?? msg.caption ?? "").trim()` rồi:
  - **Media không caption** → `noteNonText()` (bot.ts:1140) — trả lời từ chối ("tôi chỉ đọc được văn bản").
  - **Media có caption** → caption đi dispatch như text thường; **file bị bỏ im lặng** (không ai đọc `msg.document` v.v.).
- Vậy khoảng trống duy nhất là: **lấy file về disk + gắn path vào prompt**. Đường pipeline còn lại (session, streaming, relay) không cần đổi.

### 0.2 Đường prompt (file chỉ cần nhập đúng 1 điểm)

Cả 3 loại conv đều hội tụ về 1 string text trước khi gọi OpenCode:

| Conv | Đường | Điểm vào |
|---|---|---|
| Normal / worker topic | `runPrompt` → `runPromptTask` → `oc.promptAndWait(sid, text)` | bot.ts:1612-1697 |
| Manager | `orch.promptManager` → `oc.prompt(sid, text)` | orchestrator.ts:1035-1060 |
| Advisor | `advisor.followUp(conv, text)` — context-only, không filesystem | → **loại khỏi scope** |

=> Chèn logic media **trước** nhánh dispatch trong `handle()` (bot.ts:725-777), sau khi đã có `text`; các đường phía dưới nhận `text2` y hệt text thường.

### 0.3 Agent đọc được file ngay không cần thêm gì

`read` tool của OpenCode trả **ảnh (PNG/JPEG/GIF/WebP) và PDF dưới dạng tool attachment** — model nhìn được ảnh thật. File khác (code, csv, zip…) agent đọc/chạy bình thường qua tool có sẵn (bash, unzip…). => **Không cần vision API, không cần đổi agent**: lưu file + cho model biết đường dẫn là đủ.

### 0.4 Context có sẵn

- Working dir per-conv: `ChatState.directory` (đã persist trong `data/state.json`).
- Busy: conv đang chạy → `BUSY_REPLY_TEXT` + nút "save as note" (`busyNotes.push(conv, msgId, text)` — bot.ts:1617-1627, orchestrator.ts:1043-1054). Text được giữ nguyên → note tự kế thừa cả phần file.
- An ninh: mọi message chỉ xử lý khi `allowed(uid)` (allowlist) — media thừa hưởng gate này, không thêm bề mặt mới.
- Chưa có `getFile`/download nào trong `telegram.ts`.

## 1. Ràng buộc Telegram (facts)

- `getFile(file_id)` → `{ file_path }` → tải từ `https://api.telegram.org/file/bot<token>/<file_path>`. **Giới hạn Bot API: file ≤ 20 MB** (lớn hơn cần local Bot API server — out of scope).
- `photo`: mảng các size `[{file_id, file_size, width, height}]` → chọn size **lớn nhất** theo `file_size`.
- `document`: có `file_name`, `file_size`, `mime_type`. `video`/`audio`/`animation`: có `file_size`, `mime_type`, không có `file_name`.
- `voice`: OGG/OPUS — **không có STT** → giữ hành vi từ chối hiện tại (feature sau).
- `sticker`: không phải file → giữ từ chối.
- `file_id` ổn định dài hạn (có thể tải lại được).
- Album ảnh: mỗi tấm là 1 update riêng → mỗi tấm = 1 turn riêng (chấp nhận cho v1, không batch).

## 2. Thiết kế

### 2.1 Module mới `src/uploads.ts` (pure functions + 1 hàm I/O)

```ts
export interface UploadMedia {
  kind: "document" | "photo";
  fileId: string;
  fileName?: string;      // document only
  fileSize?: number;      // bytes (metadata từ Telegram)
  mimeType?: string;
}

export function extractMedia(m: Message): UploadMedia | null
export function sanitizeFileName(name: string | undefined, kind: string, ts: number, exists: (p: string) => boolean): string
export function buildPromptText(caption: string | undefined, f: { absPath: string; name: string; size?: number }): string
export function planCleanup(files: { path: string; mtime: number; size: number }[], now: number, opts: { ttlMs: number; maxBytes: number }): string[]
export async function downloadToFile(tg: Telegram, media: UploadMedia, destPath: string, opts: { maxBytes: number; timeoutMs: number }): Promise<{ bytes: number }>
```

- **`extractMedia`**: chỉ nhận `document` và `photo` (chọn size **lớn nhất**) — đúng 2 loại model đọc được (document = text/PDF/code/zip, photo = vision — đã verify live trên chính model DC5, mục 0.3). Mọi loại khác (`video/animation/audio/voice/sticker`) → `null` → đi `noteNonText` như hiện tại. Lý do chặt scope: model KHÔNG có audio/video input — download video/mp3 về mà model không nghe/xem được là over-scope (thấy mục 4).
- **`sanitizeFileName`**: chỉ lấy basename (cắt mọi `/`, `\`, đoạn `..`); giữ Unicode; max 100 ký tự; rỗng/kỳ dị → fallback `<kind>-<yyyyMMdd-HHmmss>[.<ext>]`; trùng tên (theo `exists`) → thêm `-1`, `-2`… Không bao giờ sinh ra path traversal (không có separator nào sống sót).
- **`buildPromptText`**:
  - Có caption: `<caption>` + dòng phụ:
    `(file gửi từ Telegram: <name>, <size> — đã lưu tại <absPath>)`
  - Không caption (chỉ file): chỉ định mặc định (tiếng Việt, đúng convention project):
    `Người dùng gửi file không kèm chỉ dẫn: <name> (<size>), đã lưu tại <absPath>. Hãy xem nội dung file đó.`
  - Caption/file là **data, không phải instruction** — không parse, không exec, chỉ đưa nguyên cho model (threat model y hệt text paste — hiện có).
- **`planCleanup`**: pure — nhận danh sách `{path, mtime, size}`, trả các path cần xoá: hết hạn TTL trước, rồi xoá thêm từ cũ→mới cho tới khi tổng ≤ `maxBytes`. (Test được 100% mà không đụng disk.)
- **`downloadToFile`**: phần I/O duy nhất — `tg.getFile(fileId)` → stream `fetch` về `fs.createWriteStream`, guard: vượt `maxBytes` → abort + xoá file dở; timeout 30s. Trả số bytes thực tế.

### 2.2 `src/telegram.ts`: +2 method, +1 field type

- `async getFile(fileId: string): Promise<{ file_path: string; file_size?: number }>` — đi qua `api()` có sẵn (JSON, không multipart).
- `async downloadFile(filePath: string, dest: string, opts: { maxBytes: number; timeoutMs: number }): Promise<number>` — fetch `https://api.telegram.org/file/bot<token>/<filePath>` (token đã có), stream ra disk, guard size/timeout như trên. Reuse `fetch` global — không thêm dependency.
- Type `Message`: thêm `video_note?: Record<string, unknown>` (Bot API có; để sẵn cho v2 — v1 không extract).

### 2.3 Nơi lưu: **`data/uploads/<convSafe>/`** (quyết định)

| Option | Ưu | Nhược | Kết luận |
|---|---|---|---|
| A: `<state.directory>/.tg-uploads/` | path nằm ngay working dir | **ô nhiễm repo user** (git status noise ở worker topic; không kiểm soát được .gitignore) | ❌ |
| B: `data/uploads/<chat>_<topic>/` (bot-owned, cạnh `state.json`) | 1 điểm cleanup duy nhất, không đụng repo, đồng nhất mọi loại conv (manager/worker/general), agent đọc bằng absolute path (cùng máy) | path ngoài working dir → phải nhúng absolute path vào prompt (đang làm vậy anyway) | ✅ |

- `convSafe`: `chatId` + `_topicId` khi có topic (không dùng ký tự `:`).
- File ghi với mode `0644`, không bao giờ set exec bit.
- Base dir lấy từ `path.dirname(cfg.stateFile)` — không hardcode.

### 2.4 Flow trong `Bot.handle()` — behavior table (nguồn sự thật)

`noteNonText` giữ **nguyên 100%** (gate OFF + mọi loại media không xử lý vẫn về đây). Hành vi theo tổ hợp input:

| Input | Gate OFF | Gate ON |
|---|---|---|
| Text thường | dispatch (hiện tại) | y hệt |
| **document/photo + caption** | noteNonText (hiện tại) | **download + dispatch = caption + dòng file** |
| **document/photo, không caption** | noteNonText | **download + dispatch = chỉ định mặc định (2.1)** |
| voice/video/audio/animation/sticker ± caption | noteNonText (y hệt) | noteNonText (y hệt) — `extractMedia`→null |
| document/photo + caption bắt đầu "/" | command thường, bỏ file (hiện tại) | y hệt hiện tại (log) |
| Người lạ (mọi loại) | log / ⛔ như hiện tại | log, **KHÔNG download, KHÔNG reply** |
| Conv đang BẬN | busy reply + nút note | **download TRƯỚC** check in-flight → busy reply + nút note, text note chứa dòng file |

Pseudocode (dạng tham chiếu — implementer chọn cấu trúc sạch nhất):

```
text  = (msg.text ?? msg.caption ?? "").trim()
media = cfg.uploads ? extractMedia(msg) : null     // gate OFF → null → 100% code cũ

if (!media) {
  // ── KHÔNG có file khả xử lý: đường HIỆN TẠI giữ nguyên (allowed check, noteNonText, dispatch) ──
  → các dòng hiện có của handle() với `text`
}
// ── có document/photo ──
if (!this.allowed(uid)) { log(`Denied media from uid=…`); return }   // TRƯỚC mọi download
if (text.startsWith("/")) → dispatch text như command hiện tại (log bỏ file); return
if (media.fileSize && media.fileSize > cfg.uploadMaxBytes) { reply "⚠️ File quá lớn…"; return }
// download + DEDUPE: edited_message (user sửa caption) mang lại cùng file_id —
// map in-memory `uploadedFiles: Map<fileId, absPath>` (cap 200, bỏ cũ nhất) →
//   hit  → dùng absPath cũ, KHÔNG tải lại, KHÔNG gửi "Đã lưu" nữa
//   miss → downloadToFile (catch → reply lỗi, return) → set map → reply "📎 Đã lưu…"
text2 = buildPromptText(text || undefined, {absPath, name, size})
// → các dòng hiện có của handle() (indexUserMessage, dispatch) với `text2`
```

- **Busy**: download xảy ra TRƯỚC khi check in-flight → file vẫn được lưu ngay cả khi conv bận; `text2` (chứa dòng file) đi vào `busyNotes` đúng như text → note kế thừa file reference.
- **Manager**: `text2` vào `promptManager` — manager nhận file trong `data/uploads/…` (absolute path trong prompt). Manager có thể chỉ việc file cho worker trong prompt spawn (hướng dẫn tự nhiên, không cần code).
- **Advisor conv**: giữ `noteNonText` (advisor không có filesystem).
- Không đổi: reaction index, streaming, relay, `/stop`, rotation.

### 2.5 Cleanup (startup sweep, không cần manifest)

- Trong `main()` (src/index.ts) sau khi load state: scan `data/uploads/**/*`, chạy `planCleanup(files, now, { ttlMs: cfg.uploadTtlDays*86400e3, maxBytes: 500 * 1024*1024 })` → xoá từng file + dir rỗng. Log 1 dòng `uploads sweep: deleted N files (M MB)`.
- Không manifest/state thêm — scan thư mục nhỏ là đủ (TTL 7 ngày, trần 500MB).
- Constant `UPLOADS_MAX_TOTAL_BYTES = 500MB` trong `uploads.ts` (không config hoá ở v1 — ít bề mặt).

### 2.6 Config (src/config.ts + .env)

| Env | Field | Mặc định | Ý nghĩa |
|---|---|---|---|
| `OPENCODE_TG_UPLOADS` | `uploads: boolean` | `0` (OFF) | Feature gate — bot chạy y hệt hiện tại khi off |
| `OPENCODE_TG_UPLOAD_MAX_MB` | `uploadMaxBytes: number` | `20` | Trần mỗi file (Bot API ceiling) |
| `OPENCODE_TG_UPLOAD_TTL_DAYS` | `uploadTtlDays: number` | `7` | File upload sống tối đa trước khi sweep xoá |

### 2.7 UX text (tiếng Việt, nối theo tone `noteNonText`)

- Thành công: `📎 Đã lưu <name> (<size>).` (1 dòng, rồi turn chạy như thường — `⏳ Đang xử lý…` hiện có che phần còn lại).
- Lỗi size: `⚠️ File quá lớn: 25.4MB (giới hạn 20MB).`
- Lỗi tải: `⚠️ Không tải được file — thử lại sau.`
- Voice (không đổi): giữ message hiện tại.
- `/help` (+1 dòng): `📎 Gửi file (ảnh, PDF, code, zip ≤ 20MB) — kèm caption = chỉ dẫn.`

## 3. An ninh

- Chỉ allowlist user được xử lý (gate `allowed()` trước mọi download).
- Filename: basename + bỏ separator + `..` → không traversal; dest dir cố định bot-owned.
- Không exec bit, không chạy file; model *đọc* file = cùng cấp tin cậy với text user paste (agent đã có bash toàn quyền trong working dir — threat model không đổi).
- Prompt-injection qua nội dung file: cùng threat model với paste text (hiện có) — không xử lý riêng ở v1.
- Download bị chặn size cả ở metadata (trước) lẫn khi stream (trong) → không thể OOM/disk bằng file khai báo gian.

## 4. Out of scope (v1)

- Voice / sticker: giữ từ chối như hiện tại. STT (whisper v.v.) là feature v2.
- **Video / audio / animation: v1 CHẲT khỏi scope** — model không có audio/video input, download về mà không ai (model) nghe/xem được. v2 candidate: agent tự extract frames (ffmpeg) / waveform — cần test ffmpeg trên box trước.
- Batch album ảnh (mỗi tấm 1 turn — chấp nhận).
- Gửi file LẠI user (hướng ngược — feature khác).
- File >20MB (cần local Bot API server).
- Permission prompt riêng cho file (agent ghi đè/xử lý file vẫn đi permission system hiện có).

## 5. Test

1. **Unit** — `scripts/test-uploads.ts` (pure, chạy trong `test:unit`):
   - `sanitizeFileName`: traversal (`../../etc/passwd`), Unicode, >100 chars, rỗng → fallback, trùng → `-1/-2`.
   - `extractMedia`: document, photo 3 size (chọn lớn nhất), video/audio/voice/sticker→null, text thường→null.
   - `buildPromptText`: có/không caption; escape path chứa ký tự đặc biệt.
   - `planCleanup`: TTL (file cũ xoá, mới giữ), trần bytes (xoá từ cũ→mới), thứ tự.
2. **`npm run typecheck` + `npm run test:unit`** (thêm `test:uploads` vào chain trong package.json).
3. **E2E tay** (sau khi merge, bật flag, restart service):
   - Gửi PNG + caption vào worker topic → đúng path, model `read` được ảnh (attachment), trả lời đúng nội dung ảnh.
   - Gửi PDF không caption vào Manager → manager tự mở, trả lời bằng tiếng Việt.
   - Gửi file khi conv BẬN → busy reply + nút note; bấm note → text note chứa dòng file.
   - Gửi file >20MB (nếu có) → message giới hạn, không download.
   - Người lạ (uid không allowlist) gửi file → log, không reply, không file trên disk.

## 6. Rollout

1. PR: code + doc + test, **gate OFF** trong repo default.
2. Merge → `OPENCODE_TG_UPLOADS=1` trong `.env` → `systemctl --user restart opencode-bot` → E2E tay (mục 5.3).
3. Nếu E2E fail: set `0` lại + restart (bot về đúng hành vi cũ, không có state mồ côi — uploads dir rỗng là an toàn).

## 7. Danh sách file (scope chính xác)

| File | Thay đổi |
|---|---|
| `src/uploads.ts` | **Mới** — ~150 dòng (2.1) |
| `src/telegram.ts` | +`getFile`, +`downloadFile`, +`video_note?` trong `Message` |
| `src/bot.ts` | nhánh media trong `handle()` (2.4); `noteNonText` giữ nguyên 100%; + `uploadedFiles` Map (dedupe edited_message) |
| `src/config.ts` | +3 field (2.6) + parse trong `loadConfig` |
| `src/commands.ts` | +1 dòng help |
| `src/index.ts` | startup sweep (2.5) |
| `scripts/test-uploads.ts` | **Mới** — unit tests (5.1) |
| `package.json` | thêm `test:uploads` + vào chain `test:unit` |

Ước lượng: ~300-350 dòng thay đổi, 1 worker slice.
