# agent-browser (vercel-labs) — Báo cáo nghiên cứu

> Repo: vercel-labs/agent-browser v0.43.0 (shallow clone tại `/home/phatnd12/fpt/agent-browser`, Apache-2.0, ~150k dòng Rust)
> Người đọc: chủ dự án **opencode-telegram-bot** (bot Telegram Node.js/TS điều khiển OpenCode agents từ xa; các worker hiện dùng **browsermcp** để duyệt web)
> Ngày: 2026-11-19. Phương pháp: đọc docs + code thật, không build/chạy. Mọi `file:line` trỏ vào clone này.

---

## 1. Dự án là gì

agent-browser là **CLI native Rust** cho phép AI agent lái trình duyệt "một lệnh một bước" (README.md:13). `snapshot` trả page dưới dạng **accessibility tree compact** với mỗi element mang một ref `@eN`; agent thao tác trên ref, đọc lại page để verify, lặp lại. Browser **giữ mở giữa các lệnh** nên mỗi bước chỉ là một shell call ngắn (README.md:13).

- v0.43.0 (package.json:3), Vercel Labs, Apache-2.0; 50+ commands (docs/content/docs/index.mdx "Features")
- Engines: Chrome mặc định (tự download **Chrome for Testing**, install.rs:8), Lightpanda/Obscura qua `--engine`, Mobile Safari + iOS Simulator qua WebDriver, cloud providers (Browserbase, Browserless, Browser Use, Kernel, AgentCore)
- Kiến trúc **client-daemon**: CLI ngắn sống → daemon per-session sống lâu (Unix socket) → Chrome qua CDP (index.mdx "Architecture")
- Đưa theo **Agent Skills** được chính CLI serve (`agent-browser skills get core`) nên luôn khớp version CLI đã cài; kèm **MCP server** (`agent-browser mcp`) với tool profiles cho client MCP
- Phân phối: npm với optional deps per-platform (cài chỉ tải binary đúng host), Homebrew, npx, Docker image cross-compile (docker/Dockerfile.build)

## 2. Kiến trúc & workflow core — snapshot + ref loop

### 2.1 Core loop

```
open <url>  →  snapshot -i  →  click @e3  →  wait --text "..."  →  snapshot -i (verify)
```

(skill-data/core/SKILL.md "The core loop"; docs/content/docs/quick-start.mdx)

### 2.2 Pipeline build snapshot (code thật)

Trong daemon, `cli/src/native/snapshot.rs`:

1. **`take_snapshot()` (snapshot.rs:358)** — bật `DOM.enable` + `Accessibility.enable`, gọi CDP **`Accessibility.getFullAXTree`** (snapshot.rs:467). AX tree trang lớn "chạy tới hàng megabyte" nên parse thẳng từ text, không qua JSON Value (comment snapshot.rs:464-466).
2. **Scoping `-s <css>`** — `DOM.describeNode` (depth -1, pierce shadow roots) lấy tập `backendNodeId` của subtree, chỉ render các AX root thuộc subtree (snapshot.rs:371-510).
3. **`build_tree()` (snapshot.rs:1165)** — flat AXNode list → tree; **gộp các chuỗi StaticText liên tiếp** (snapshot.rs:1206-1236); khử trùng lặp khi parent name == child StaticText (snapshot.rs:1244-1252). Node bị a11y "ignore" bị bỏ (snapshot.rs:1179-1183).
4. **Gán ref (snapshot.rs:520-600)**:
   - `INTERACTIVE_ROLES` = button, link, textbox, checkbox, radio, combobox, listbox, menuitem*, option, searchbox, slider, spinbutton, switch, tab, treeitem, Iframe (snapshot.rs:107-127) — luôn có ref;
   - `TABLE_CELL_ROLES` = cell/gridcell/columnheader/rowheader (snapshot.rs:128);
   - `CONTENT_ROLES` = heading, listitem, article, region, main, navigation — chỉ khi có name (snapshot.rs:130-140);
   - cộng thêm **element có `cursor:pointer`** phát hiện bằng JS scan (`find_cursor_interactive_elements`, snapshot.rs:848) — bắt các "nút giả" (div có click handler); hidden input được promote (`promote_hidden_inputs`, snapshot.rs:1138).
   - **Ref bền (durable)**: cùng `backendDOMNodeId` trong cùng document (loader) → **tái dùng ref id cũ** (`durable_ref`/`remember_durable_ref`, element.rs:204/217) → "Surviving DOM elements retain their refs across snapshots and same-document updates" (docs snapshots.mdx "Ref lifecycle"). Counter tăng đơn điệu, **không bao giờ recycle id** (RefMap.next_ref, element.rs:28-40).
5. **`render_tree()` (snapshot.rs:1300)** — format text: mỗi dòng = `indent + "- " + role + " " + "name"` + `[ref=e1, level=1, checked=..., disabled=...]`; bỏ qua role rỗng, `generic` không ref và ≤1 child, StaticText rỗng, wrapper WebArea (snapshot.rs:1307-1340).
6. **`compact_tree()` (snapshot.rs:1431)** — `-c`: giữ lại dòng có ref/`": value"`/text cùng chuỗi ancestor (dùng stack để không O(n²) trên bảng lớn).

Lưu ý nhỏ: code thật emit dạng `- button "Submit" [ref=e2]`; một số ví dụ trong docs/skill viết dạng `@e2 [button] "Submit"` (docs snapshots.mdx, SKILL.md) — hai notation song song, chưa rõ có chủ ý không (cần xác minh).

### 2.3 Vì sao format compact (và thân thiện LLM)

- **Access tree chứ không phải DOM/HTML**: semantic role + accessible name, không tag/attribute/markup noise, không hidden nodes.
- **Filter là mặc định khuyến khích**: `-i` interactive-only (snapshot.rs:1341-1347: bỏ node không ref nhưng vẫn render children), `-d N` giới hạn depth (snapshot.rs:1327-1330), `-s` scope theo selector.
- **Một dòng một element, hierarchy bằng indent** — "LLMs parse text output naturally" (index.mdx:48-53); số liệu của họ: **~200-400 tokens vs ~3000-5000 cho full DOM** (index.mdx:52).
- **Deterministic**: ref trỏ đúng element tại thời điểm snapshot, không cần re-query DOM (selectors.mdx "Why refs?").
- **Verify-after-act**: skill cấm screenshot để kiểm tra — "Never screenshot to check whether an element exists... A snapshot is faster and uses far fewer tokens" (SKILL.md "The core loop"). Snapshot chính là công cụ verify.
- **Hints cho control mơ hồ** (v0.43.0, CHANGELOG.md:9; docs snapshots.mdx "Control hints"): control không có accessible name (hoặc name trùng ref khác) được gắn `hint="img:cart"`, `hint="id:edit-btn; in:Blue mug"` — icon (svg use/id/data-icon, class icon library), tên file ảnh, `data-testid`/`name`/`id`, text của row/list-item gần nhất. Đây là câu trả lời trực tiếp cho lỗi kinh điển của LLM: nhiều button không tên trong cùng một list.

### 2.4 Vì sao paradigm hợp với LLM agent

- **Token efficiency**: mỗi bước vài trăm token text; browser giữ mở nên không tốn lại open/navigate.
- **Determinism**: model chỉ việc **chọn ref đã thấy** — không phải tự soạn selector/XPath (vốn là nguồn lỗi lớn của LLM).
- **Verifiability**: sau mỗi action, snapshot mới cho thấy state mới; agent phát hiện "click vô hiệu" vì state không đổi — thay vì tin return success.
- **Mỗi bước = 1 shell call ngắn**: không có state dài ngày phía agent (daemon giữ hết), nên retry/parallel dễ; chỉ cần harness chạy được bash (đúng với OpenCode workers).

### 2.5 So sánh nhanh với các cách làm khác

Repo **không có section so sánh trực tiếp** với Playwright MCP / Chrome DevTools MCP (docs chỉ định vị chung: "agent-first", "compact text", "100% native Rust", "each step is one short shell call" — index.mdx, README.md:13). Điều đọc được từ code:

- **browsermcp (hệ thống hiện dùng)**: một MCP server, một tool `browser` nhận dòng lệnh text (snapshot/click/find), điều khiển **Chrome của user** (có cửa sổ, dùng cookies của user, một browser duy nhất cho mọi worker). agent-browser: **CLI + daemon riêng, mặc định headless, Chrome riêng** (Chrome for Testing), mỗi `--session` một browser; snapshot là a11y tree + ref có validation fail-not-success; kèm sessions/state/security/skills/evals đầy đủ. Hai bên cùng họ paradigm (snapshot → act → verify) nhưng khác hẳn về **ownership của browser** và lớp vận hành.
- **Playwright MCP / Chrome DevTools MCP**: agent-browser coi **CLI là bề mặt chính, MCP là bề mặt phụ** — `mcp` chỉ là một command của CLI (mcp.rs), MCP server chia tool theo profiles Core/Network/State/Debug/Tabs/React/Mobile/Webmcp (mcp.rs:270-280) để giảm bề mặt; evals **context-footprint đo trực tiếp** token của đường CLI text vs đường MCP `initialize` + `tools/list` phân trang (evals/context-footprint.ts). Lập luận của họ: với agent chạy được shell, CLI + daemon giữ state rẻ và tự nhiên hơn MCP.
- **Điểm chung của cả ba**: snapshot-based interaction, không cho LLM tự đoán selector mù. agent-browser khác ở ref durable + stale-recovery có kiểm soát, hit-test validation cấp browser, và lớp vận hành (daemon/session/security/doctor/skills/evals).

## 3. 10 điểm hay nhất

### 3.1 Click "FAIL instead of reporting success" — validation 3 lớp

Nêu công khai ở README.md:46: "A click fails, instead of reporting success, when the target is hidden, disabled, outside the viewport, or covered by another element such as a consent banner."

Trước khi dispatch click, chạy 3 lớp kiểm tra:

1. **Actionability** (`ACTIONABILITY_JS`, element.rs:1121): zero-size hoặc `visibility: hidden|collapse` → lỗi "not visible"; `disabled` → "disabled"; hết scroll tự động mà vẫn ngoài viewport → "outside the viewport". Auto-scroll nằm trong `CLICK_POINT_JS` (element.rs:1044): `scrollIntoViewIfNeeded` + tối đa 2 lần `scrollIntoView({block:'center'})` + settle 5 animation frame trước khi đo lại.
2. **Blocker** (`BLOCKER_AT_JS`, element.rs:986): `elementFromPoint` tại điểm click (lội xuống same-origin iframes kèm transform toạ độ); nếu element nhận click không phải target, không phải ancestor/descendant (kể cả qua shadow root), không phải label liên kết → lỗi `intercepted_error`: "Element '@e5' is covered by \<div#cookie-banner\> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header)." (element.rs:1185).
3. **Hit-test quyền uy từ chính browser** (`place_in_dispatch_viewport`, click_point.rs:37): lấy tâm content quad lớn nhất từ box mà browser báo (`dispatch_point`, click_point.rs:109), rồi `hit_test` (click_point.rs:221) gọi CDP **`DOM.getNodeForLocation`** — browser **tự trả lời node + frame nào sẽ nhận cú press**. Click chỉ được tiếp tục nếu receiver chính là ref, là element **kích hoạt** ref (kiểm tra trong **isolated world** để page script không impersonate được — `node_activates_ref`, click_point.rs:265), hoặc frame mà ref embed. Browser không xác định được receiver → **từ chối click** (fail-closed, click_point.rs:225-231). Cross-origin iframe cùng renderer được xử lý qua box geometry (module doc comment click_point.rs:1-17).

**Vì sao hay**: biến lỗi im lặng phổ biến nhất trong agent browsing (click "thành công" nhưng trúng overlay/banner) thành error **mô tả đúng việc cần làm tiếp**. Error message được viết như chỉ dẫn cho LLM: SKILL.md "Troubleshooting" là một bảng error-message → động-thức (ví dụ `covered by <...>` → "dismiss that element first").

### 3.2 Ref lifecycle: bền trong same-document update, recover an toàn khi ambiguous

- Ref key bởi `backendDOMNodeId` trong document nhận diện bằng CDP **loader id**. `observe_document` (element.rs:161) theo dõi `(page_session, frame) → {session, loader}`; navigation đổi loader → refs document đó hết hiệu lực, snapshot mới = id mới, không recycle.
- Node bị thay: action **không fail mù** — re-query AX tree tìm node cùng role+name, **chỉ khi match duy nhất** (`select_unique_node_id`, element.rs:888). Trùng → "Stale ref for role=button name=Approve cannot be recovered: several elements now match. Run snapshot again and use a fresh ref." (element.rs:870/900; test mẫu element.rs:1793).
- Action cần đúng node cụ thể dùng `add_exact_backend_node` (element.rs:80) tắt hẳn fallback role/name → error cứng "Element ref @e5 is stale" (element.rs:469/716).
- Lối resolve: fast path `DOM.resolveNode` trên cached backend id → `node_click_point` (element.rs:628) đo điểm + actionability; fail thì mới đi fallback (resolve_element_center, element.rs:426-500).

**Vì sao hay**: phổ cấp "dễ dãi nhưng không bao giờ sai" — ambiguous thì fail, không đoán; đúng node thì không bao giờ chuyển mục tiêu. Cùng triết lý với 3.1 nhưng ở cấp nhận diện element.

### 3.3 Transport nhận diện idempotency: mã lỗi `outcome_unknown`

Wire: một dòng JSON request → một dòng JSON response trên Unix socket (Windows: TCP 127.0.0.1 + port file) (connection.rs:1384, 1207-1220). Client theo dõi **đã có byte nào được chấp nhận chưa** (exchange, connection.rs:1400+). Nếu connection chết giữa chừng:

- Action **read-only** (bảng `READ_ONLY_ACTIONS`: url, title, snapshot, get*, count, cookies_get, ...) được retry (tối đa 5 lần, backoff 200ms, `send_with_retry`, connection.rs:1280);
- Action **đổi state** (click, fill, eval, navigation) **không bao giờ resend** — fail với mã `outcome_unknown`: "the command reached the daemon but no response came back; it may or may not have run, so it was not retried" (connection.rs:1294-1303).

**Vì sao hay**: không có double-click từ network hiccup. Đây là phiên bản transport của "fail rather than report success" — đúng semantics mà một bot dispatch action qua mạng cần.

### 3.4 Daemon per-session với flock, không phụ thuộc PID namespace

- `ensure_daemon` (connection.rs:994) giữ **flock** trên `<session>.lock` (`SpawnLock`, connection.rs:969-992): hai lệnh CLI đồng thời được serialize; kẻ sau attach vào daemon kẻ thắng.
- **Liveness = socket connect được thôi** (không check PID) → hoạt động xuyên PID namespace (container, unshare) (comment connection.rs:1005-1010). Không có settle-sleep cố ý: chạy mỗi lệnh nên không được phép ngủ (comment connection.rs:1013-1016).
- File `.version` sidecar: CLI upgrade → daemon cũ bị kill + restart (connection.rs:1011-1024).
- Daemon = chính binary re-exec với `AGENT_BROWSER_DAEMON=1`, `setsid()`, stdio tách (connection.rs:1088-1110). Pre-flight: socket path ≤103 bytes (giới hạn Unix), thư mục socket writable (connection.rs:1058-1086).
- Dọn stale: `walk_daemons` (connection.rs:318) phân loại `.pid`/`.sock`; `is_pid_alive` (connection.rs:176: EPERM vẫn tính sống — daemon của uid khác; chỉ ESRCH là chết) và `is_agent_browser_process` (connection.rs:201: đọc `/proc/<pid>/exe` để không nhầm PID bị recycle sang program khác).

**Vì sao hay**: mô hình "một daemon cho một browser logic" vững trước sự kiện thật của môi trường production: nhiều tiến trình cùng gọi, PID trùng, daemon chết dở, CLI upgrade giữa chừng.

### 3.5 Multi-session isolation + `--pin-tab` khi chia sẻ Chrome

- Mỗi `--session` = daemon riêng + Chrome riêng, isolate cookies/storage/history/auth (docs sessions.mdx "Session isolation").
- `session id --scope worktree --prefix x` sinh tên session **ổn định theo worktree** (SKILL.md:16, 187) — ánh xạ thẳng "một browser cho một task/git-worktree".
- Nhiều session **chia sẻ một Chrome** qua `--cdp`: mỗi session bind tab theo CDP target id (persist xuyên daemon restart); `--pin-tab` làm binding chặt: tab bị đóng → lỗi `tab_gone` thay vì im lặng thao tác nhầm tab của session khác; session khác không chiếm được tab đã pin (`tab_locked`) (sessions.mdx "Tab pinning in a shared browser").

**Vì sao hay**: với hệ thống multi-worker (chính xác là trường hợp của bot), đây là miếng mà browsermcp thiếu: browser song song rẻ, first-class, và **fail rõ ràng khi mất tab**.

### 3.6 Skills do chính CLI serve — luôn khớp version

- `skill-data/core/SKILL.md` (264 dòng) + 10 skills chuyên biệt: electron, slack, dogfood, derive-client, webmcp-gen, modern-web-guidance, vercel, vercel-sandbox, agentcore (skill-data/).
- Serve từ binary: `agent-browser skills get core`, một reference `--ref commands`, `--full` (skills.rs:30-39, 557). **Skill luôn khớp CLI đã cài** — không có docs cũ.
- Discovery stub cài vào harness (`skills/agent-browser/SKILL.md`) cố tình mỏng: chỉ bảo agent chạy `skills get core` (README.md "For AI agents").
- **Lazy-load có bảng routing** (SKILL.md "Load more when you need it"): mỗi reference tải độc lập; eval "reference-routing" kiểm tra agent chỉ tải đúng cái cần (evals/README.md).
- Frontmatter `allowed-tools: Bash(agent-browser:*)` (SKILL.md:4) — giới hạn shell permission của agent quanh CLI.

**Vì sao hay**: đảo ngược vấn đề "docs rot": tool tự ship manual của nó, đúng version, đúng kích thước khi cần.

### 3.7 Evals đo đúng bề mặt agent — kể cả prompt-injection hostile mode

- `evals/` (evals/README.md): 5 category — **skill-loading** (agent có chạy `skills get` trước không), **skill-selection** (chọn đúng skill chuyên biệt), **command-usage** (lệnh đúng cho workflow phổ biến), **reference-routing** (chỉ tải 1 reference cần), **context-footprint** (CLI vs MCP).
- Chấm: **regex expected/forbidden patterns** pass/fail + optional **LLM judge 1-5** (evals/lib/judge.ts:53, model `claude-opus-4.6`).
- `context-footprint.ts` **deterministic**: đo bytes / approx tokens (bytes/4, evals/context-footprint.ts:27-29) của thin skill, `skills get core`, MCP `initialize` + `tools/list` (profile core vs `--tools all`) → report JSON. Đây là bằng chứng đo được cho claim "CLI text rẻ hơn MCP schema discovery".
- `webmcp-context.py`: smoke eval chạy **agent thật** trên shop local; **`--mode hostile`** chèn chỉ thị ác ý vào tool description/schema/result + canary secret; grader từ chối disclosure (evals/README.md "Live WebMCP context eval"). Có `--mode ordinary` làm nhóm control.

**Vì sao hay**: họ test **hành vi của agent quanh tool** (có đọc skill không, có chọn đúng không, có bị prompt-injection không), coi đó là tính năng đo được chứ không phải hy vọng.

### 3.8 Triết lý wait: "Agents fail more often from bad waits than from bad selectors"

SKILL.md:148. `wait` chờ **điều kiện của kết quả mong đợi**: element (`wait @e1`), text (`wait --text "Success"`), URL glob (`wait --url "**/dashboard"`), JS condition (`wait --fn`), lifecycle event (`wait --load load`). Cảnh báo rõ: **không dùng `networkidle` làm SPA-wait chung** (SSE/WebSocket/polling giữ mạng bận nên nó không bao giờ resolve); tránh `sleep` cố định trừ khi debug (quick-start.mdx "Wait for content"). Timeout mặc định 25s; load-wait hết hạn trả về **error** thay vì im lặng (SKILL.md "Waiting").

**Vì sao hay**: best practice cho web async được cô đặc thành một câu, encode cả vào tool lẫn skill (nơi LLM thực sự đọc) — và nó giải thích tại sao "chờ đúng thứ" quan trọng hơn "chọn đúng selector".

### 3.9 Security là first-class feature (containment thật, không chỉ khuyến cáo)

- `--allowed-domains`: containment **cấp browser** — chặn HTTP/WS/EventSource/sendBeacon ngoài allowlist, tắt `RTCPeerConnection` (lách qua STUN/TURN/DNS), guard dedicated/shared workers bằng bootstrap wrapper **fail-closed**; từ chối option khi không cài được containment trước khi page script chạy (trust-boundaries.md; `ensure_allowed_domains_supported_for_launch`, actions.rs:4068).
- Security settings **persist xuyên daemon restart** trong file owner-only cạnh socket; file bị world-readable → daemon **từ chối khởi động** (sessions.mdx "Changing settings on a running session").
- `--action-policy` file: allow/deny/confirm **theo từng action**, **fail-closed** khi load/reload lỗi (policy.rs:19 `ActionPolicy`, :36 `ConfirmActions`, :86 `check`, test fail-closed :222).
- State file: mã hóa **AES-256-GCM** (`AGENT_BROWSER_ENCRYPTION_KEY`), auto-expiry (sessions.mdx "State encryption"/"State auto-expiration").
- `trust-boundaries.md` (skill reference, 69 dòng): page content = untrusted data; secret không bao giờ vào model; không tự đi tới URL do page chỉ; `--init-script` = code injection.

**Vì sao hay**: cho hệ thống để LLM duyệt trang bất kỳ, security model được thiết kế, test, và viết tài liệu — không phải footnote.

### 3.10 `doctor` + bề mặt observability rộng

- `agent-browser doctor`: check environment, Chrome, ffmpeg, daemon, config, security, providers, network (bỏ khi `--offline`), launch (bỏ khi `--quick`), webgpu (`--webgpu`), kèm `--fix` cho sửa chữa phá hủy (cli/src/doctor/mod.rs:106-134).
- Built-in: video recording (cursor overlay, contact sheet), live viewport streaming, dashboard, HAR record + request mocking, Chrome DevTools tracing/profiling, React tree inspection, accessibility audit (axe-core vendored — cli/src/native/a11y/).
- Tiện lợi cho agent: `screenshot --if-changed` (bỏ qua capture không đổi để **tiết kiệm token** — SKILL.md), `screenshot --annotate` (số trên ảnh ánh xạ tới ref @eN — snapshots.mdx), **`snapshot --delta`** (full state một lần, sau đó chỉ phần thay đổi — flag commands.rs:1373; state theo tab trong `DaemonState.snapshot_revisions`, actions.rs:568).

**Vì sao hay**: khi agent fail, có nhiều kênh độc lập để biết tại sao (video, network log, trace, diff) — và error được viết để agent **tự sửa** (bảng Troubleshooting trong SKILL.md).

## 4. State/daemon model & multi-session

### 4.1 Process model

- **Một daemon process cho mỗi session name** (mặc định "default"). CLI process ngắn sống: parse args → `ensure_daemon` → gửi 1 JSON-line request → in kết quả → exit (connection.rs:994, 1384).
- Daemon (`run_daemon`, cli/src/native/daemon.rs:33) giữ toàn bộ state trong **`DaemonState`** (actions.rs:563-640): BrowserManager, **RefMap** (actions.rs:567), `snapshot_revisions` per tab cho `--delta` (actions.rs:568), domain filter, restore/autosave, action policy + pending confirmation, WebMCP runtime, bảng iframe sessions, flow recorder, HAR...
- Wire: JSON line → JSON line trên Unix socket (Windows: TCP 127.0.0.1 + port file) (connection.rs:1384, 1207-1220). Read timeout mỗi request: sàn 30s, kéo dài thêm margin cho lệnh mang field `timeout` (họ cố ý không đọc env ở đây để budget của lệnh wait không áp lên mọi lệnh — comment connection.rs:1356-1382, `read_timeout_for`).
- Retry: tối đa 5, backoff 200ms×attempt, chỉ retry lỗi transient (EAGAIN, EOF, reset; **refused/missing socket không phải transient** — cách chữa là respawn daemon chứ không phải chờ, connection.rs:1331-1360).
- **Idle**: headless browser đóng và daemon exit sau **1 giờ** không lệnh (`arm_idle_sleep`, daemon.rs:278; chỉnh bằng `--idle-timeout` / `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `0` = tắt); headed/Safari/iOS/user-attached được miễn; provider cloud thì không (index.mdx "Architecture"). Có `--restore` thì state được save khi close **và** định kỳ (autosave default 30s, `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS`, daemon.rs:286; sessions.mdx "Session persistence").

### 4.2 File layout per session

Trong socket dir: `<session>.sock`, `<session>.pid`, `<session>.version`, `<session>.settings` (security), `<session>.config`, `<session>.lock` (flock). Socket dir theo thứ tự ưu tiên: `AGENT_BROWSER_SOCKET_DIR` > `XDG_RUNTIME_DIR/agent-browser` > `~/.agent-browser` > tmpdir; `AGENT_BROWSER_NAMESPACE` tách sang `namespaces/<ns>/run` (connection.rs:107-149) — hữu ích cho môi trường multi-tenant.

### 4.3 Multi-session & settings

- `--session <name>` / env `AGENT_BROWSER_SESSION`: isolate đầy đủ (daemon + Chrome + cookies/storage/history/auth) (sessions.mdx).
- Chia sẻ Chrome qua `--cdp <port>`: tab binding + `--pin-tab` (mục 3.5).
- **Settings diffing tinh vi**: mỗi lệnh mang settings của nó (flag/env/config file); daemon so với session đang chạy — omit = giữ giá trị đang chạy, bằng = không làm gì (lặp lại `--profile ./work` không relaunch), khác = apply live nếu được phép hoặc **relaunch browser** (daemon thì sống); mọi thay đổi in 1 dòng lên stderr + liệt kê trong `lifecycle.settings.changes` (json) kèm `applied: true/false` (sessions.mdx "Changing settings on a running session").
- Auth/state: `--state <path>` (JSON cookies+localStorage, load qua CDP không qua page JS), `--profile` (copy read-only snapshot của Chrome profile thật), `--restore` (auto save/load theo session key, kèm validation `--restore-check-text/url/fn` để restore hỏng không ghi đè state tốt), `--headers` scoped theo origin (sessions.mdx).

## 5. Skills & evals

### 5.1 Cấu trúc skill core

`skill-data/core/SKILL.md` (264 dòng) gồm: (1) **luôn dùng session của riêng mình** — `session id --scope worktree --prefix task` — vì session mặc định là browser **chung cho mọi agent trên máy** và persist xuyên hội thoại (SKILL.md "Always use your own session"); (2) **core loop** open → snapshot -i → act → re-snapshot; (3) **ưu tiên snapshot, cấm screenshot để verify**; (4) **wait cho kết quả mong đợi, không wait networkidle**; (5) common tasks: login (+ auth vault `auth save/login` để credential không lộ qua shell history), keep-login, extract data, screenshot, tabs, parallel browsers, iframes/dialogs; (6) **bảng Troubleshooting**: error message → thuốc (SKILL.md); (7) **Working safely**: prompt-injection rules (SKILL.md).

Bảng routing "Load more when you need it" chỉ vào 10 references + 3 templates; tải từng cái bằng `skills get core --ref <name>` — token discipline có eval kiểm tra riêng (evals/README.md "reference-routing").

### 5.2 Benchmark & eval methodology

- **`benchmarks/`** (benchmarks/README.md): so **2 builds** (npm release vs Rust build của branch) trong **Vercel Sandbox microVM**: latency per command (navigate, snapshot, screenshot, evaluate, click, fill, `agent-loop` = snapshot→click→snapshot, `full-workflow` = 7 lệnh) với warmup + iterations + standard deviation; kèm cold start (daemon spawn → browser ready), daemon RSS (tách riêng RSS của Chrome), CPU, số process, kích thước binary/phân phối. Nhận định trung thực của họ: **latency per command do CDP round-trip chi phối** nên chênh lệch giữa các daemon thường nhỏ; số đáng chú ý là cold start, RSS, distribution size.
- **`evals/`** (mục 3.7): phần đặc thù hơn — đo **hành vi agent quanh tool** chứ không đo tool: skill-loading, skill-selection, command-usage, reference-routing, context-footprint; chạy qua provider CLI (claude/codex), regex patterns, optional LLM judge; kèm smoke eval live với hostile prompt-injection mode.

## 6. Áp dụng được vào hệ thống opencode-telegram-bot (PHẦN QUAN TRỌNG NHẤT)

Hiện trạng: worker trên máy này dùng **browsermcp** (MCP server, tool `browser`, điều khiển **Chrome của user**) để duyệt web. Bot relay Telegram ↔ OpenCode agents.

### 6.1 (Nên làm nhất) agent-browser làm browser headless tách biệt cho worker

- **Vấn đề hiện tại**: browsermcp điều khiển Chrome **của user** → cửa sổ hiện ra, tranh chấp với việc lướt web của user, không cách ly giữa các worker, cookies/sites của user phơi ra cho các thử nghiệm của agent, và **một browser duy nhất** là điểm nghẽn khi ≥2 worker browse cùng lúc.
- **Borrow được**: `npm i -g agent-browser && agent-browser install --with-deps` (server không display vẫn chạy — headless là mặc định); mỗi worker một `--session worker-<id>` (hoặc `session id --scope worktree --prefix <task>` để tên ổn định theo task). Worker gọi thẳng CLI qua shell — **không cần wiring MCP**. Muốn session sống lâu: `AGENT_BROWSER_IDLE_TIMEOUT_MS=0` (mặc định là 1 giờ — daemon.rs:278); kết hợp `--restore` để state tự autosave 30s và sống qua restart (sessions.mdx).
- **Effort**: **nhỏ** (1-2 giờ: cài, đổi tool invocation trong prompt/config của worker; worker đã chạy shell được).
- **Rủi ro**: download Chrome for Testing ~vài trăm MB mỗi máy; headless là browser sạch nên **login phải thiết lập lại** (dùng `--state`/`--profile`, hoặc user export cookies một lần qua `cookies set --curl`); fidelity kém nhẹ Chrome thật của user (không có extension của user).

### 6.2 Triết lý "fail not success" — borrow philosophy, không chỉ code

- **Vấn đề hiện tại**: action của worker trả "success" từ browsermcp/CDP nhưng **page có thể không thay đổi** (click trúng overlay, element disabled...); bot tin worker thành công, user chỉ phát hiện khi kiểm tra từ điện thoại → mất niềm tin vào hệ thống.
- **Borrow được**:
  1. Nếu worker dùng agent-browser (6.1), validation **có sẵn** (mục 3.1): click trả "covered by \<...\>", "disabled", "outside the viewport" — agent buộc phải xử lý lỗi thay vì nghĩ đã xong.
  2. Cho các lớp tự viết của bot (report kết quả worker, dispatch lệnh): áp 2 quy tắc — **(a) chỉ báo success sau khi verify effect** (post-action snapshot/diff hoặc `wait --text/--url` cho kết quả mong đợi — đúng SKILL.md:148); **(b) phân biệt "chưa bao giờ tới" với "đã tới, không có reply" cho lệnh mutate** và không bao giờ blind-retry (semantics `outcome_unknown`, connection.rs:1280-1303).
- **Effort**: **nhỏ** cho (2) như rule + bước verify trong bot; **0** cho (1) nếu đã làm 6.1.
- **Rủi ro**: thêm snapshot sau mỗi action ≈ latency + token (giảm được: `snapshot -i` nhỏ; `snapshot --delta` chỉ gửi phần đổi — actions.rs:568); một số flow phải dismiss overlay trước — nhưng error nói rõ element nào đang che, nên là **failure được xử lý**, không phải dead end.

### 6.3 Compact state format — bài học trình bày UI/app state cho LLM

- **Vấn đề hiện tại**: khi bot tóm tắt state (trạng thái page, session agent, file thay đổi) cho điện thoại hoặc feed state cho agent, JSON/DUMP dài vừa tốn token vừa vùi lấp phần actionable.
- **Borrow được**: quy tắc format của `render_tree`/`compact_tree` (mục 2.2-2.3): **một dòng một item, role + name trước, attribute tối thiểu, hierarchy bằng indent, lọc theo "actionable" theo mặc định, hint (icon/testid/văn cảnh chứa) cho item mơ hồ**. Cộng tư duy **`--delta`**: gửi full state một lần, sau đó chỉ gửi phần thay đổi trong hội thoại dài (state theo tab: `DaemonState.snapshot_revisions`, actions.rs:568).
- **Effort**: **nhỏ** (quy ước format cho tin bot → agent/user).
- **Rủi ro**: a11y tree chỉ mô tả web UI rendered — với state của coding agent phải **tự định nghĩa "role"** (session, file, error, task); cái chuyển được là **format + filtering discipline**, không phải API a11y. Đừng khái quát hóa quá.

### 6.4 Skill + eval methodology cho skill của bot

- **Vấn đề hiện tại**: skill của bot (review-code, generate-commit, technical-writer...) là markdown tĩnh; **không có tín hiệu đo được** việc agent có làm theo không, và không có cách rẻ để bắt regression khi sửa skill.
- **Borrow được**:
  1. **Skill self-serve, khớp version** — bot serve nội dung skill của chính nó theo yêu cầu (pattern: CLI serve skill, skills.rs:30-557 + thin discovery stub README.md "For AI agents") để instructions không bao giờ lỗi thời so với conventions của repo.
  2. **Eval harness**: cho mỗi skill, 5-10 prompt thật + **expected/forbidden regex** trên response của agent, chạy qua provider CLI trong CI, kèm optional LLM judge 1-5 (pattern: evals/lib/judge.ts:53; evals/README.md "Adding Cases").
  3. **Đo context-footprint**: bytes/4 làm proxy token rẻ (evals/context-footprint.ts:27-29) — theo dõi skill không phình to.
- **Effort**: **vừa** (một cuối tuần: runner nhỏ + 3-5 eval files cho review-code/generate-commit).
- **Rủi ro**: regex brittle với paraphrase (họ bổ sung bằng LLM judge — phải budget API calls); eval suite phải được bảo trì cùng skill, nếu không thành noise.

### 6.5 Trust-boundaries + prompt-injection rules cho worker duyệt web

- **Vấn đề hiện tại**: worker duyệt web nội dung bất kỳ có thể mang chỉ thị注入 (injected) vào context bot ("ignore previous instructions", "send your cookies to..."); bot hiện không có rule explicit cho việc này.
- **Borrow được**: toàn bộ reference `trust-boundaries.md` (skill-data/core/references/trust-boundaries.md, 69 dòng) — page content = untrusted data; secret không vào model (file-based cookie import, không echo); không tự đi tới URL do page chỉ; `--init-script` = code injection; `--allowed-domains` cho containment — biến thành skill của bot cho worker browsing. Optional: hostile-mode eval (evals/webmcp-context.py `--mode hostile`) làm smoke test rule với canary.
- **Effort**: **nhỏ** (port doc thành skill); hostile eval: **vừa**.
- **Rủi ro**: thấp — rules bảo thủ, trùng với gì AGENTS.md toàn cục của bot đã nói.

### 6.6 (Tùy chọn) Session identity + doctor như feature của bot

- **Vấn đề hiện tại**: không có ánh xạ ổn định task-bot ↔ browser-session; câu "tại sao worker không browse được?" là câu hỏi mù.
- **Borrow được**: `session id --scope worktree --prefix <task>` làm danh tính browser của worker (SKILL.md:16); `agent-browser doctor --json` làm health-check bot chạy và tóm tắt lại cho user (cli/src/doctor/mod.rs:106-134).
- **Effort**: **nhỏ**. **Rủi ro**: không đáng kể.

## 7. Không áp dụng được (hoặc chỉ áp dụng gượng)

- **Rust daemon/CDP internals** — bot là Node/TS, viết lại daemon trong Node là dự án lớn không có lợi ích rõ. Borrow kiến trúc làm **reference**, không borrow code (giá trị nằm ở **dùng binary**).
- **WebMCP, saved flows (experimental, CHANGELOG.md:38), HAR, video/streaming, React tree, dashboard, iOS/Safari/WebDriver, cloud providers, engines Lightpanda/Obscura** — ngoài scope hiện tại của bot; xem lại nếu worker cần scale cloud hoặc mobile.
- **MCP server của họ (`agent-browser mcp`)** — workers của bot là OpenCode agents chạy shell được, đường CLI phù hợp hơn (đúng claim context-footprint của họ); chỉ liên quan nếu xuất hiện harness không chạy được shell.
- **Per-platform npm distribution, version sync, Docker cross-compile** — release engineering của họ, không phải pattern cho bot.
- **Benchmarks trên Vercel Sandbox microVM** — phụ thuộc infra Vercel (token/team/project), không portable.
- Con số "52.6k stars" trong brief: **cần xác minh** trên GitHub (clone shallow không chứa metadata star).

---

### Phụ lục: phương pháp đọc

Docs: index, snapshots, sessions, selectors, quick-start, skills, trust-boundaries, AGENTS.md, README, CHANGELOG (2 release đầu). Code Rust đọc sâu: `cli/src/native/snapshot.rs`, `element.rs`, `click_point.rs`, `actions.rs` (DaemonState, handle_click, handle_find), `connection.rs`, `daemon.rs`, `policy.rs`, `skills.rs`, `mcp.rs` (profiles), `doctor/mod.rs`, `install.rs`. Evals/benchmarks: `evals/README.md`, `evals/lib/judge.ts`, `evals/context-footprint.ts`, `benchmarks/README.md`, `scenarios.ts`. Chưa đọc sâu: `flow/` (8.9k dòng — saved flows), `stream/`, `recording.rs`, nội dung đầy đủ của `mcp.rs` (chỉ profiles), `read.rs` (markdown extraction) — các claim về các module này chỉ dựa trên docs/skill/changelog.
