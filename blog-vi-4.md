# Hai con AI cùng sửa một repo. Cả hai làm đúng — và repo của tôi hỏng.

Ba bài trước, con người cứ rời terminal xa dần:

- **Bài 1 — tai:** agent cần hỏi lại → bot relay thành nút bấm.
- **Bài 2 — mắt:** agent làm việc phía sau → bot vẫn chuyển kết quả lên.
- **Bài 3 — bàn tay:** agent bị chặn quyền → bot xin phép bạn, bạn **chữ ký** từ điện thoại.

Lần này không còn giác quan nào để mất nữa. Lần này tôi làm điều hơi lạ: tôi không còn nói chuyện với *một* AI. Tôi nhắn cho một con **Manager**, và con Manager đó tự *chia việc, tự chọn thư mục, tự giao cho một đội worker* — mỗi worker một phiên OpenCode riêng, chạy song song, mỗi worker một topic riêng trên Telegram.

Và câu chuyện của bài này không phải "tôi làm được multi-agent". Câu chuyện là: **khi tôi cho nhiều AI làm việc cùng lúc, chúng đã bắn nhau — và không con nào trong số chúng làm sai một điều gì.** Repo của tôi hỏng vì hai cây bút, mỗi cây viết đúng phần của mình, lên *cùng một trang giấy*.

Phần vỡ, một lần nữa, vẫn ở lớp glue. Nhưng lần này glue vỡ theo một kiểu mà ba bài trước chưa từng gặp: **đồng thời.**

## Trước tiên: model vẫn không sai lần nào

Tôi muốn nói lại phát hiện của bài 2 một lần nữa, vì nó vẫn đúng ở quy mô lớn:

**Toàn bộ các worker, cả Manager, đều sinh ra câu trả lời đúng.** Không có con AI nào hallucinate, không có con nào làm sai task. Lỗi — *tất cả* — nằm ở lớp glue nối chúng lại: ai được chạy cùng ai, ai giữ được slot, ai báo cáo về cho ai, và ai có quyền duyệt ai làm tiếp.

Đây là điều mà tài liệu LLM không bao giờ nói với bạn: **đi từ 1 agent sang N agent, bạn không thêm một "vấn đề model" nào. Bạn thêm một lớp hoàn toàn mới của bug — và lớp đó gọi là *đồng thời* (concurrency).** Model không biết nó đang chạy cạnh 4 model khác. Nó chỉ biết phần task của nó. Chính *mối quan hệ giữa các agent* mới là nơi vỡ, chứ không phải bất kỳ agent nào.

Bài 2 tôi viết "một AI tự bắn chính nó" (khiến tôi tự restart bot giữa lượt, mất luôn câu trả lời). Bài 3 tôi viết "một AI tự mở cổng cho nó" (tự thêm rule quyền). Bài này: **hai AI bắn nhau, và cả hai đều vô tội.** Kệ. Đây là 4 cú ngã mới, kể theo thứ tự đau.

## Vụ 1 — Hai cây bút, một trang giấy

Đây là vụ chính, và là lý do bạn đang đọc bài này.

Chế độ song song hoạt động rất đẹp — cho đến khi tôi giao cho hai worker cùng một repo: một worker sửa `api-auth`, một worker viết test cho nó. Cả hai agent `build`, cả hai được quyền ghi file. Sau vài phút, `git status` của tôi ở thư mục chính là một bãi chiến trường: file bị ghi đè, import lạ, hai worker *đã sửa cùng một file* theo hai hướng khác nhau. Không có lỗi nào. Không có crash. Chỉ là hai con AI, mỗi con làm đúng phần mình, trên *cùng một cây checkout* — và phần "cùng" đó là điều chúng không bao giờ biết.

Nguyên nhân trần trụi: **checkout git là một tài nguyên biến đổi chung, và tôi đã để hai tác nhân ghi lên nó mà không cô lập.** Agent càng mạnh thì vụ này càng nguy hiểm, vì hai agent càng *tự tin* ghi đè lẫn nhau.

Cách sửa không phải là "xin các agent cẩn thận" — mà là **coi mỗi writer là một người sống trong căn phòng riêng.** Git đã cho sẵn căn phòng đó: *worktree*. Một writer chia sẻ repo checkout với một writer khác đang bận → bot tự tạo cho nó một worktree riêng, một nhánh riêng, cắt từ HEAD hiện tại:

```ts
// một writer khác ĐANG BẬN, cùng repo, chưa có worktree → cô lập
const shared = this.workersOf(chat).some(
  ([, s]) => BUSY.includes(s.worker!.status) && s.worker!.writes && !s.worker!.worktree && s.worker!.repoRoot === repoRoot,
);
if (this.h.cfg.worktreeMode === "always" || shared) {
  const wt = await addWorktree(repoRoot, directory, name);
  directory = wt.directory; // worker này chạy trong <repo>.worktrees/<name>-<id>, nhánh tg/<name>-<id>
}
```

Nhưng tạo worktree chỉ giải quyết *nửa* câu chuyện — nửa "đừng để chúng đè nhau". Nửa còn lại là **đưa kết quả về mà không phá repo chính**. Merge là chỗ dễ gây thương nhất, và tôi buộc nó phải *từ chối trước khi làm* chứ không phải *sửa sau khi hỏng*:

```ts
// 1) repo chính phải sạch, 2) đang đúng base branch — không thì từ chối
if (dirty) throw new Error("...đang có thay đổi chưa commit — hãy commit/stash trước khi merge.");
if (head !== wt.base) throw new Error(`Repo chính đang ở nhánh "${head}", không phải "${wt.base}".`);
// ... commit phần worker còn lại chưa commit, rồi:
try { await git(repoRoot, ["merge", "--no-ff", "--no-edit", wt.branch], 120_000); }
catch (e) { await git(repoRoot, ["merge", "--abort"]).catch(() => {});
  throw new Error(`Merge bị conflict — đã huỷ merge, repo giữ nguyên.`); }
```

Ba điều tôi học từ vụ này, và cái nào cũng quý:

> **Cô lập là cái giá của song song.** Bạn không thể để hai writer chia sẻ một tài nguyên biến đổi chung. Git worktree là *sandbox rẻ nhất* bạn có được: một view filesystem thật, riêng, cho mỗi writer, kèm một câu chuyện merge/abort gọn gàng.

> **Guard trước, sửa sau.** "Sửa repo khi nó hỏng" không bao giờ là lựa chọn bằng "từ chối merge khi repo không ở trạng thái an toàn". Với hệ thống có AI, *ngăn trước* luôn rẻ hơn *vệ sinh sau*, vì AI sẽ tiếp tục làm việc trong khi bạn dọn.

> **Đừng mất công sức chưa merge.** Khi xoá worktree, nhánh chỉ được xoá nếu đã merge hẳn (`branch -d`); nhánh chưa merge thì **giữ lại**. Công sức của một con AI — dù con đó đã bị kill — không được phép biến mất vì bạn dọn dẹp.

## Vụ 2 — Vòng lặp không biết dừng

Manager được thiết kế để *phản ứng với báo cáo của worker*: một worker xong → bot gửi `[Bot event] worker X DONE …` về cho Manager → Manager đọc và *quyết định bước tiếp*: giao follow-up, spawn thêm, hay báo xong.

Và trong chế độ `/auto on` (Manager tự giao việc không cần chờ ✅ của bạn), tôi để lộ một vòng lặp:

```
Manager spawn worker  → worker xong, báo về
   → Manager đọc báo cáo, thấy "cần làm thêm" → spawn worker nữa
      → worker xong, báo về → Manager lại thấy "cần làm thêm" → …
```

Mỗi vòng không sai. Mỗi con worker đều làm đúng task. Nhưng chuỗi *quyết định liên tiếp của Manager* — mỗi quyết định đều hợp lý cục bộ — cộng lại thành một vòng lặp không có đáy, đốt token và không bao giờ tự dừng. Tôi phát hiện khi thấy chi phí chạy tăng đều trong khi tôi không nhắn thêm tin nào.

Cách sửa không nằm trong prompt. Tôi đã thử viết vào agent prompt của Manager: *"đừng dispatch liên tục"*, *"đừng tạo vòng lặp"* — và nó **quên**, vì một LLM không giữ được một *giới hạn đếm* giữa các lượt. Prompt là lời khuyên; vòng lặp không nghe lời khuyên.

Điều duy nhất giữ được là một **ngân sách số, cứng, nằm trong code**:

```ts
/** Manager-initiated dispatches allowed between two user messages (loop/cost guard). */
const DISPATCH_BUDGET = 12;

private takeBudget(chat: ConvKey): void {
  const left = this.budget.get(chat) ?? DISPATCH_BUDGET;
  if (left <= 0) throw new Error(`Dispatch budget exhausted … Stop and ask the user before dispatching more work.`);
  this.budget.set(chat, left - 1);
}
// mỗi lần người dùng nhắn một tin: this.budget.set(conv, DISPATCH_BUDGET)  ← nạp lại
```

Mười hai lần giao việc cho mỗi tin nhắn của *người dùng*. Hết ngân sách, tool ném lỗi và Manager *bị buộc* dừng lại hỏi bạn. Ngân sách chỉ được nạp lại khi **người thật** lên tiếng — không phải khi một con AI khác trả lời.

Đây là bài học nối trực tiếp với bài 3, nhưng dịch sang quy mô orchestration:

> **Đừng tin model tự kiềm chế ở bất cứ cái gì liên quan đến an toàn hoặc chi phí.** Bài 3: đừng cấp standing permission, để model *xin* chứ không *tự lấy*. Bài này: đừng prompt model *đừng loop*, hãy đặt một **vòng cứng** mà nó không vượt qua được. Lời khuyên thì quên được; một con số trong code thì không.

Và một mẹo nhỏ nhưng đắt: báo cáo của worker bị *nhóm* (debounce ~4s) thành **một** tin `[Bot event]` trước khi đưa về Manager, chứ không phải một worker một tin. Ít "giọt" hơn về Manager nghĩa là ít cơ hội để nó *quyết định liên tiếp* hơn. Đôi khi, chậm lại ở lớp glue là cách an toàn nhất.

## Vụ 3 — Worker kẹt "đang chạy" mãi mãi

Trạng thái của một worker (`running` / `waiting` / `done` / …) **chỉ đổi khi có event trực tiếp** (`session.execution.succeeded` / `failed` / `interrupted`). Nghe hợp lý. Nhưng event là một *dòng stream*, và dòng stream **bị rơi**: một khung mất giữa chừng, một server hiccup, hoặc tệ nhất — *bot restart* đúng lúc một worker đang chạy.

Khi đó, worker đó trong file state vẫn ghi `running` — nhưng phiên của nó thực ra đã xong từ lâu. Nó ngồi lì ở trạng thái bận, **chiếm slot** mãi mãi (mỗi chat tối đa 5 worker bận), và `/board` cứ hứa một con "🟢 đang chạy" mà không bao giờ về. Không lỗi, không crash — chỉ là một trạng thái *lạc hậu một khung so với sự thật*.

Cách sửa là thừa nhận một điều: **trạng thái sinh ra từ event luôn chậm hơn sự thật một nhịp.** Vậy cứ định kỳ *hỏi lại nguồn sự thật* (server) và sửa những ai đang lệch:

```ts
/** worker status only moves on live events, so after a restart or a dropped
 *  stream a worker can look busy long after its turn ended. Ask the server
 *  for the truth and settle any busy worker whose session is actually idle. */
async healWorkers(): Promise<void> {
  for (const [conv, s] of Object.entries(this.h.st.all())) {
    const w = s.worker;
    if (!w || !s.sessionID || !BUSY.includes(w.status)) continue;
    const state = await this.h.oc.sessionState(s.sessionID).catch(() => undefined);
    if (!state || state.busy) continue;                       // server nói vẫn chạy → tin server
    const status = state.outcome === "succeeded" ? "done" : state.outcome === "failed" ? "failed" : "stopped";
    await this.onWorkerFinished(conv, status);                // chốt trạng thái thật
  }
}
// chạy lúc reconnect + một quét chậm mỗi 60s (events có thể rơi cả khi đang chạy)
```

> **Heal, đừng tin.** Bất cứ hệ thống multi-agent nào chạy lâu dài đều sẽ, ở một thời điểm nào đó, có một trạng thái lệch với thực tế — vì *event có thể mất*. Bạn cần một vòng quét định kỳ, *hỏi lại nguồn sự thật* và tự sửa, chứ không thể tin rằng "đã nhận event = đã biết trạng thái". Đây là họ hàng gần của bài 2 (cơ chế phục hồi khi bị gián đoạn giữa chừng) — chỉ khác là lần này thứ bị gián đoạn là *dòng báo cáo của cả một đội*, không phải một lượt.

## Vụ 4 — Cú bấm cũ, việc mới

Bài 3 tôi học rằng: *đừng cấp quyền đứng — hãy để model xin, và để con người duyệt*. Quy tắc đó, tôi tưởng, đã xong ở bài quyền. Nhưng nó còn một chỗ nữa để áp dụng: **duyệt việc giao**.

Khi Manager muốn spawn một worker hoặc giao một follow-up, ở chế độ `/auto off` nó phải chờ bạn bấm **✅ Giao**. Vấn đề: nút đó mang theo một *id* của request. Nếu id là một **counter tăng dần** — và rồi bot **restart** — counter về 1, và *một card duyệt cũ còn sót trên Telegram* (id=3) bây giờ, khi bạn bấm, sẽ khớp với *một request mới hoàn toàn khác* mà bạn chưa từng thấy. Bạn duyệt một việc bạn không hề biết. Đây đúng là "cú bấm cũ, việc mới" — và nó là *cùng một loại lỗi* như việc tự thêm rule ở bài 3, chỉ nhỏ hơn và im lặng hơn.

Cách sửa trông như một dòng, nhưng tư tưởng thì không:

```ts
// Random, not a counter: a counter restarts after a bot restart, and an old
// card's button would then approve a different, unseen request.
const id = randomBytes(5).toString("hex");
```

Id ngẫu nhiên, không phải counter. Một nút bấm cũ không bao giờ khớp được với một request mới, vì không có gì để *khớp*. Và mọi request duyệt đều bị *kiểm tra lại* lúc bấm: đúng chat không? request còn tồn tại không? worker đang bận chưa? — trước khi việc được thực sự giao.

> **Consent quy mô hoá.** Nguyên tắc "đúng người quyết, đúng lúc" của bài 3 không chỉ áp cho *quyền truy cập file* — nó áp cho *mọi việc một con AI muốn làm thay bạn*. Và cơ chế phải chống được cả trường hợp "cú bấm cũ" — tức id phải *ngẫu nhiên và không tái sử dụng*, chứ không phải một thứ đếm lại được sau khi restart.

## Điều tôi mang về cho người làm applied AI

Bài này không về model. Model chưa bao giờ là vấn đề. Bài này về chuyện **xảy ra khi bạn cho nhiều model làm việc cạnh nhau** — và đó là một lớp bug mà mọi tài liệu LLM đều bỏ qua, vì họ viết về *một* model một lượt.

- **Scale không thêm vấn đề model, nó thêm vấn đề đồng thời.** Đi 1 → N, model vẫn hoàn hảo; lớp glue nhận thêm một họ bug mới: race, loop, trạng thái mồ côi, phản hồi. Nếu bạn chỉ test "một agent chạy một task", bạn chưa bao giờ gặp lớp bug này — và nó chỉ hiện ra khi *hai* agent chạy *cùng lúc*.

- **Cô lập là cái giá của song song.** Hai writer không được chia sẻ một checkout. Với LLM, git worktree là sandbox rẻ nhất: một view thật, riêng, cho mỗi writer, kèm merge/abort gọn. Nguyên tắc chung: *mọi tác nhân ghi đồng thời cần một view biến đổi riêng*, không phải một lời hứa "cẩn thận".

- **Budget thắng prompt.** Bạn không thể prompt một LLM *đừng lặp vô hạn*; nó quên. Giới hạn đếm cứng trong code là cách duy nhất để bẻ một vòng lặp. Liên thông thẳng với bài 3: *đặt vòng cứng ở chỗ model không tự kiềm chế được*, không phải trong hệ thống.

- **Heal, đừng tin.** Trạng thái sinh từ event luôn chậm một khung so với sự thật, vì event có thể mất. Hệ thống multi-agent chạy lâu dài cần một vòng quét định kỳ hỏi lại nguồn sự thật và tự sửa.

- **Consent quy mô hoá.** "Đừng cấp quyền đứng, hãy để model xin và người duyệt" áp cho *mọi* việc một AI muốn làm thay bạn — kể cả *giao việc*. Id duyệt phải ngẫu nhiên và không tái sử dụng, để một cú bấm cũ không bao giờ khớp được một việc mới.

Và một điều không mang về được, chỉ kể được: khoảnh khắc tôi nhìn `git status` và thấy hai con AI — mỗi con đều đang làm *đúng phần của nó* — để lại một repo hỏng, tôi hiểu ra rằng **sai lầm trong hệ thống nhiều-agent hiếm khi nằm ở một con nào.** Nó nằm ở *khoảng trống giữa các con* — cái khoảng trống mà một con đơn lẻ, đứng một mình, không bao giờ thấy. Muốn vận hành nhiều AI, việc đầu tiên không phải là chọn model giỏi hơn. Là **thiết kế cho điều xảy ra khi chúng ở gần nhau.**

---

Phần kỹ thuật: cùng repo Node.js nhỏ kia, thêm một lớp orchestration — agent Manager (chỉ được *giao việc*, bị `deny` execute/edit/shell), một MCP bridge chạy local trên `127.0.0.1` (token-guarded, chỉ đăng ký cho thư mục của Manager), forum topics làm "căn phòng" cho từng worker, và git worktree cho các writer. Nếu bạn muốn link repo — hay muốn một con Manager tự chia việc và xin bạn duyệt từng lần giao — cứ nói. Và nếu bạn cũng từng để *hai* AI cùng đụng vào một chỗ và chúng bắn nhau — kể tôi nghe, tôi rất muốn nghe.
