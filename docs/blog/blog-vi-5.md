# Khi "màn hình" là một cái điện thoại, tôi không "chạy thử" được — nên tôi phải dựng một con người giả.

Bốn bài trước, con người rời terminal ngày càng xa, cho đến Bài 4 thì gần như không còn mặt mũi nào để nhìn vào hệ thống nữa: bạn không ngồi trước terminal, bạn không đọc log, bạn chỉ nhìn thấy những gì con bot *gửi lên Telegram*.

Và đó là lúc tôi va vào một vấn đề *trái gương* với cả series: **hệ thống này chỉ có đúng một mặt mũi, và mặt mũi đó là điện thoại của tôi.** Vậy khi tôi đang *viết* nó, khi tôi đổi một dòng code và muốn biết "có hỏng gì không" — tôi nhìn vào đâu? Tôi không thể "chạy thử rồi xem màn hình", vì màn hình là một cuộc hội thoại Telegram mà tôi là người duy nhất được nói chuyện, và tôi phải *gõ tay từng tin* để kích hoạt từng đường code.

Bốn bài trước kể **nơi nó vỡ**. Bài này kể **làm sao mà tôi biết nó vỡ** — vì đây là câu hỏi mà nếu không trả lời được, bốn bài kia chỉ là những lần may mắn. Và có một điều tôi phải nói thẳng ngay: **các bug khó nhất trong series (đặc biệt của Bài 4) là *vô hình* khi bạn dùng tay.** Không ai bắt được vụ "hai writer đè nhau" hay "cú bấm duyệt cũ" bằng cách ngồi chat trên điện thoại. Bạn *bắt buộc* phải có một thứ gì đó khác. Đó là thứ này.

## Vụ 1 — Màn hình là điện thoại, vậy "chạy thử" nghĩa là gì?

Vấn đề gốc: bề mặt người dùng là Telegram, một transport mà tôi không thể dễ dàng điều khiển trong một test. Tôi không muốn phải mở điện thoại thật, gõ thật, bấm thật để kiểm tra một thay đổi code.

Giải pháp là một *con người giả*. Nó là một class `MockTelegram` — **cùng interface** với client Telegram thật mà bot dùng, nhưng thay vì gọi API Telegram, mỗi lần bot "gửi" một tin, nó **ghi vào một mảng**:

```ts
class MockTelegram {
  out: string[] = [];
  keyboards: any[] = [];
  async sendMessage(_chatId, text, opts = {}) {
    this.out.push(text);                          // không gửi — chỉ ghi lại
    if (opts?.reply_markup) this.keyboards.push(opts.reply_markup);
  }
  async editMessageText(_chatId, _messageId, text, opts = {}) {
    this.out.push("[edit] " + text);              // tin tự sửa → 1 dòng mới trong log
    ...
  }
  async getMe() { return { id: 1, username: "Mock" }; }
}
```

Điểm then: **tôi chỉ giả cái *transport*, không giả cái *bot*.** `new Bot(mock as unknown as Telegram, oc, st, cfg)` — bot là con Bot *thật*, OpenCode là service *thật*, chỉ có điện thoại là giả. Và "nhìn màn hình" giờ chỉ đơn giản là **đọc `mock.out`**.

Nhưng đọc một mảng bị động thì không phải một test. Tôi cần một cách để *chờ* một điều gì đó xuất hiện. Đó là `waitFor` — cứ 300ms quét lại log cho tới khi một điều kiện đúng:

```ts
const done = await waitFor((a) => a.some((m) => /· \d+(\.\d+)?s/.test(m)), mock.out);
```

Và để "gõ tin" hay "bấm nút", tôi chỉ tạo ra các object `Update` giả và đổ vào *đúng entry point* mà vòng lặp polling thật cũng dùng: `bot.handle(upd("/help"))` (một tin nhắn) và `bot.handle(tap("cmd:ls"))` (một cú bấm nút). Điện thoại thật và điện thoại giả, rốt cuộc, đều chỉ đổ `Update` vào cùng một chỗ.

> **Khi bề mặt người dùng là một transport bạn không kiểm soát được (điện thoại, token, web socket), động tác đầu tiên của test-infrastructure là thay transport đó bằng một *trình ghi* nói cùng interface.** "Xem màn hình" sẽ chỉ còn là đọc một mảng, và "tương tác với màn hình" chỉ còn là đổ vào các event giả. Mọi thứ sau đó — assert, chờ, replay — đều dựng được trên hai cái đó.

Chi tiết nhỏ mà tôi thích: tin *tự sửa* (live activity line, dòng trạng thái `📖 Đang đọc …`) được giả lập bằng cách đẩy một dòng mới có tiền tố `[edit] ` vào cùng log. Để assert "dòng đã đổi sang trạng thái duyệt", tôi chỉ cần tìm dòng `[edit]` chứa đúng chữ:

```ts
const answered = await waitFor((a) => a.some((m) => m.startsWith("[edit]") && m.includes("Đã duyệt")), mock.out);
```

## Vụ 2 — Không được phép mock phần quan trọng nhất

Một e2e test tồn tại để bảo vệ *lớp glue*. Mà glue chỉ có nghĩa khi nó nối với *thứ thật*. Vậy nếu tôi mock luôn OpenCode, tôi đang test **mock của tôi về OpenCode** — không phải OpenCode. Và tiền đề của cả series là gì? *Model không bao giờ là phần hỏng; glue mới là.* Mock OpenCode = vứt đi đúng phần bạn muốn test.

Vì thế `smoke` chạy trên **service OpenCode thật, với những lượt LLM thật** (mất vài phút). `TELEGRAM_BOT_TOKEN = "dummy"` — không cần token Telegram thật — nhưng `oc.connect()` là kết nối thật, và mọi prompt tôi gửi đều đi qua một model thật.

Điều đó đặt ra một căng thẳng rất applied-AI: **model thật = chậm + không tất định** (nó có thể nói những từ khác nhau mỗi lần chạy). Nếu tôi assert vào *lời* model, test sẽ đỏ một cách ngẫu nhiên. Hai chiêu tôi dùng:

**1) Canned prompts ép output gần như tất định.** Thay vì "hãy kể cho tôi về dự án", tôi gửi prompt gán cho model *chỉ một cách trả lời duy nhất*:

```ts
await bot.handle(upd("Reply with exactly the single word: HELLO. Nothing else."));
```

Model vẫn là model thật, nhưng lời nói của nó bị *bó* lại còn một hằng số tôi kiểm soát được.

**2) Assert vào *cấu trúc quanh* model, không phải *lời* model.** Tôi không check chữ "HELLO" mà model nói — tôi check những **mỏ neo ổn định** mà *glue* sinh ra, không phải model: dòng footer `· Ns`, icon `🔐`, tiêu đề form `Câu 1/1`, hay một probe token do *tôi* gắn vào:

```ts
const probe = "SWEEP-PROBE-" + Date.now();
await oc.promptAndWait(sid, `Reply with exactly the single word: ${probe}. Nothing else.`);
const swept = await waitFor((a) => a.some((m) => m.includes(probe)), mock.out);
```

Tôi tự gắn một con số ngẫu nhiên vào prompt, rồi assert rằng *đúng con số đó* quay trở lại trong log. Đó là cách bạn test một vòng có model ở giữa: **đừng tin model nói gì, hãy tin model *đưa đúng thứ bạn nhét vào* ra đúng chỗ.**

> **Đừng mock phần bạn không chắc.** Mock transport (vô vị, bạn suy luận được); chạy model thật (đúng phần bạn đang bảo vệ). Và **khi model nằm trong vòng, assert vào cấu trúc *xung quanh* nó, không phải vào *lời* nó.**

## Vụ 3 — Bug đồng thời chỉ bắt được bằng `Promise.all`

Đây là phần trả tiền cho cả Bài 4.

Nhớ lại vụ "hai cây bút, một trang giấy": hai worker song song ghi đè nhau. Làm sao *test* được điều đó? Một con người không thể ngồi ở hai chỗ cùng lúc để spawn hai worker, prompt cả hai *ngay lúc đó*, rồi kiểm tra xem trả lời của cái này có lẫn sang topic của cái kia không. **Dùng tay, bạn gần như không bao giờ kích hoạt đúng race đó.**

Điện thoại giả biến nó thành một dòng:

```ts
// Không chờ cái này rồi cái kia — CẢ HAI phải chạy cùng lúc.
await Promise.all([
  bot.handle(msg(`Reply with exactly the single word: ${pa}. Nothing else.`, ta)),
  bot.handle(msg(`Reply with exactly the single word: ${pb}. Nothing else.`, tb)),
]);
check("no cross-talk",
  !inConv(`${CHAT}:${ta}`, new RegExp(pb))() &&   // trả lời beta KHÔNG được nằm trong topic alpha
  !inConv(`${CHAT}:${tb}`, new RegExp(pa))());     // … và ngược lại
```

`Promise.all` là *cách duy nhất* để ép hai lượt chạy song song trong một test — và `no cross-talk` là một **assertion âm**: tôi không check "có thứ A", tôi check "**không có** thứ sai". Với các bug đồng thời, assertion âm thường là cái quý nhất, vì triệu chứng thật sự không phải "có một tin thừa" mà là "tin của *sai người* rơi vào *sai chỗ*".

Cùng một tư tưởng âm, áp lên consent ở Bài 4 ("cú bấm cũ, việc mới"). Trong chế độ `/auto off`, khi Manager muốn spawn một worker, tôi assert điều *cấm xảy ra trước khi người duyệt bấm*:

```ts
const card = await waitFor(() /* card "Manager muốn giao việc" hiện ra */);
check("approval card shown", card);
check("nothing spawned before approval", !threadOf("lister"));  // ← worker CHƯA được sinh
await bot.handle(tap(btn));                                       // rồi mới bấm ✅
check("approve spawns the worker", await waitFor(() => !!threadOf("lister"), 30_000));
```

Bạn không thể *nhìn* thấy "không có gì sai xảy ra" bằng mắt — nhưng một assertion âm `!threadOf("lister")` nói cho bạn biết, một cách chắc chắn, rằng **việc chỉ xảy ra *sau* cú bấm**, không phải trước. Đó chính xác là thứ mà nguyên tắc "đúng người quyết, đúng lúc" của Bài 3/Bài 4 cần được *kiểm chứng*.

> **Bug đồng thời không bao giờ tái hiện khi bạn dùng tay.** Hai writer race, một cú duyệt sót, một turn-end bị rơi — bạn chỉ bắt được chúng bằng `Promise.all` ép song song + **assertion âm** ("thứ sai phải *không* có mặt"). Đây là lý do `smoke:multi` tồn tại riêng: nó là nơi duy nhất tôi có thể tái hiện Bài 4 một cách *có chủ đích*.

## Vụ 4 — Một smoke test cho *mỗi* bug đã sửa

Đây là phần tôi tự hào nhất, và là lý do bài này xứng đáng là bốt của series.

Tôi cấu trúc `smoke.ts` theo cách mà **từng section là một regression test cho một bug cụ thể của một bài cụ thể**. Suite test, ở đây, chính là *bản changelog mà tôi có thể chạy lại*:

| Section trong `smoke` / `smoke:multi` | Bug nó bảo vệ |
| --- | --- |
| **question relay** — agent gọi tool `question` → form hiện ra → bấm option → câu trả lời được đưa vào session | Bài 1 — *tai* (agent phải hỏi lại được) |
| **out-of-band turn** — prompt *trực tiếp qua API* (không qua bot), như một background-task completion → bot phải relay về | Bài 2 — *mắt* (turn chạy nền, kết quả không được rơi) |
| **permission relay** — tạo *thật* một request quyền → card `🔐` hiện → bấm `perm:<id>:once` → được trả lời | Bài 3 — *bàn tay* (vòng consent) |
| **plan-to-build** — một turn plan thành công → hiện nút one-tap → bấm → turn execute chạy | Bài 3 — *modes* |
| **parallel topics + no cross-talk** — hai worker song song, trả lời không lẫn | Bài 4 — *hai cây bút* (cô lập) |
| **manager confirm + "nothing spawned before approval"** | Bài 4 — *cú bấm cũ, việc mới* (consent orchestration) |

Section **out-of-band turn** là ví dụ đẹp nhất, và nó thậm chí còn *kể lại lịch sử* trong chính comment:

```ts
// Prompt the session DIRECTLY via the API (not through the bot), exactly like
// OpenCode runs a turn triggered by a background-task completion. The bot's
// live event subscription should relay the reply — before this feature the
// output was silently dropped until the next restart.
```

"Trước tính năng này, output bị *rơi im lặng* cho tới lần restart tiếp theo." Câu comment đó là cả Bài 2 trong ba dòng. Và giờ nó được *chốt* lại thành một test: prompt một session *từ bên ngoài* (mô phỏng đúng cách OpenCode chạy một turn do background-task kích hoạt), rồi assert rằng reply *vẫn* được relay lên. Nếu một ngày sau ai đó vô tình phá hỏng đường relay nền — đúng bug cũ quay lại — `smoke` sẽ **đỏ**, và tên section sẽ nói với tôi *bug của bài nào* vừa sống lại.

> **Ghi lại lịch sử bug vào harness.** Mỗi lần sửa một bug, hãy biến nó thành một test mang *tên của nó*. Khi đó, suite test không chỉ bảo vệ hiện tại — nó là bản changelog có thể chạy lại, và một regression không chỉ báo "có gì sai" mà nói được "sai của *lần nào*".

## Ba tầng, chia theo "cái gì mock được"

Cả bộ không chỉ có hai cái smoke. Nó chia làm ba tầng, và *cách chia* mới là bài học:

```
npm run test:unit   # nhanh, KHÔNG cần service — format, config, state, fsbrowser…
npm run smoke       # chậm, OpenCode THẬT — toàn bộ vòng 1 agent (mỗi bài 1–3)
npm run smoke:multi # chậm nhất, OpenCode THẬT — toàn bộ vòng nhiều agent (bài 4)
```

Nguyên tắc chia rất rõ: **mock được → unit; không mock được (có model trong vòng) → smoke.** Các function thuần (escape, chia trang, parse config, chọn thư mục) bạn *có thể* mock và test nhanh — chạy chúng mỗi push. Nhưng "quyền có được relay thành nút không", "turn nền có được chuyển lên không", "hai worker có lẫn nhau không" — những câu hỏi đó *chỉ có nghĩa* khi model chạy thật, nên chúng nằm ở tầng smoke, chạy *định kỳ* và *đắt* hơn.

Trên CI, chốt lại bằng tầng rẻ nhất, luôn bật: **`npm run typecheck` phải pass ở mọi push và PR** (một gate không bao giờ cho phép code không compile vào nhánh). Các smoke live thì là những gate *định kỳ, đắt, cần một OpenCode đang chạy* — không chạy mỗi commit, nhưng chạy đủ thường xuyên để Bài 4 không kịp sống lại giữa hai lần kiểm tra.

> **Pyramid không chia theo "quan trọng", mà chia theo "cái gì mock được".** Function thuần → unit (mỗi push). Vòng glue+model → smoke (định kỳ, model thật). Vòng multi-agent → smoke:multi (đắt nhất, bắt được thứ hai tầng kia không với tới). Mỗi tầng giả đúng *vừa đủ*, và không giả phần mình đang bảo vệ.

## Điều tôi mang về cho người làm applied AI

Bài này không về model, và cũng không về một bug cụ thể nào. Bài này về *vấn đề meta*: **một hệ thống mà người dùng của nó là một điện thoại thì chỉ có thể tin được khi bạn đã dựng được một con người giả biết *gọi lỗi to ra*.**

- **Bạn không "nhìn màn hình" được khi màn hình là một transport.** Bề mặt người dùng của một agent system là một thứ bạn không kiểm soát (điện thoại, token, socket). Động tác đầu tiên của test là *thay transport bằng một trình ghi* nói cùng interface — rồi "xem màn hình" thành đọc một mảng, "tương tác" thành đổ các event giả.

- **Đừng mock phần bạn không chắc.** Mock transport (vô vị); chạy model thật (đúng phần bạn bảo vệ). Mock phần quan trọng nhất = test cái mock của bạn.

- **Model trong vòng → assert vào cấu trúc, không phải lời.** Canned prompt ép output tất định; assert vào mỏ neo ổn định (footer, icon, probe token) do *glue* sinh ra, không phải vào chữ model nói.

- **Bug đồng thời chỉ bắt được bằng harness.** `Promise.all` ép song song + **assertion âm** ("thứ sai phải không có mặt"). Không có con người nào, bằng việc dùng tay, tái hiện được một race hay một cú duyệt sót.

- **Ghi lịch sử bug vào harness.** Mỗi bug sửa được → một test mang tên nó. Suite test thành bản changelog chạy lại được; regression nói được "sai của *lần nào*".

Và một điều sâu hơn, nối lại suốt bốn bài: **bốn bài trước dạy tôi *nơi* glue vỡ. Bài này dạy tôi rằng, với một hệ thống mà con người đã rời khỏi terminal, *cái giá để biết nó còn đứng* là một con người thứ hai — giả, nhưng trung thực — ngồi ở đầu kia của chiếc điện thoại.** Bạn không thể vận hành một đội AI mà không biết cách *chứng minh* chúng đang làm đúng. Và cách chứng minh đó, ở quy mô agent, trông gần như y hệt một người dùng — chỉ khác là người dùng đó *không bao giờ* hài lòng, và sẽ đỏ lên mỗi lần một điều bạn *tưởng* đã đúng hóa ra không.

---

Phần kỹ thuật: `MockTelegram` (~40 dòng, cùng interface `Telegram` nhưng ghi vào `out[]`), `waitFor(pred)` để assert, các `Update` giả đổ vào `bot.handle()` — entry point chung của cả polling thật lẫn test. `smoke` (OpenCode thật, vòng 1 agent), `smoke:multi` (OpenCode thật, vòng nhiều agent + Manager + approval), `test:unit` (không cần service). Nếu bạn muốn link repo — hay muốn một con người giả cho *hệ thống* của bạn, thứ biết gọi lỗi to ra thay vì im lặng — cứ nói. Và nếu bạn đang vận hành một hệ thống mà "màn hình" của nó là một thứ bạn không nhìn được trực tiếp — bạn đang "chạy thử" bằng cách nào? Kể tôi nghe, tôi rất muốn nghe.
