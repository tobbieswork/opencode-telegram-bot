# Nghiên cứu repo `GoogleChrome/modern-web-guidance-src`

> **Mục đích:** Phân tích mã nguồn (không chạy CLI `npx modern-web-guidance`, chỉ đọc source) để (a) hiểu cách repo tác giả viết/calibration/eval bộ "Agent Skills" đưa kiến thức nền tảng web vào coding agent, và (b) rút ra phương pháp (methodology) áp dụng được cho `opencode-telegram-bot`.
> **Cam kết clone:** `e8feb43` (`--depth 1`, thu 19/11/2026). Mọi claim đều dẫn `file:line` đã đọc thực tế.
> **Lưu ý ngữ cảnh:** Đây là repo **source/authoring** (công cụ viết + calibrate + eval), KHÔNG phải package npm `modern-web-guidance` đã build. Package đã build được tạo bởi `pnpm build` (`package.json:scripts.build` → `src/build/build-guides.ts --target=skills-cli`).

---

## 1. Cấu trúc repo

### 1.1 Package & layout

Repo là **một package npm duy nhất** (`modern-web-guidance-src`, `type: module`, `package.json:2,6`), KHÔNG phải monorepo/pnpm-workspace. Bin nội bộ repo là `gd` → `bin/gd.ts` (`package.json:11`). Điểm thú vị: có **hai CLI khác nhau**

- **CLI phát hành cho user** (`npx modern-web-guidance@latest`): nguồn tại `src/cli/modern-web.ts` (374 dòng), các lệnh `search / list / retrieve / legacy-scan / install / update / set-baseline / set-allow-origin-trials / set-allow-volatile-features / uninstall` (`src/cli/modern-web.ts:66-69,235-290`). Build ra `dist/skills-cli` rồi publish (`src/build/build-dist.ts:172`, ghi `skill-version.txt` + thay `--skill-version SKILL_VERSION` trong SKILL.md, `src/build/build-dist.ts:151-162`).
- **CLI dev nội bộ** (`gd`): `bin/gd.ts`, dispatch bằng `switch` (`bin/gd.ts:265`), nhóm lệnh `dev / pr / dev-gap` (authoring+eval), `legacy-scan`, `eval / run / dashboard / upload / backfill / compare`, `baselinestatus / setup-completion` (`bin/gd.ts:197-209`).

Các thư mục nguồn chính (`docs/CONTEXT.md:27-58`):

| Thư mục | Vai trò |
|---|---|
| `guides/` | Nội dung guide (262 web features), mỗi guide 1 thư mục |
| `skills-src/` | Source của skill standalone (vd `chrome-extensions`) |
| `features/` | Feature definition + snippet dùng cho transclusion macro |
| `src/rag/` | Semantic search + embedding + vector store (retrieval) |
| `src/analyzing/` | `legacy-scan` (scanners + rules + eval) |
| `src/harness/` | Eval harness: agent runners, base-apps, nightly |
| `src/grading/` | Playwright grading engine + grader generation |
| `src/authoring/` | Pipeline `gd dev` (Stage 3) |
| `src/build/` | Build + release + collect-eval-results + eval-regression |
| `src/core/` | Paths, config, guide validation, macros, baseline, feature-gates |
| `src/cli/` | CLI phát hành + telemetry |
| `src/dashboard/` | Dashboard eval + search quality |
| `bin/gd.ts` | CLI entry nội bộ |

**Kịch bản chính** (`package.json:scripts`): `suite`/`task` → `src/harness/run-suite.ts`, `report` → `src/harness/evaluate.ts`, `grade` → `src/grading/run-grader.ts`, `dev-guide` → `src/authoring/dev.ts`, `benchmark:rag` → `src/rag/benchmarks/bench-rag.ts`, `generate-grader` → `src/grading/generate-grader.ts`.

**Dependencies đánh dấu kiến trúc** (`package.json:dependencies`): `@huggingface/transformers` + `onnxruntime-node` (embedding cục bộ), `@11ty/gray-matter` (frontmatter YAML), `@mdn/browser-compat-data` + `caniuse-lite` + `mdn-data` + `web-features` (dữ liệu browser-support cho baseline), `ts-morph` (AST JS/TS), `linkedom` (DOM), `cssomnom` (CSS), `marked` (parse markdown cho chunking).

### 1.2 Định dạng nội dung guide (schema)

Nguyên tắc nền tảng (ghi rõ ở `AGENTS.md:5-6` và `.agents/skills/project-guides/SKILL.md:14-33`): **`guide.md` là file DUY NHẤT mà coding agent thực tế đọc được lúc runtime**. Mọi file khác (`demo.html`, `expectations.md`, `targets/`) chỉ dùng trong repo để validate/eval.

Một guide nằm tại `guides/<category>/<slug>/` chứa (`docs/CONTEXT.md:60-78`, `project-guides/SKILL.md:18-27`):

| File | Tác giả | Mục đích |
|---|---|---|
| `guide.md` | SME (người) | Hướng dẫn, agent đọc qua Skills. Có frontmatter + macro build-time |
| `demo.html` | SME | Implement tham chiếu chạy được (validate Stage 2) |
| `expectations.md` | SME | Danh sách bullet kiểm tra quan sát được → input cho grader |
| `targets/<base_app>/patches/*-solution.patch` | Generated (`gd dev`) | Golden multi-agent (claude/codex/antigravity) + `zero-passrate.patch` |
| `targets/<base_app>/grader.ts` | Generated | Playwright grader, calibrate golden=100%/zero-passrate=0% |
| `targets/<base_app>/task.md` | Generated | 1 bullet prompt developer, tailored theo base app |
| `results/.../report.md` | Generated | Báo cáo eval + khuyến nghị |

**Frontmatter schema** (`project-guides/SKILL.md:35-63`):
```yaml
---
name: slugified-use-case-name
description: <do thing> <with feature>
web-feature-ids:
  - webstatus-feature-id   # lấy từ webstatus.dev, BẮT BUỘC đủ mọi feature dùng trong body
draft: stub|wip|blocked    # (optional) withhold khỏi distribution
---
```
Ví dụ thực tế `guides/css/responsive-design/guide.md:1-10`: `name: responsive-design`, `web-feature-ids: [container-queries, viewport-unit-variants, aspect-ratio, min-max-clamp, viewport-units]`, kèm comment `{# ... #}` cho maintainer (bị `stripComments()` bỏ khi build — `src/core/macro-parsing.ts:76`).

**Macro build-time** (`project-guides/SKILL.md:150-165`): `{{ BASELINE_STATUS("feature-id") }}` (xuất dòng trạng thái Baseline động từ BCD), `{{ INCLUDE("path#sec") }}`, `{{ FEATURE("id","sec") }}`, `{{ FEATURE_FALLBACKS("id") }}`, `{{ FEATURE_ISSUES("id") }}`, `{{ GUIDE_REF("slug") }}`. Parse trong `src/core/macro-parsing.ts` (`getMacroFeatureId:153`). **Không được hard-code** browser version/hỗ trợ — luôn render động qua macro.

**"Discipline guides"**: hub định hướng cho cả category (vd `css`, `html`, `performance`, `forms`, `accessibility`), hoặc guide tên đăng ký trong `DISCIPLINE_GUIDES` (`src/core/guide-validation.ts:37`, 25 guide). Được miễn frontmatter `description`/`web-feature-ids` (`project-guides`, `docs/CONTEXT.md:79`).

**2 thế hệ eval format** (`docs/CONTEXT.md:81-86`): **Gen 1** = 1 `grader.ts` gốc + `tasks/task.md` (1 base app, thường `daily-grind`); **Gen 2** = `targets/<base_app>/` riêng (dual-target). VD Gen 1: `guides/performance/identify-inp-causes/` có `grader.ts` + `tasks/task.md` (frontmatter `base_app: daily-grind` + 1 bullet, `tasks/task.md:1-4`); grader Gen 1 này dùng static regex/string trên file (`grader.ts:17-90`).

### 1.3 Các lệnh CLI hoạt động thế nào

- **`search "<query>"`** (`src/cli/modern-web.ts:125-156`): import `searchUseCases` (`src/rag/search.ts:105`), trả về **compact JSON array** chỉ `{id, description}` mỗi dòng để tối thiểu token (`src/cli/modern-web.ts:145-148`); nếu query non-English và ≤1 token → warn "Search queries must be in English" (`src/cli/modern-web.ts:150-152`).
- **`list`** (`src/cli/modern-web.ts:159-166`): in toàn bộ `USE_CASES` dạng compact `{id, description}`.
- **`retrieve "<ids>"`** (`src/cli/modern-web.ts:171-234` → `src/rag/retrieve.ts:110`): gọi `retrieveUseCase(id)`, join nhiều guide, có cơ chế **spill ra `/tmp`** khi output >9.5KB (chi tiết §3.4). Trước khi trả guide, kiểm tra **feature gate** (origin-trial/volatile) và prepend **baseline banner** theo `.mwgrc` (`src/rag/retrieve.ts:32,120-150`).
- **`legacy-scan [path]`** (`src/cli/modern-web.ts:94` → `src/analyzing/cli.ts`): scan tĩnh + rubric (chi tiết §4).
- **`install` / `update`** (`src/cli/modern-web.ts:235,261`): cài/ nâng skill vào agent (hỗ trợ `--choose` để chọn skill pack).
- **`set-allow-origin-trials` / `set-allow-volatile-features`** (`src/cli/modern-web.ts:284,287`): ghi flag vào `.mwgrc`.

---

## 2. Calibration / Eval pipeline (phần quan trọng nhất)

README:49 nêu thẳng triết lý: *"guides are designed to be token-efficient; we run evals enabling us to prune lowest-common-denominator content that models already know."* Mục này giải thích **đúng cách** điều đó được thực hiện.

### 2.1 Pipeline 3 giai đoạn (Stage 1 → 2 → 3)

`AGENTS.md:12-22` định nghĩa các skill bắt buộc. Ba giai đoạn (`project-evals/SKILL.md:10-14`, `project-guides/SKILL.md:7`):

1. **Stage 1 — Xác định use case** (skill `project-use-cases`): viết frontmatter stub của `guide.md` cho mỗi use case của một web feature.
2. **Stage 2 — Authoring** (skill `project-guides`): viết `guide.md` + `demo.html` + `expectations.md`.
3. **Stage 3 — Eval** (skill `project-evals`): viết `expectations.md`, `targets/<app>/task.md`, `grader.ts`.

`docs/CONTEXT.md:60-78` ghi rõ: **SME sở hữu Stage 1 & 2** (frontmatter stub, guide body, demo.html, expectations); **AI sở hữu Stage 3** (gen grader + task.md + golden patches + chạy eval + report.md). `docs/CONTEXT.md:37`: *"No AI-authored changes to guide body without SME approval"* — ranh giới người/máy rất rõ.

### 2.2 "Tone" của guide = chỉ dạy phần sai lệch so với training data

Đây là chìa khóa của "token-efficient". `project-guides/SKILL.md:70-83` (tóm tắt) + `docs/CONTEXT.md:90` (Key Architectural Decision #1):

> "Do NOT teach what models already know. Do NOT explain what is already obvious. Only teach the course-correction delta — what a modern web platform means for how we do things."

Cụ thể: **KHÔNG** định nghĩa lại `<dialog>`, `container query`, `flexbox`; **KHÔNG** giải thích why; **KHÔNG** giải thích fallback là gì. **CHỈ** dạy pattern mới/delta (vd "use `@starting-style` + `transition-behavior: allow-discrete` to fade in `<dialog>`"). Kết quả: guide nhỏ, và **chỉ giữ lại phần model chưa biết** — chính là nội dung được "prune" qua eval (§2.5).

`demo.html` được sinh **chỉ từ `guide.md`** (không thấy expectations), chứng minh guide tự-hàm-thu, có thể làm theo độc lập (`project-guides/SKILL.md` demo rules).

### 2.3 Calibration loop: golden (100%) + zero-passrate (0%)

Đây là "vòng lặp tự-h愈 (self-healing)" của grader. `project-evals/SKILL.md` (bảng artifact) + `src/harness/README.md:31-39` (5 bước `gd dev`):

**5 bước `gd dev`** (`src/harness/README.md:31-39`):
1. **Solutions Generation**: sinh **3 golden solution patches** (mỗi "gia đình" agent 1: `claude`, `codex`, `antigravity`/`jetski`) + **1 zero-passrate patch** (baseline chằng-chịt = app khởi đầu chưa sửa).
2. **Grader Generation**: sinh `grader.ts` (Playwright checks) từ `expectations.md`, do **CLI agent chạy** (chưa phải tay) — `src/grading/generate-grader.ts:26,131` copy `template.grader.ts` + `playwright-pattern-library.grader.ts` vào workspace rồi gọi `activeAgents` để viết grader.
3. **Grader Calibration**: **đảm bảo golden pass 100% VÀ zero-passrate fail 100%** (0% trên checks không-exempt). Đây là invariant calibrate.
4. **Agent Evaluations**: chạy trial guided + unguided đo pass rate & usage.
5. **Evaluation Report** (`report.md`): gọi một "evaluator agent" phân tích check fail, xuất khuyến nghị.

Invariant quan trọng (`project-evals/SKILL.md` red line #8 + `src/grading/run-grader.ts`):
- Golden solution phải **100%**, untouched baseline phải **0%** (trên non-exempt checks).
- **"Never change a guide to fit its grader"** — nếu grader cần guide nói thêm gì đó, sửa grader, không sửa guide.
- **Anti-overfitting** (`project-evals/SKILL.md` §2): KHÔNG hard-code identifier của golden patch (tên hàm/state/file); phải unwrap `AsExpression`/`SatisfiesExpression`, follow biến, trace qua helper. Vì golden chỉ là "một implementation hợp lệ", không phải "spec đầy đủ".
- **No vacuous checks / no swallowed errors** (§3): 1 expectation = 1 `test()`; cấm `if (items.length > 0)` guard rỗng; MUST NOT check phải ghép với positive presence check; cấm `test.skip()`/`try/catch` nuốt lỗi.
- **Fallback-scoped tests** dùng `skipUnless({ unsupported: '<feature>' })` (import từ `test-fixture.ts`) để harness tự chạy thêm biến thể `newly`/`limited` cho feature chưa có sẵn.

Tóm lại: grader **không viết tay rồi tune** mà **sinh bằng agent rồi calibrate đối xứng** (trên = golden 100%, dưới = baseline 0%). Nếu golden fail check → regen golden; nếu check sai → sửa check. Điều này làm eval **tự kiểm chứng (self-verifying)** thay vì tin vào con số người đặt.

### 2.4 E2E: Guided vs Unguided → Opportunity & Uplift

Lexicon chuẩn (`docs/LEXICON.md`):
- **Condition**: `guided` (agent có skills + retrieval) vs `unguided` (control, không có guidance).
- **Trial** = 1 lần chạy 1 task dưới 1 condition. **Job** = 1 batch chạy nhiều task × conditions × repetitions.
- **Grader** = Playwright test file; **Check** = 1 assertion; pass rate = checks pass / checks run (trên paired tasks hợp lệ).
- **Infra Error** (agent crash, timeout, rate-limit, grader crash) → **loại khỏi mẫu số** (`src/harness/lib/metrics.ts:101,138-143` `isEarlyFailureRun`), vẽ thành uncertainty band.
- **Unguided Leak**: trial unguided mà vẫn đọc/đúng guide → flag nhiễm (không phải fail) — `src/harness/lib/collection.ts:367` `hasTrajectoryGuideLeak`.

Chỉ số (`README:584-604`, `docs/LEXICON.md`):
- **Opportunity = 100% − unguided pass rate** → "việc còn lại cho guidance phải làm".
- **Uplift (pp) = guided − unguided pass rate** (đơn vị *percentage points*, KHÔNG phải relative %).
- Snapshot README:616: `"pass-rate": "unguided 57% → guided 90% (+33.3%)"`, `"uplift-pp": 33.3` (dùng **median** pass rate).

Tính toán (`src/harness/lib/metrics.ts:105` `calculateMetrics`): per task, bỏ early-failure, tính **median pass rate** (không mean — kháng outlier), theo dõi `runsUsingGuide` (agent có thật sự retrieve đúng guide không, `metrics.ts:166-172`) và token usage (total + cached). **Median** thay mean là một lựa chọn có chủ đích để chống outlier.

### 2.5 Pruning: dùng Opportunity để "cắt nội dung model đã biết"

Đây chính là mechanism của câu "token-efficient" ở README:49. Logic:
- Chạy **unguided** (không guidance) trên task. Nếu unguided đã pass cao → **Opportunity thấp** → guide đó đang dạy thứ model đã biết → **thư sinh / rút** (prune) phần đó.
- Nếu **Uplift cao** (guided >> unguided) → guide thật sự tạo giá trị → **giữ**.
- Ngược lại, nếu guide dài nhưng uplift ~0 → nội dung thừa (lowest-common-denominator), cắt.

Vì `guide.md` là "course-correction delta" duy nhất (chỉ dạy phần sai lệch), và eval đo được phần nào trong guide thật sự dịch chuyển pass rate, nên đội **dùng số uplift để quyết giữ/cắt từng phần guide**. Kết hợp với "token-efficient" (guide gốc đã nhỏ), đây là **vòng lặp empirical curation** — không ai vote "guide X hay", mà **số uplift quyết định**.

### 2.6 Regression guard (ngăn thoái hóa khi đổi model/prompt)

Hai lớp:
1. **Per-release regression test** — `src/build/collect-eval-results.ts:142-171`: thu `public-evals/suites.gen.json` (từ `origin/gh-pages`) rồi chạy `src/build/eval-regression.test.ts`. Test này **fail nếu guided pass rate của một agent GIẢM > 5%** so với tag trước (`src/build/eval-regression.test.ts:75`: *"guided pass rate dropped by {drop}% ... exceeds the 5% threshold"*). Nó so sánh `eval-results-summary.json` của previous tag với current (`collect-eval-results.ts:8`, `eval-regression.test.ts:40,64`).
2. **Nightly cron** — `src/harness/nightly/`: `setup-cron.sh` (mặc định `0 2 * * *`), chạy 3 agent (`antigravity_cli, claude_code, codex_cli`), trên branch `nightly-*` tách từ `origin/main`, **fail-fast nếu có uncommitted change** (`nightly/README.md`), upload dashboard + `pnpm public:publish` mirror ra public (gh-pages), email `sendgmr`. Vì chạy hàng đêm, sự thay đổi pass rate (do model update, prompt đổi, grader đổi) hiện lên liên tục, không chỉ lúc release.

`dev-prompt-canary` + `grader-replay` + `nightly-eval-investigation` (`.agents/skills/`) là công cụ chẩn đoán khi nightly fail: replay solution đã lưu, kiểm tra check flip, triage pass rate & retrieval flags.

### 2.7 Sandbox + Trajectory: chống nhiễm (contamination)

Điều làm baseline **đáng tin**: agent chạy **bên trong filesystem sandbox che toàn bộ repo** (`src/harness/README.md:338`, `docs/CONTEXT.md` Key Decision): Linux dùng `bwrap` (mount tmpfs che repo root), macOS dùng `sandbox-exec`. Chỉ re-expose `node_modules` (read-only) và `dist/skills-cli` (guided). Nếu không có sandbox tool → **fail loudly** (cấm bỏ qua trừ debug). Mục đích: agent unguided **không thể `find /` đọc `guides/` hay `expectations.md`/`grader.ts`** → số "unguided" thật sự là năng lực mô hình, không phải leakage.

**Trajectory** (`src/harness/README.md:275-296`, `docs/LEXICON.md`): mỗi agent (Pi/Claude/Codex/Jetski/Antigravity) có format session log khác nhau (JSONL/JSON/TOML+JSONL/SQLite); harness chuẩn hóa về 1 `trajectory_summary.json` (`src/harness/lib/trajectory-normalizer.ts`), từ đó `src/harness/lib/guide-usage.ts` trích: tool call `get_best_practices`, `read_file` các `/skills/` hay `guide.md`, shell `--retrieve` → biết agent guided **có thật sự dùng guide** (feed `runsUsingGuide`) và phát hiện **unguided leak**. Mỗi trial có **isolated HOME** (`/tmp/ghh-*`, `agent-shared.ts`) chống nhiễm cross-run + auth leak.

> **Nhận xét:** Toàn bộ pipeline là một hệ "measure-then-trust": (1) grader tự calibrate (2.3), (2) số opportunity/uplift quyết curation (2.4–2.5), (3) regression guard + nightly giữ chất theo thời gian (2.6), (4) sandbox + trajectory đảm bảo số đo không bị nhiễm (2.7). Đây là phần đáng giá nhất để borrow.

---

## 3. Retrieval mechanics (cách search/retrieve chọn guide)

`src/rag/README.md` + `src/rag/search.ts` + `src/rag/bm25.ts` + `src/rag/retrieve.ts`.

### 3.1 Hybrid: dense (static quantized) + BM25 + RRF

`searchUseCases(query, limit=10, minSimilarity=0.3, embedder?)` (`src/rag/search.ts:105-172`) chạy:
1. Embed query bằng **`StaticEmbedder`** (`src/rag/static-embedder.ts`), KHÔNG gọi API (~30µs).
2. Build corpus (cache): mỗi guide → chunk, index BM25 trên `${description}\n\n${chunkContent}` (`search.ts:118`).
3. **Dense**: max-pooled best-chunk cosine per guide (`search.ts:122-130`), sort giảm.
4. **BM25**: `rankBm25` (`bm25.ts:81`), Okapi BM25 `k1=1.2, b=0.75` (`bm25.ts:11-12`), tokenizer `EnglishMinimalStemmer` (S-Stemmer, `bm25.ts:26`).
5. **Fusion**: **Reciprocal Rank Fusion** `k=60` (`bm25.ts:13,109` `reciprocalRankFusion`) gộp hai danh sách rank.
6. Output: `slice(0, limit)` trả `{id, description, category, featuresUsed, tokenCount, similarity}` (`search.ts:146-159`).

**Vì sao asymmetric** (`src/rag/README.md` "Symmetric Cone Collapse"): cộng 3 từ query trong 256-d vẫn sắc (pairwise cosine ≈0.28); nhưng **trung bình ~300 từ của 1 chunk markdown** kéo mọi document vector về "centroid tần suất tiếng Anh" → **sụp thành nón cosine 0.970**. Trong thử nghiệm, query `"best pizza in new york"` ghi cosine **0.899** với guide `<dialog>` — vô dụng. Khắc phục: query dùng vector **static** (bag-of-words, 3 từ) ghép **asymmetric** với document vector **full-transformer** `gemini-embedding-001` (build-time). Query ~30µs, doc được bake sẵn.

### 3.2 Static embedder = "token-efficient" về mặt hạ tầng

`StaticEmbedder` (`src/rag/static-embedder.ts:85-157`) thay thế runtime TF.js `all-MiniLM-L6-v2` **23.4MB** bằng **lookup table Int8** (~30µs/word) (`src/rag/README.md` đầu). Cơ chế: mỗi query word → 1 hàng vector 256-d trong `gen/query-words.i8` (Int8 quantized, 29,165 từ); `embedSync` = **tổng có trọng số các hàng** rồi L2-normalize (`static-embedder.ts:55-71` `accumulateNormalizedVector`, `149-157`). Bảng này được **distill** từ `gemini-embedding-001` (RETRIEVAL_QUERY, 768-d → MRL 256-d) bằng **Model2Vec + Tokenlearn** (`src/rag/README.md` "Vocabulary & Model Retraining"), fit 12 epoch Adagrad trên corpus IDF, **loại bỏ** các query benchmark (chống leakage).

**Chunk header enrichment** (`#3172`, `src/rag/README.md` + `src/core/guide-chunks.ts:123` `formatChunkHeader`): mỗi chunk được prepend **title + category + web-feature id (raw + unslugged)** → đảm bảo BM25 **recall cao trên identifier web chính xác** (vd `field-sizing`, `@starting-style`). Chunking = tách theo heading (`guide-chunks.ts:91` `chunkMarkdown`), hash `SHA256(teacher+task+dims+text)` để cache vector (`guide-chunks.ts:14`).

### 3.3 Floor gate + compact K=10 + token budget (bảo vệ context window)

Ba lớp bảo vệ **context window của agent** (`src/rag/README.md`, `src/cli/modern-web.ts`):

1. **BM25-aware dense floor gate** (`src/rag/README.md`, `search.ts:134-138`): chỉ enforce floor cosine `0.30` (`DEFAULT_MIN_SIMILARITY`, `search.ts:49`) **khi BM25 KHÔNG có hit**. Nếu BM25 khớp keyword thì giữ cả dense-candidate dưới floor (rescue); nếu BM25 rỗng VÀ dense top-1 < 0.30 → **trả `[]`** để từ chối sạch query ngoài phạm vi (không nhét guide rác vào context).
2. **Compact K=10 output** (`#3048`, `src/rag/README.md`): trả **10 entry `{id, description}`** ~**53 tokens/kết quả** thay vì 5 entry ~105 tokens/kết quả → **2× coverage** trong cùng **~530-token stdout budget** (+7.4pp Hit@K). CLI in JSON lines compact (`src/cli/modern-web.ts:145-148`), và mỗi guide còn có `tokenCount` để agent biết kích thước trước khi retrieve.
3. **Automatic `/tmp` spilling** (`#3191`, `src/cli/modern-web.ts:23` `MAX_INLINE_STDOUT_BYTES = 9500`): harness agent (Claude Code, Codex) **truncation giữa message tool output > ~10KB** và agent hiếm khi tự redirect. Nên `retrieve` tự **viết ra `/tmp/mwg-guide-<pid>-<ts>.md`** khi output >9.5KB (non-file pipe) + in 2 dòng chỉ dẫn; guide <9.5KB (76.6% guide) và redirect `>` thì stream inline. (Chi tiết `src/cli/modern-web.ts:37-59` `saveRetrievedGuides`, `isStdoutRedirectedToFile`.)

**Token budget tổng:** agent chỉ tốn ~205 tokens cho SKILL (`README:635`) + ~530 tokens cho search result + guide khi cần (spill nếu lớn). Đây là **context window protection by design**, không phải may rủi.

### 3.4 Feature gates + baseline banner (tương tác khi retrieve)

Trước khi trả guide, `retrieveUseCase` (`src/rag/retrieve.ts:110-150`):
- **Origin Trial / Volatile gates** (`src/core/feature-gates.ts:23-61`): guide chứa feature origin-trial/volatile thì **phải** `.mwgrc` opt-in (`allowOriginTrials`/`allowVolatileFeatures`) — khác là **throw `FeatureGateError`** kèm CAUTION message: *"Never bypass this gate (do not run set-allow-… yourself, edit .mwgrc, or read raw .md) … Ask the user if they want to opt in."* → agent **tìm thấy** guide qua search (discoverable) nhưng **không dùng** nếu chưa opt-in.
- **Baseline banner** (`src/rag/retrieve.ts:32` `formatBaselineTargetBanner`): đọc `.mwgrc.baseline` (widely/newly/limited/date) rồi prepend `> [!IMPORTANT]` lệnh agent **bỏ/skip fallback** theo mức (vd `limited` → "Skip the ## Fallback strategies section"). Baseline state lấy từ BCD/caniuse (`src/core/baseline.ts:8,45,94`).

---

## 4. legacy-scan (deterministic scan cho legacy patterns)

`src/analyzing/README.md` + `src/analyzing/cli.ts` + `src/analyzing/rules/` + `src/analyzing/eval/`. Đây là **"deterministic pre-step + LLM" hybrid**: máy quét tĩnh chạy nhanh, sau đó agent/LLM verify theo rubric.

### 4.1 Kiến trúc: Static Matcher + Verification Rubric

Flow (`src/analyzing/README.md` §3, mermaid):
```
Source → Static Matcher (AST+token, zero LLM) → Candidate Findings + verifierRubric(keepWhen/dropWhen)
       → Contextual Verification (Coding Agent ở runtime / LLM Verifier ở eval)
       → Kept | Dropped (false positive)
```

**Static Matcher** (recall cao, **zero LLM, zero network** lúc runtime):
- **`fastTokens` pre-filter**: scan chuỗi rẻ trước khi parse → file không khớp rule **không bao giờ được parse** (tốc độ).
- **Multi-modal**: `ts-morph` (JS/TS AST), `linkedom` (HTML + SFC, JSX qua TS AST), `cssomnom` (CSS), + **dependency** scanner (`package.json` + file vendored).
- **Finding ID ổn định**: `CardID = SHA256(repo:commit:guideId:file:line)[0..12]` (12 hex) → theo dõi ổn định qua các run/eval.

**`AnalyzerRule` interface** (`src/analyzing/schema.ts:170`, ví dụ `src/analyzing/README.md` §4): `{ id, guideId, guideHash, summary, matcher, verifierRubric }`. 4 loại matcher: `JsRuleMatcher`(kind js), `DomRuleMatcher`(dom), `CssRuleMatcher`(css), `DependencyRuleMatcher`(dependency). VD rule thực: `src/analyzing/rules/autofill-sign-in-form.ts` (VD trong README: `fastTokens: ['type="password"']`, matchElement trả message + `verifierRubric.keepWhen/dropWhen`).

### 4.2 Định nghĩa pattern + rubric keep/drop

Mỗi finding mang theo **`verifierRubric`** (`keepWhen`/`dropWhen`) — được **emit trực tiếp trong `--json`** cho coding agent verify khi modernize (`src/analyzing/README.md` §3, JSON example). VD rule `form-fields-automatically-fit-contents`:
- keepWhen: *"keyup/input listener recalculates scrollHeight…"*
- dropWhen: *"guarded by CSS.supports('field-sizing','content')"*, *"non-DOM context"*…

`dropWhen` là chìa khóa chống false positive: code đã guard bằng feature-detection, biến bị shadow trong scope khác (vd `dialog` trong audio engine), out-of-domain (WebGL canvas, Node CLI).

### 4.3 Kết quả feed vào agent (~20% corpus)

CLI human-readable + `--json` (`src/analyzing/cli.ts:187,200,392-393`): *"scanned {N} guides with deterministic rules; **~20% of the guidance corpus**"*. Ý: chỉ **~20% guide** có deterministic legacy pattern đủ tin cậy để ship; phần còn lại (visual/behavioral/greenfield) không có "footprint" để scan — agent dùng `search <topic>` cho phần đó (README + `src/analyzing/cli.ts:187`).

**Workflow Modernize** 5 bước (`src/analyzing/README.md` §2): (1) `legacy-scan --json` detect → (2) **verify theo rubric, drop false positive**, report → (3) `retrieve <guideId>` khi cần modernize → (4) modernize + **re-run `legacy-scan`** xác nhận finding biến mất → (5) disclose + tóm tắt Baseline. Điểm then: **scan dừng ở detect**, agent tự carry planning/apply/verify.

### 4.4 Qualification + 2-axis triage + detection eval (offline)

**Chỉ ship rule đã "qualified"** (`src/analyzing/rules/index.ts:42-98`): `RULE_MODULES` (37 module rule) → `QUALIFIED_RULES = RULE_MODULES.flat()` (`index.ts:82`), `QUALIFIED_GUIDE_IDS` (`index.ts:93`). Comment ở `index.ts:76-81` nêu criterion.

**Qualification criteria** (`src/analyzing/README.md` §4): score trên **`held-out` findings** bằng **multi-judge panel**:
- **Standard bar**: Post-Verifier Precision **≥ 90%** AND Static Matcher Precision **≥ 80%** với **n ≥ 10**.
- **Rare-pattern bar**: Post-Verifier Precision **≥ 90%** AND Static Matcher Precision **≥ 90%** với **n ≥ 5**.
- Chưa đạt → ở tier "experimental" trước khi ship.

**2-split corpus** (`src/analyzing/README.md` §5): `rule-writing` (để phát hiện pattern/viết rule — **được phép** nhìn) vs `held-out` (out-of-sample, **tuyệt đối cấm** nhìn khi viết/debug rule). Có internal audit verify boundary.

**Detection eval** (`src/analyzing/eval/detection-eval.ts`): LLM judge (`gemini-3.8-flash`) đánh giá human-graded cards với **majority voting** (7 canonical verdicts, `detection-eval.ts:112,176` `verdictsAgree`). **Statistics** (`src/analyzing/eval/stats.ts`): **Wilson binomial interval** (`stats.ts:28`, `Z_95=1.96` `stats.ts:2`), **sequential stopping** (`stats.ts:55`, `Z=2.39`, 15–60 grades `stats.ts:5-6`), TPR/TNR (`sensitivitySpecificity:138`), + inter-rater **Krippendorff's α / Gwet's Ac1** (`stats.ts:96,118`).

**2-axis triage** (`src/analyzing/README.md` §4): mỗi guide được classify trên:
- **Axis 1 — Detection**: `direct-token` / `structural-ast` (deterministic, no LLM runtime) vs `needs-verifier` (cần LLM verify theo rubric) vs `no-legacy-pattern`.
- **Axis 2 — Update Scope**: `local-swap` vs `cross-layer-refactor` (xóa JS imperative, chuyển sang CSS/HTML declarative) vs `widget-recipe` (đ协调 HTML+CSS+JS) vs `n/a`.

> **Nhận xét:** legacy-scan là mẫu "deterministic-first, LLM-second" chuẩn mực: máy quét chỉ **giật** (high recall) + **rubric keep/drop** đưa cho LLM/agent quyết **đúng/sai**, và chỉ ship thứ đã đạt **precision threshold trên held-out** với **thống kê (Wilson + sequential stopping + multi-judge voting)**. Đây là pattern borrow mạnh nhất cho `review-code`.

---

## 5. 10 điểm hay nhất (xếp hạng)

Xếp theo "giá trị methodology có thể transfer", kèm lý do + bằng chứng `file:line`.

**1. Calibration loop tự-h愈: golden 100% / zero-passrate 0% (self-verifying grader).**
Thay vì tin con số người đặt, grader được **calibrate đối xứng**: 3 golden solution (đa-agent) phải pass 100%, app chưa-sửa phải fail 100% trên non-exempt checks; golden fail → regen golden, check sai → sửa check, **không bao giờ sửa guide cho vừa grader**. Kết quả: mỗi guide tự "chứng minh" grader của nó đúng, loại bỏ lỗi "check vô nghĩa/pass tautology". Bằng chứng: `project-evals/SKILL.md` (red line #8, bảng artifact, anti-overfitting), `src/harness/README.md:31-39` (5 bước), `src/grading/run-grader.ts`.

**2. Opportunity + Uplift là tín hiệu curation ("token-efficient" engine).**
Không ai vote "guide X hay" — **số uplift (guided − unguided, pp) quyết định giữ/cắt**: unguided cao = model đã biết = prune; uplift cao = giữ. Đo trên task thật, median (kháng outlier), loại infra-error khỏi mẫu số, phát hiện unguided-leak. Đây là "measure-then-trust" thuần túy cho content curation. Bằng chứng: `README:584-625`, `docs/LEXICON.md` (Uplift/Opportunity/Infra Error/Unguided Leak), `src/harness/lib/metrics.ts:105`.

**3. "guide.md = course-correction delta" (tôn chỉ authoring token-economy).**
Nguyên tắc authoring: KHÔNG dạy lại thứ model đã biết, KHÔNG giải thích why, CHỈ dạy pattern mới; guide phải **self-contained + deterministic + command-oriented**; `demo.html` sinh chỉ từ `guide.md`. Tôn chỉ này là "nguồn gốc" của nhỏ gọn — eval (§2.5) chỉ xác nhận/cắt. Bằng chứng: `project-guides/SKILL.md:70-83` + `docs/CONTEXT.md:90`, `AGENTS.md:5-6`.

**4. Asymmetric static embedding đánh bại "symmetric cone collapse".**
Chẩn đoán sắc: trung bình ~300 từ/chunk sụp về centroid tần suất (cone cosine 0.970, "best pizza" ghi 0.899 vs `<dialog>`). Khắc phục bằng query vector static 3-từ ghép asymmetric với doc vector full-transformer; `StaticEmbedder` Int8 lookup ~30µs thay 23.4MB runtime, distill bằng Model2Vec+Tokenlearn, loại query benchmark chống leakage. Một bài "retrieval engineering" có chiều sâu thật. Bằng chứng: `src/rag/README.md` (Cone Collapse, tables, retraining), `src/rag/static-embedder.ts:85-157`.

**5. Multi-layer context-window protection (RRF + BM25 floor gate + compact K=10 + /tmp spill).**
Bốn lớp che context: (a) RRF k=60 gộp dense+BM25; (b) floor cosine 0.30 **chỉ khi BM25 rỗng** → trả `[]` cho query ngoài phạm vi (không nhét guide rác); (c) compact K=10 ~53 tokens/kết quả (~530-token budget, +7.4pp Hit@K); (d) tự spill `/tmp` khi >9.5KB vì harness truncate giữa message. Mỗi lớp đều có số đo + số liệu. Bằng chứng: `src/rag/search.ts:105-172`, `src/rag/bm25.ts:13,109`, `src/rag/README.md`, `src/cli/modern-web.ts:23,145-148`.

**6. Deterministic Static Matcher + LLM-verifier hybrid, gated bằng precision (legacy-scan).**
Máy quét zero-LLM chỉ "giật" (fastTokens pre-filter + AST) + **rubric keep/drop** cho LLM/agent verify; chỉ ship rule đạt **Post-Verifier Precision ≥90%** trên **held-out** (Wilson interval + sequential stopping + multi-judge voting), 2-split `rule-writing`/`held-out` chống overfit. "Dét định trước, suy luận sau" là pattern đúng đắn cho LLM review. Bằng chứng: `src/analyzing/README.md` §3-5, `src/analyzing/rules/index.ts:42-98`, `src/analyzing/eval/stats.ts`.

**7. Filesystem sandbox che repo → baseline không nhiễm (contamination-free).**
Eval agent chạy trong `bwrap`/`sandbox-exec` **che toàn bộ repo**, chỉ re-expose `node_modules`+`dist/skills-cli`; thiếu sandbox → fail loudly. Đảm bảo số "unguided" là năng lực mô hình thật, không phải agent `find /` đọc `guides/`. Kèm isolated HOME + trajectory chuẩn hóa để track guide-usage + leak. Bằng chứng: `src/harness/README.md:338` (Filesystem Sandbox), `docs/CONTEXT.md` Key Decisions, `src/harness/lib/guide-usage.ts`, `collection.ts:367`.

**8. Origin-Trial / Volatile feature gates + `.mwgrc` (governance cho API chưa ổn).**
Cơ chế "discoverable nhưng gated": agent **tìm thấy** guide qua search, nhưng `retrieve` **throw** nếu feature origin-trial/volatile chưa opt-in qua `.mwgrc`; message CAUTION cấm bypass + yêu cầu hỏi user; baseline banner theo `.mwgrc.baseline` tự lệnh bỏ fallback. Chuyển "rủi ro API chưa ổn" thành chính sách cấu hình rõ. Bằng chứng: `src/core/feature-gates.ts:23-61`, `src/rag/retrieve.ts:32,110-150`, `README:466-473` (.mwgrc).

**9. Baseline-aware content bằng build-time macro (không hard-code support).**
`{{ BASELINE_STATUS }}`/`{{ FEATURE_FALLBACKS }}` render **động** từ BCD/caniuse lúc build → guide không bao giờ nói sai browser support; affirmatively **reassure** trên feature newly/widely (nhiều guide thừa cảnh báo fallback). `web-feature-ids` bắt buộc đủ + CI cross-check chống drift. Bằng chứng: `project-guides/SKILL.md` (macron table, Baseline-aware), `src/core/baseline.ts:8,45,94`, `src/core/macro-parsing.ts:76,153`.

**10. Structural context isolation (task.md không thể spoiler) + 8 red lines.**
`task.md` được gen **chỉ từ frontmatter `description` + codebase** (không thấy `guide.md`/`expectations.md`) → **về mặt vật lý** ngăn prompt "báo đáp án" cho trial unguided. Kèm **8 red lines** review eval (check sai verdict, task báo đáp, expectation ngoài phạm vi/vacuous, task-grader lệch, calibration vỡ…) — review bar **enumerable, ngắn**. Bằng chứng: `project-evals/SKILL.md` (8 red lines, task.md rules), `src/grading/generate-grader.ts:26`.

---

## 6. Áp dụng vào `opencode-telegram-bot`

Ngữ cảnh bot: Telegram bot quản lý **worker là coding-agent (OpenCode)** trên **spec pipeline** (`docs/sdd` specs, **checkpoint cards**, accept/reject với **host-side `typecheck`+`test:unit` gate**), worker briefs chứa **working rules + tool discipline + report schema**, có **agent skills** (`.opencode/skills/`) và **skill `review-code`**. **Chỉ borrow METHODology** (authoring, calibration evals, token-budgeted retrieval, deterministic scan), KHÔNG borrow nội dung web.

> Quy ước: **Effort** = S/M/L; **Risk** thấp/trung/cao; **G** = gượng ép (không thật sự khớp).

**1. Calibration evals (golden/zero-passrate) cho briefs & skills của bot — *M* · Risk thấp.**
Bot đang "cảm" brief/rule nào hiệu quả. Áp dụng chính xác pipeline §2.3: cho mỗi brief/skill/`review-code` rule, định nghĩa 1 **base repo tái-sinh được** (task chuẩn), 1 **golden patch** (worker OpenCode chạy 1 lần), 1 **zero-passrate baseline**, và **grader deterministic** = chính gate `typecheck`+`test:unit` + thêm assertion có cấu trúc (pass/fail mỗi check). Calibrate: golden pass 100%, baseline 0%. Khi brief đổi → re-calibrate tự động. *Vì sao quan trọng:* biến việc "viết rule hay" thành việc **đo được** — chính là giá trị lõi của MWG. *Không G*: bot đã có sẵn deterministic gate, chỉ cần bọc thành harness.

**2. Cơ hội (Opportunity/Uplift) trên đúng gate host có sẵn — *S–M* · Risk thấp.**
Áp dụng "lite" của #1: không cần harness mới, chỉ **instrument gate `typecheck`+`test:unit` hiện có** để ghi **unguided** (worker chạy KHÔNG brief/rule) vs **guided** (CÓ brief) pass rate, per worker + per loại task. Tính **opportunity** (=100−unguided) và **uplift** (pp). Dùng để **prune brief/rule nào uplift≈0**. *Vì sao quan trọng:* rẻ nhất để có vòng lặp empirical, tái sử dụng hạ tầng đã có. *Không G.*

**3. Deterministic pre-scan + LLM-verify hybrid cho skill `review-code` — *M* · Risk trung.**
`review-code` hiện LLM-only → thêm **Static Matcher** (grep/AST/regex rẻ) phát *ứng viên* issue kèm **rubric keepWhen/dropWhen**, sau đó LLM **verify từng finding** theo rubric trước khi báo. Mỗi finding có **CardID** ổn định (`SHA256(repo:commit:file:line)`) để theo dõi/tránh trùng. Chỉ "ship" rule review nào đạt **precision threshold trên held-out** (Wilson + multi-check). *Vì sao quan trọng:* cắt false positive + token cost, ổn định tracking — đúng pattern §4. *Không G*: code của bot là TS/Node nên rule là pattern TS/Node (methodology, không phải nội dung web).

**4. "8 red lines" — checklist review cho specs/briefs/checkpoint cards — *S* · Risk thấp.**
Nhập 1 **checklist enumerable ngắn** kiểu §2 (`project-evals` 8 red lines) cho việc tác giả viết spec/checkpoint card của bot: vd "brief không được 'báo đáp án' cho worker", "acceptance criterion của checkpoint card phải **kiểm thử được khách quan** bởi gate host", "không chấm thứ spec không yêu cầu", "task (spec) và grader (gate) phải đồng bộ", "cấm check vacuous". *Vì sao quan trọng:* biến kỷ luật review thành checklist ngắn, rẻ, leverage cao nhất. *Không G.*

**5. Token-budgeted retrieval + `/tmp` spill cho rules/specs nạp vào brief — *M* · Risk thấp.**
Khi corpus spec/rule/convention của bot lớn, nạp "working rules + tool discipline + report schema" vào brief có thể phình context. Áp dụng §3: **hybrid retrieval** (ít nhất là BM25, không cần embedding) trả **compact K≈10 (~50 tokens/mục)** + **token budget cứng** cho phần nạp vào brief + **spill `/tmp`** khi brief/rule dài vượt ngưỡng (tránh Telegram/harness truncate). *Vì sao quan trọng:* bảo vệ context window của worker + size message Telegram. *Không G.*

**6. "Experimental rules" gate (tương tự Origin-Trial/Volatile) — *S* · Risk thấp.**
Tương tự §3.4: đánh dấu các **rule/skill "experimental"** phải **opt-in theo repo** (1 flag trong config bot, tương tự `.mwgrc`), mặc định tắt; message CAUTION cấm worker tự bật, yêu cầu hỏi user/host. *Vì sao quan trọng:* governance cho rule chưa ổn định, tránh rule "chạy lung tung" trên mọi worker. *Không G*: tương tự thật sự (rule chưa ổn = API chưa ổn).

**7. G (gượng ép): Baseline-aware browser-support macros.**
MWG render **browser-support động** từ BCD/caniuse qua build-time macro. Bot **không phải web app** → không có "browser support" tương đương. Cưỡng ép gán "version-gate rule theo toolchain của OpenCode" thì yếu và勉 cưỡng. → **Đánh dấu G**, bỏ qua (trừ khi bot thật sự cần rule chỉ áp dụng khi toolchain ≥ X — lúc đó mới là analog nhỏ).

**Tổng hợp:** 5 idea thật sự khớp (#1, #2, #3, #4, #5) + 1 idea khá (#6); #1 + #2 cùng một trục (measure-then-trust) nên làm #2 trước (rẻ) rồi mở rộng #1 (harness). #3 (hybrid review) là "quả ngọt" thứ hai. #7 bỏ.

---

## 7. Cái KHÔNG portable (cụ thể của web guidance)

- **Toàn bộ nội dung 262 web feature guides** (`guides/`, `CSS & Layout 140`/`HTML & DOM 37`/`JS 85` — `README:92-162`): rõ ràng không dùng được cho bot không-web.
- **Dữ liệu + tích hợp browser-support**: `@mdn/browser-compat-data`, `caniuse-lite`, `mdn-data`, `web-features`, `src/core/baseline.ts`, macro `BASELINE_STATUS` — chỉ có ý nghĩa với "web platform".
- **Playwright browser graders** (computed style, accessibility tree, runtime DOM, `checkTargetPageLoad` — `src/grading/`, `docs/LEXICON.md` "Page-Load/Build Error"): bot không build web UI; gate của bot là `typecheck`+`test:unit`. *Khái niệm* "outcome-based grading" portable, nhưng **check cụ thể** (a11y/layout/animation) thì không.
- **Base Apps** `daily-grind`, `devtools-times` (`src/harness/base-apps/`, `src/core/guide-validation.ts:516`): là web starter apps; bot phải tự có "task repo tái-sinh được" riêng.
- **Static-embedding tables + IDF fit** (`src/rag/gen/query-words.*`, 29,165 từ web): **kỹ thuật** portable, nhưng **bảng distill + corpus-IDF** là của corpus web; bot phải **retrain** (hoặc chỉ dùng BM25).
- **Agent runners cụ thể** (Antigravity/Codex/Claude-via-Vertex/Jetski — `src/harness/agents/`, `config.ts:13,50`): bot dùng **OpenCode**; harness portable nhưng runner không.
- **Telemetry → Google** (`src/cli/telemetry`, `README:638-648`) & **governance** (ATLs/Peers/Content ATLs/CLA/Google — `AGENTS.md`, `GOVERNANCE.md`): riêng về tổ chức, không borrow.

---

## TL;DR (5 bullet)

- **Repo = "factory" tạo Agent Skills cho web**: `guide.md` là file duy nhất agent đọc lúc runtime; mọi file khác chỉ để author/validate/eval (`AGENTS.md:5-6`). 262 web features, 2 CLI (`gd` dev + `modern-web-guidance` user).
- **Điểm giá trị nhất = pipeline calibrate tự-verify**: golden 100%/zero-passrate 0% (grader tự chứng minh) → **opportunity/uplift** quyết **prune** guide model đã biết (đúng lời README: "token-efficient… prune lowest-common-denominator content") → **regression guard 5% + nightly cron** giữ chất → **sandbox che repo** bảo đảm số đo không nhiễm.
- **Retrieval bảo vệ context window bằng 4 lớp**: asymmetric static embedding (30µs, chống cone-collapse), RRF+BM25 floor gate (trả `[]` khi ngoài phạm vi), compact K=10 ~530-token budget, và tự **spill `/tmp` >9.5KB**; kèm **origin-trial/volatile gates + baseline banner** theo `.mwgrc`.
- **legacy-scan = "deterministic trước, LLM sau"**: Static Matcher zero-LLM (fastTokens+AST) chỉ "giật" + **rubric keep/drop** cho LLM verify, chỉ ship rule đạt **precision ≥90% trên held-out** (Wilson + sequential stopping + multi-judge) — pattern đúng đắn cho LLM review.
- **Borrow cho bot (methodology, không nội dung web)**: (1) calibration evals golden/zero-passrate cho briefs/skills, (2) opportunity/uplift trên đúng gate `typecheck`+test:unit có sẵn, (3) deterministic pre-scan + LLM-verify cho `review-code`, (4) "8 red lines" cho spec/checkpoint, (5) token-budgeted retrieval + /tmp spill; **G** = baseline browser-support macros (không tương đương).
