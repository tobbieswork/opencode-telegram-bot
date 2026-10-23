# Design: auto-recovery khi worker session chết vì context overflow

- **Ngày:** 2026-10-23
- **Trạng thái:** design-only (chưa implement — doc này là spec cho worker implement)
- **Scope:** chỉ thêm file mới `src/recovery.ts` + diff nhỏ vào `src/orchestrator.ts`, `src/state.ts`, `src/config.ts`, `src/worktree.ts`, `src/format.ts`, `scripts/test-recovery.ts`
- **Liên quan:** memory #24 (worker chết do overflow là vĩnh viễn, mitigation hiện tại là thủ công), `src/continue.ts` (nút "⏯ Chạy tiếp" — không cứu được session đã chết, vì prompt lại đúng session 400 đó)

## 0. Hiện trạng — failure biểu hiện thế nào (kết quả khảo sát code)

### 0.1 Đường sự kiện của worker (khác đường interactive)

Worker turn là **fire-and-forget**: `spawnReserved()` gọi `oc.prompt()` (không chờ), kết thúc turn được quan sát qua SSE event:

```
session.execution.failed (SSE)
  → Bot.onOpenCodeEvent()                      src/bot.ts:1924-1937
      error string = ev.data.error?.message ?? (string) ev.data.error
  → Orchestrator.onExecution(conv, type, error) src/orchestrator.ts:678
  → onWorkerFinished(conv, "failed", error)     src/orchestrator.ts:700
      - latestReply(sid, 0, {lastTurn:true}) → tail
      - setStatus(conv, "failed", tail)        (tail = reply text, hoặc "error: <msg>" nếu không có reply)
      - queueReport → báo Manager (nếu manager bật)
      - autoClose: đóng topic (cfg.autoClose default ON)
```

Điểm then chốt: **`error` (string) chỉ tồn tại ở tham số của `onWorkerFinished`** — không được lưu vĩnh viễn ở đâu ngoài `WorkerInfo.lastResult` (tail ≤1500 char, chỉ chứa error khi turn không có text). Vậy hook decision phải nằm ở đúng chỗ nhận được string này.

### 0.2 Error text của litellm

Text thực tế: `Requested token count exceeds the model's maximum context length of 160000 tokens`.

Regex **đã có sẵn** trong repo và match được text này (khớp cả `maximum context` lẫn `context length`):

```ts
// src/format.ts:26
const CONTEXT_OVERFLOW_RE =
  /context (length|window|limit|size)|maximum context|prompt is too long|input length|too many tokens/i;
```

Hiện regex này chỉ dùng cho `formatTurnFailure()` (đường interactive). Design: **export một predicate dùng chung** để tránh hai nguồn sự thật.

### 0.3 Các đường không thể / không cần phát hiện

- **`healWorkers()`** (orchestrator.ts:178): chỉ có `sessionState()` → `outcome: "failed"`, **không có error text** → không phân loại được overflow. Chấp nhận: nếu bot restart đúng lúc worker đang overflow, fallback về hành vi cũ (manual).
- **Đường interactive** (`runPromptTask`): có error đầy đủ + nút "Chạy tiếp", nhưng nút đó re-prompt đúng session chết → vô ích cho overflow. Không sửa — design này chỉ cho worker.
- **Rate limit / usage cap**: KHÔNG respawn (chờ là hết — `formatTurnFailure` đã phân biệt 3 loại này; logic phân loại giữ nguyên ở format.ts).

### 0.4 Bối cảnh có sẵn cho handoff tại thời điểm failure

| Piece | Nguồn runtime | Ghi chú |
|---|---|---|
| Original task | `WorkerInfo.task` (state.json) | chỉ set lúc spawn; **follow-up KHÔNG được lưu** vào WorkerInfo |
| Follow-ups (lệnh giữa chừng) | `oc.listMessages(sid, 50)` → messages `type === "user"`, bỏ message đầu (spawn prompt) | gồm cả follow-up của Manager lẫn user nhắn thẳng vào topic |
| Text cuối của worker | `oc.latestReply(sid, 0, {lastTurn:true})` | `onWorkerFinished` đã fetch (biến `tail`) |
| Working directory | `ChatState.directory` | với worker có worktree: đúng thư mục worktree (chứa toàn bộ state on-disk) |
| Worktree | `WorkerInfo.worktree {root, branch, base}` + `WorkerInfo.repoRoot` | branch `tg/<name>-<id>` giữ commit; **uncommitted changes nằm on-disk** trong worktree dir |
| Git evidence | `diffSummary(wt)` (worktree.ts:51) — diffstat + untracked so với base | worker KHÔNG có worktree: cần helper mới (mục 3) |
| Error text | tham số `error` của `onWorkerFinished` | |
| Agent / writes | `ChatState.agent`, `WorkerInfo.writes` | worker mới inherit y hệt |
| Session ID | `ChatState.sessionID` | session cũ bỏ lại (không delete — prune/removeSession xử lý sau) |

## 1. Detection

**Signal:** `status === "failed"` **và** `isOverflowError(error)`, với `error` là string từ `session.execution.failed` (bot.ts:1937).

**Hook point (chính xác):** trong `Orchestrator.onWorkerFinished(conv, status, error)` (orchestrator.ts:700), ngay **sau** `this.setStatus(conv, status, tail)` (dòng 715) và **trước** khối auto-close (dòng 724). Lý do đặt sau `setStatus`: (a) worker cũ phải đã nằm `failed` trước khi worker mới `running` — `busyCount`/`/board` luôn nhất quán; (b) `finishing` Set đã chống double-fire cho cùng conv.

**Decision function (pure, testable):**

```ts
// src/recovery.ts
export function isOverflowError(error: string | undefined): boolean;
// nội dung: CONTEXT_OVERFLOW_RE.test(error ?? "") — import predicate từ format.ts

export function shouldRespawnWorker(p: {
  status: WorkerStatus;       // phải === "failed"
  error?: string;             // phải match overflow
  respawnedFrom?: string;     // đã là respawn rồi → KHÔNG respawn lần 2 (budget)
  hasTask: boolean;           // phải có original task (spec tự chứa) — v1 chỉ tự respawn worker có task
  enabled: boolean;           // cfg.recoverOverflow
}): boolean;
// = enabled && status === "failed" && isOverflowError(error) && !respawnedFrom && hasTask
```

Các guard và ý đồ:

| Guard | Chống |
|---|---|
| `!respawnedFrom` | **Budget: tối đa 1 auto-respawn per original task.** Field persisted trong state.json → sống qua restart. Respawn-2 chết lần 2 → failed thường, không có worker thứ 3. |
| `hasTask` | Không spec tự chứa → handoff yếu; v1 giữ hành vi manual (worker do user `/spawn` không có task → không tự respawn). |
| `status === "failed"` | `stopped` (user /kill) và `done` không bao giờ respawn. |
| `enabled` | Toggle tắt khẩn cấp khi có bug. |

**Fallback khi event thiếu error (shape thay đổi):** v1 KHÔNG làm — an toàn vì fallback là hành vi cũ (manual). Ghi chú v1.1: trích error từ message `idle`/`compaction`/`assistant` mới nhất (đúng logic promptAndWait opencode.ts:480-500, tách ra helper dùng chung) — chỉ bổ sung khi quan sát thấy event thiếu error trong thực tế.

## 2. Handoff construction

### 2.1 Prompt của worker mới

Khởi tạo bằng đúng `workerPreamble(name2)` (như spawn thường — giữ contract Telegram headless), sau đó:

```
[workerPreamble]

## Original task
{w.task}                                     ← đầy đủ, không truncate

## Follow-up instructions issued before the crash (in order)
{follow-ups, mỗi dòng 1 chỉ thị, tổng ≤ 2000 char, "…" nếu cắt}
(omit section nếu không có)

## State where the previous worker stopped
- Directory: {s.directory}{ if worktree: " (git worktree, branch {branch}, base {base})"}
- Git evidence:
  {worktree ? diffSummary : gitStatusBrief}  ← ≤ 1500 char
- Last message of the previous worker:
  {tail — lastReply của turn chết, hoặc "error: …" khi không có text}  ← ≤ 1500 char

## What happened
The previous worker session hit the model's context limit and is permanently
unusable. You are a FRESH session in the SAME directory — all its on-disk
work (committed and uncommitted) is still there.

## Rules
1. Do NOT redo work that is already on disk — inspect the git state first.
2. If a file is left half-edited/broken, fix or revert it (git checkout -- <file>) before continuing.
3. Finish the remaining parts of the original task. If it is already complete,
   verify (typecheck/tests per the repo) and report done.
4. END with the usual ≤10-line summary.
```

**Ngân sách:** mỗi piece có cap riêng (mục 2.2) → prompt handoff thực tế 2–6K tokens, nhỏ hơn nhiều so với context worker cũ đã phình tới 160K. Không cần chunking.

**Mỗi piece lấy từ đâu ở runtime** (xem bảng 0.4). Note về follow-ups: cần helper đọc text user message — `assistantText` (opencode.ts:105) đọc `m.content[].text`; user message dùng cùng cấu trúc parts → thêm `userText(m)` cạnh nó (verify shape `content` vs `parts` lúc implement; `latestReply` hiện mới dùng `time.created` của user messages).

### 2.2 Pure helpers (src/recovery.ts)

```ts
export interface HandoffParts {
  originalTask: string;              // bắt buộc (đã guard hasTask)
  followUps?: string[];
  lastWorkerText?: string;
  directory: string;
  worktree?: { branch: string; base: string };
  gitEvidence?: string;
  error?: string;
}

export function buildHandoffPrompt(p: HandoffParts): string;
// truncate nội bộ: followUps tổng ≤2000, gitEvidence ≤1500, lastWorkerText ≤1500
// (constant exported: FOLLOW_UPS_MAX = 2000, EVIDENCE_MAX = 1500, LAST_TEXT_MAX = 1500)

export function respawnName(oldName: string): string;
// `${oldName}-2`, cut oldName về 21 char đầu nếu tổng > 24 (NAME_RE: max 24, [a-z0-9-])
// oldName đã valid → kết quả luôn valid; nếu trùng tên (cực hiếm) spawn() tự throw, wiring catch + warn

export function respawnNotice(oldName: string, newName: string): string;
// VN, 1 dòng: `⚠️ Worker <b>{old}</b> đầy context — đã tạo <b>{new}</b> tiếp tục trong cùng thư mục.`

export function followUpsOf(userMessages: { text: string }[]): string[];
// bỏ message đầu (spawn prompt), map về text, drop empty
```

### 2.3 Worker mới chạy ĐÂU — quyết định quan trọng nhất

**Cùng thư mục, cùng worktree/branch với worker cũ.** Session OpenCode không giữ file state — toàn bộ kết quả nằm on-disk (commit trên nhánh `tg/…` + uncommitted trong worktree dir). Session mới tạo trong **cùng directory** (`createSession(s.directory)`) kế thừa tất cả.

Hậu quả thiết kế: **không được chạy respawn qua đường worktree-isolation của `spawn()`** (orchestrator.ts:556-570):
- Nếu `worktreeMode === "always"` (hoặc có writer khác đang bận cùng repo) → spawn() tạo worktree MỚI từ HEAD → **mất uncommitted work** (checkout mới chỉ có committed state).
- Nếu `s.directory` đã là worktree dir → `gitRoot()` trả về worktree root → tạo "worktree of worktree" từ nhánh `tg/…` — lệch base, mất uncommitted.

→ Thêm flag `isolate?: boolean` vào `SpawnSpec`; `isolate === false` → `spawnReserved` bỏ hẳn khối worktree, dùng directory như đã vet. Sau spawn, **copy `worktree` + `repoRoot` từ WorkerInfo cũ sang WorkerInfo mới** để nút `/wt` (diff/merge/xoá) tiếp tục hoạt động đúng nhánh.

## 3. Integration sketch

> Chỉ tên hàm + call site, không phải code đầy đủ. Pattern: **pure module + thin wiring** (như `src/reminders.ts` + bot.ts, `src/continue.ts` + bot.ts).

### 3.1 File mới `src/recovery.ts` (pure, ~120 dòng)

Các hàm ở mục 1 + 2.2. Không import gì ngoài predicate overflow (đã export) từ `src/format.ts` và type `WorkerStatus` từ `src/state.ts`.

Test: `scripts/test-recovery.ts` (pattern của test-continue.ts), vào `test:unit` (package.json).

### 3.2 Diff các file hiện có

| File | Thay đổi |
|---|---|
| `src/format.ts` | Export predicate overflow (vd `export function isOverflowError(text: string): boolean` bọc `CONTEXT_OVERFLOW_RE`); `formatTurnFailure` gọi nó (không đổi hành vi) |
| `src/state.ts` | `WorkerInfo.respawnedFrom?: string` — additive, backward-compat với state.json cũ |
| `src/config.ts` | `recoverOverflow: process.env.OPENCODE_TG_RECOVER_OVERFLOW !== "0"` (default ON, cùng convention với `autoClose`); test trong test-config |
| `src/worktree.ts` | `export async function gitStatusBrief(dir: string): Promise<string>` — `status --porcelain` + `diff --stat` + `log -1 --oneline`, best-effort (trả `""` nếu không phải repo) |
| `src/opencode.ts` | `export function userText(m: any): string` cạnh `assistantText` (đọc text parts của user message) |
| `src/orchestrator.ts` | (a) `SpawnSpec.isolate?: boolean`; (b) `spawnReserved`: `isolate === false` → skip khối worktree (dòng 556-570); (c) hook trong `onWorkerFinished`; (d) private `respawnOverflow(conv, error)` |

### 3.3 Wiring trong `Orchestrator`

**Hook** — trong `onWorkerFinished` (orchestrator.ts:700-730), chèn sau `this.setStatus(conv, status, tail)`:

```
let respawned = false;
if (status === "failed" &&
    shouldRespawnWorker({ status, error, respawnedFrom: w.respawnedFrom,
                          hasTask: !!w.task, enabled: this.h.cfg.recoverOverflow })) {
  respawned = await this.respawnOverflow(conv, w, tail, error);
}

… (worktree card, manager report như hiện tại, nhưng report khi respawned
  ghi: "[worker {name}] FAILED (context overflow) → respawned as {name2} —
  continuing in the same worktree; the new worker will report on its own.")

if (cfg.autoClose && (status === "done" || status === "failed") && !respawned) {
  // NEW: topic worker chết VÌ overflow được GIỮ MỞ (❌) để user đọc lại;
  // /prune dọn sau. Tránh đóng topic ngay khi vừa thông báo "đã tạo worker mới".
  void this.h.tg.closeForumTopic(conv).catch(() => {});
}
```

**`respawnOverflow(conv, w, tail, error): Promise<string | undefined>`** — trả tên worker mới (hoặc undefined khi không respawn được):

```
1. s = st.get(conv)
2. followUps = userText(...) các user messages từ oc.listMessages(s.sessionID, 50), bỏ cái đầu
3. gitEvidence = w.worktree ? await diffSummary(w.worktree)
                            : await gitStatusBrief(s.directory)
4. name2 = respawnName(w.name)
5. task = buildHandoffPrompt({ originalTask: w.task, followUps, lastWorkerText: tail,
                               directory: s.directory, worktree: w.worktree, gitEvidence, error })
6. await sendHtml(conv, respawnNotice(w.name, name2))          ← thông báo DUY NHẤT cho user
7. try { r = await this.spawn(chatOf(conv),
        { name: name2, directory: s.directory!, task, agent: s.agent,
          writes: w.writes, spawnedBy: "manager", isolate: false }) }
   catch (e) { await sendHtml(conv, `⚠️ Không tự tạo worker thay thế được: ${e.message}`); return undefined }
8. // gắn lineage + giữ thông tin worktree để /wt tiếp tục hoạt động
   st.set(r.conv, { worker: { ...st.get(r.conv).worker!, worktree: w.worktree,
                              repoRoot: w.repoRoot, respawnedFrom: w.name } })
9. return name2
```

Lưu ý wiring:
- `spawn()` đã có name reservation + `assertCapacity` — nếu chat đang **đủ maxWorkers**, respawn bị reject ở bước 7 → user nhận 1 dòng "không tự tạo được" thay vì im lặng (worker cũ vẫn ❌ như hiện tại).
- `spawnedBy: "manager"`: không qua approval flow (đây là hệ thống tự chạy, không phải manager LLM quyết) nhưng manager vẫn nhận report ở hook → Manager có thể `send_to_worker` follow-up tiếp.
- Dead session cũ: **không** `removeSession` — giữ để `/history` và forensic; state.json entry của topic cũ nguyên vẹn (status failed).
- Race với user nhắn thẳng vào topic cũ trong khi respawn đang chạy: tin nhắn đó rơi vào session chết → 400 → user thấy thông báo lỗi turn thường (đường interactive), an toàn.

### 3.4 Tóm tắt call sites

| Call site | Gọi gì |
|---|---|
| `Bot.onOpenCodeEvent` (bot.ts:1937) | **không đổi** — error string đã về `orch.onExecution` |
| `Orchestrator.onWorkerFinished` | `shouldRespawnWorker` → `respawnOverflow` |
| `Orchestrator.respawnOverflow` (mới) | `respawnName`, `buildHandoffPrompt`, `followUpsOf`, `respawnNotice`, `oc.listMessages`, `userText`, `diffSummary`/`gitStatusBrief`, `spawn` |
| `Orchestrator.spawnReserved` | nhận `spec.isolate === false` → skip isolation |
| `scripts/test-recovery.ts` (mới) | unit test toàn bộ pure functions |

## 4. Risks

1. **Chi phí respawn.** Mỗi lần respawn = 1 session mới đọc lại codebase từ đầu + prompt handoff (2–6K tokens). Bounded: **tối đa 1 lần per original task** (`respawnedFrom` persisted). So với baseline manual (manager đọc git status, soạn handoff, spawn — cùng chi phí token nhưng thêm round-trip người/manager, dễ sót context), auto-respawn không bao giờ tệ hơn, thường tốt hơn. Có `OPENCODE_TG_RECOVER_OVERFLOW=0` để tắt hẳn.
2. **Infinite loop.** Chặn bằng `respawnedFrom` (persisted → sống qua restart) + `shouldRespawnWorker` pure đã test. Các vòng lặp tiềm tàng khác đã có sẵn: `finishing` Set (double turn-end), `DISPATCH_BUDGET` (manager), name collision → `spawn()` throw (bước 7 catch). Respawn-2 chết lần 2 → failed thường, **không** có worker thứ 3 — tính năng được test riêng trong test-recovery.ts.
3. **Worker chết mid-edit (dirty worktree).** Uncommitted changes **không mất** (nằm on-disk trong worktree dir, session mới kế thừa). Rủi ro còn lại: file cắt nửa → prompt có rule #2 (fix hoặc `git checkout -- <file>` trước khi tiếp). Worker **không có repo** thì không có safety net revert — chấp nhận (vẫn tốt hơn manual). Worktree mode "always" đã được xử lý bằng `isolate: false` (mục 2.3) — đây là rủi ro lớn nhất đã né được bằng thiết kế.
4. **UX Telegram.** User thấy: (a) **1 dòng** trong topic cũ ("⚠️ đầy context — đã tạo name-2…"), (b) topic mới name-2 với intro + task handoff (spawn flow hiện có), (c) 1 report trong main chat qua `queueReport` (đã debounce 4s, batched). Không có storm: dead topic giữ mở ❌ (không close ngay) nhưng không phát sinh thêm thông báo; `/prune` dọn.
5. **Phụ thuộc shape error trong event.** Nếu OpenCode đổi shape `execution.failed.data.error` → detection miss → **fallback an toàn về hành vi cũ** (manual). Không có failure mode "respawn sai" do regex: `CONTEXT_OVERFLOW_RE` chỉ match các cụm overflow rõ ràng; rate limit/usage cap không khớp.
6. **`healWorkers` không phát hiện overflow** (không có error text) — worker overflow mà bot restart đúng lúc đó sẽ không auto-respawn. Gap chấp nhận, ghi trong success criteria là known limitation.

## 5. Success criteria + size + slicing

### Success criteria

1. **Unit** (`npm run test:unit` + `npm run typecheck`): test-recovery.ts phủ (a) `isOverflowError` với string litellm thật `"Requested token count exceeds the model's maximum context length of 160000 tokens"` → true; rate-limit/usage-cap string → false; undefined → false. (b) Bảng decision `shouldRespawnWorker`: mọi tổ hợp của {status, error, respawnedFrom, hasTask, enabled} — đặc biệt respawnedFrom set → false dù còn lại đúng. (c) `respawnName`: normal, >24 char clamp, hợp lệ NAME_RE. (d) `buildHandoffPrompt`: đủ 5 section, truncate đúng cap, omit follow-ups khi rỗng. (e) `followUpsOf`: bỏ message đầu, drop empty.
2. **E2E manual** (sau khi implement): spawn worker (manager, agent build, repo có worktree) với task đủ lớn để overflow 160K → quan sát: ① 1 dòng notice trong topic cũ; ② topic `name-2` mới đang chạy **cùng worktree/branch** (`/wt` trong topic mới vẫn hiện đúng branch cũ); ③ worker cũ ❌, worker mới 🟢 trong `/board`; ④ `state.json` của topic mới có `respawnedFrom: "<cũ>"`; ⑤ report trong main chat; ⑥ **cố tình làm worker name-2 overflow lần 2** (gửi task khổng lồ tiếp) → ❌ thường, **không** có worker thứ 3.
3. **Không regression:** failure không-phải-overflow (rate limit) vẫn hiển thị như cũ, không respawn; worker `stopped` không respawn; `OPENCODE_TG_RECOVER_OVERFLOW=0` tắt toàn bộ.
4. **Known limitation (ghi nhận, không block):** heal path (post-restart) không auto-respawn — cần v1.1 với message-scan fallback.

### Estimated size: **M** (~350–450 dòng kể cả test)

- `src/recovery.ts` + `scripts/test-recovery.ts`: ~240
- `src/orchestrator.ts` (hook + `respawnOverflow` + `SpawnSpec.isolate`): ~120
- `src/worktree.ts` `gitStatusBrief` + `src/opencode.ts` `userText` + `src/state.ts` + `src/config.ts` + `src/format.ts` export: ~60

### Slicing cho worker implement (rule: mỗi slice ≤ 1 worker, task tự chứa)

| Slice | Size | Nội dung | Phụ thuộc |
|---|---|---|---|
| **1** | S | `src/recovery.ts` (pure) + `scripts/test-recovery.ts` + export `isOverflowError` ở format.ts + test-config cho `recoverOverflow` + wiring `test:unit` | — (không đổi hành vi, merge an toàn) |
| **2** | M | Wiring: hook trong `onWorkerFinished` + `respawnOverflow` + `SpawnSpec.isolate` + field `respawnedFrom` + `gitStatusBrief` + `userText` | slice 1 |
| **3** (optional) | S | Early-warning heuristic (dưới) | slice 2 |

### Optional phase: early-warning heuristic (khuyến nghị để SAU, tách hẳn)

OpenCode **không có field "context còn lại"** (comment trong `SessionReport`, opencode.ts:44-49). Nhưng `session.step.ended` carry `tokens` per LLM step (đã verify live — memory #26) và bot **chưa** consume event này. Heuristic: theo dõi `max(input + cache)` qua các step trong turn; khi vượt `OPENCODE_TG_CONTEXT_WINDOW` (default 160000) × 0.85 → log + **1 dòng** trong topic worker ("⚠️ context đã dùng ~85% — cân nhắc kết thúc sớm để tránh overflow"). Pure function `contextPressure(peakInputTokens, window, threshold): boolean` trong recovery.ts. **Không** auto-interrupt mid-turn: cắt turn đang chạy chỉ tiết kiệm nếu turn kế tiếp là prompt mới, mà khi đó overflow-respawn (design này) tự lo — heuristic chỉ để user biết.
