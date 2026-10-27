# Con bot tự giữ mình sống — 93 lần chết, một cú reboot tự bắn, và một con ma DNS

Một đêm nọ — thật, ngày 23 tháng 10 — tôi ở trên điện thoại. Tôi không mở terminal, không đọc log. Tôi chỉ bấm một **nút inline do con bot tự render**: reboot. Bot trả lời: "đang reboot trong ~15 giây".

Vài nhịp sau, máy tắt. Rồi máy bật lại — và bot **tự dậy**. Không ai khởi động nó: nó **tự sinh ra cả dịch vụ OpenCode** (chạy như con tiến trình con, kiểm chứng bằng cgroup và PPID), tự reattach toàn bộ session cũ từ file state, và **trả lời đúng tin nhắn tôi đã bỏ lại trước khi bấm nút**.

Từ điện thoại đến máy đến hệ thống — không có con người nào trong vòng.

Đó là phần "cơ thể" của series. Năm bài trước tôi mới chỉ cho cây cầu có **giác quan**: tai (agent hỏi → nút bấm), mắt (turn chạy nền vẫn chuyển kết quả lên), bàn tay (chữ ký quyền từ điện thoại), thêm đồng thời hoá cho mấy agent và một con người giả để test. Bây giờ nó có thêm một cơ quan — cái đắt nhất và ít được nói tới nhất trong mọi tutorial "làm bot": **cơ quan tự giữ nó sống**.

Bài này kể ba cái chết. Và tôi phải nói ngay một điều: **lần đầu tiên trong series, thủ phạm không phải glue.** Bài 2 tôi viết "mô hình không sai lần nào", bài 4 tôi lặp lại lời đó và nó vẫn đúng. Bài này đúng hai phần ba. Phần còn lại — vụ 2 — là vụ mà *chính model* là thủ phạm.

## Vụ 1 — 93 lần chết: cú crash-loop 10 phút

Tính năng reboot phải được **test bằng đúng một cú reboot thật** — không có cách nào khác để test self-heal. Tôi bấm nút, máy tắt.

Máy bật lại. Bot dậy. Rồi trong 10 phút, bot **chết 93 lần**. Journal đầy một màn hình cùng một vòng lặp ba dòng: service not running → thử connect → fail → systemd restart bot → service not running → …

Tôi đọc log một lúc, rồi đọc lại code. Bug nằm ở phần code "chống đỡ" nhất — phần mà tôi tự hào nhất:

SDK có API `Service.discover()` — hàm "tìm dịch vụ OpenCode". Và hàm này **trả về `undefined` khi dịch vụ chết — chứ không throw**. Code cũ của tôi viết kiểu này:

```ts
try {
  ep = await Service.discover();
} catch {
  ep = await Service.ensure();   // tự-cứu: spawn service nếu nó chết
}
```

Logic tự-cứu (`ensure()`) nằm trong `catch`. Nhưng một dịch vụ chết **không bao giờ đi vào `catch`** — nó chỉ *im lặng trả `undefined`*. Cả khối đó là **code chết**: 93 lần chết, không lần nào được cứu, vì "chuông báo động" mà tôi nối với nó chưa bao giờ reo.

Sửa chỉ bằng hai ý: đừng chờ exception, kiểm tra giá trị trả về.

```ts
let ep: any;
try {
  ep = await Service.discover();
} catch { ep = undefined; }
// discover() resolves to undefined — không throw — khi service không chạy
if (!ep) ep = await Service.ensure();  // tự-cứu không còn nằm trong catch
```

E2E sau đó — reboot thật, zero con người — được xác minh **3 lần**: sau khi máy dậy, bot tự spawn OpenCode service, và **PPID** của process service đúng là PID của chính process bot.

> Exception-based fallback là một lời hứa mà API không nhất định giữ: `discover()` im lặng trả `undefined` thay vì throw, và cả khối `catch` — nơi tôi giấu logic tự-cứu — thành code chết.

Có một phiên bản tổng quát hơn của bài học này, áp cho bất cứ thứ gì: **một API "im lặng" (trả `undefined`/`null` thay vì throw) biến `catch` của bạn từ lưới an toàn thành đồ trang trí.** Nếu bạn dựa vào `catch` để tự-cứu, hãy hỏi mọi API một câu: *khi hỏng, ông ấy có hét lên, hay chỉ lặng đi?*

## Vụ 2 — Cú reboot tự bắn: một backtick trong commit message

Vụ hay nhất của bài. Và là vụ duy nhất mà **chính tôi là thủ phạm**.

Thời gian: 12:47, ngày 23 tháng 10. Tôi đang làm gì: hoàn thiện tính năng reboot, và commit. Lệnh trông thế này:

```bash
git commit -m "feat: nút reboot — bấm xong máy reboot bằng `sudo -n systemctl reboot`"
#            └ backticks trong double-quotes = command substitution
```

Chú ý: message nằm trong **double quotes**, và trong đó tôi *viết tên lệnh* — với **backticks literal** bọc quanh `sudo -n systemctl reboot`, để "nêu tên" nó. Tôi không định *chạy* reboot. Tôi định *chỉ vào* reboot.

Nhưng bash đọc double quotes, và **backtick trong double quotes là command substitution**: máy đã *chạy* lệnh trong cặp backtick, rồi thay thế cả đoạn đó bằng **output** của lệnh (rỗng — reboot không trả về text).

Máy có entry **NOPASSWD** trong sudoers cho lệnh reboot. Nên lệnh thành công — **im lặng, không một lỗi, không một TTY**. Ba giây sau commit, máy reboot.

Cái đẹp nằm ở phần pháp y, vì ba mảnh ghép bằng chứng không mảnh nào chối cãi được:

1. Trong `auth.log`, **PWD** của lệnh sudo khớp **đúng** thư mục worktree nơi tôi đang commit — không có TTY, tức không phải tay người gõ trước terminal.
2. Commit và reboot **cùng một giây**.
3. Trong commit message đã được lưu, **đoạn backtick biến thành chuỗi rỗng** — vì bash đã thay thế nó bằng output (rỗng) của lệnh. Con dao đã được rút, và tên nó không còn trong thông điệp.

Tin tốt: chain self-heal hoạt động đúng như thiết kế (bot + service quay lại sau ~16 giây, commit vẫn nguyên). Tin xấu — và đây là điểm của cả bài: **đây là vụ đầu tiên trong series mà thủ phạm là chính model.**

Bài 2 tôi thề "model không sai lần nào — mọi lỗi ở glue". Bài 4, với bốn agent, tôi thề lại và nó vẫn đúng. Lần này glue vô tội: không race, không phân trang, không event rơi. Một *ngôn ngữ* tôi dùng để nói chuyện với máy (shell) đã đọc *câu tôi viết* thành một *lệnh*.

> Tôi đã viết tên con dao vào thông điệp — và shell đã rút con dao ra.

Lần đầu tiên trong series, glue cũng không phải thủ phạm — thủ phạm là tay người. **Mà người đó là AI.**

Điều tôi học không phải "cẩn thận hơn". Vì cẩn thận chính là thứ đã hỏng — tôi *tưởng* mình chỉ đang trích dẫn. Điều tôi học là: **model là một tác nhân hạng nhất của hệ thống**: nó sinh ra lệnh, sinh ra commit message, và mọi thứ nó sinh ra đều có thể được *thực thi* bởi một thứ khác. Nên phòng thủ phải dịch từ "cẩn thận" sang **kiến trúc**, hai lớp:

**Lớp 1 — quy tắc:** commit message bao giờ cũng qua file (`git commit -F file`). Không bao giờ `-m "..."` chứa backtick hay `$`. Nhưng tôi giờ biết giới hạn của kiểu quy tắc này: *quy tắc là lời khuyên, và lời khuyên thì quên được* (cùng bài học ngân sách ở bài 4).

**Lớp 2 — cổng cứng:** một **token-gated wrapper** tên `safe-reboot`. Sudoers xoá entry NOPASSWD cho lệnh reboot trần; bot chỉ được gọi `sudo -n safe-reboot <token>`. Trước khi gọi, bot **mint một token 128-bit dùng 1 lần**, ghi vào file, rồi gọi wrapper qua `execFile` (một mảng argument — không qua shell). Wrapper kiểm tra **token + TTL (10 giây)** rồi mới cho reboot, và ghi syslog OK/DENIED:

```sh
TTL_MS=10000
FILE_TOKEN=$(cut -d' ' -f1 "$TOKEN_FILE")
FILE_TS=$(cut -d' ' -f2 "$TOKEN_FILE")
# Single use: burn on every invocation, success or failure.
rm -f "$TOKEN_FILE"
AGE_MS=$(( $(date +%s%N) / 1000000 - FILE_TS ))
[ "$1" = "$FILE_TOKEN" ] && [ "$AGE_MS" -lt "$TTL_MS" ] && exec /usr/bin/systemctl reboot
log "DENIED"; exit 1
```

Test bốn đường: token hợp lệ → reboot; replay token **cũ** → DENIED; replay token **đã dùng** → DENIED (file đã bị đốt ngay lần gọi đầu — token *vật lý* dùng một lần, không phải lời hứa); token **hết hạn** (TTL 10s) → DENIED.

Từ đó, nếu tôi — hay bất kỳ bug tương lai nào của tôi — chạy `sudo -n systemctl reboot` trần, không có rule sudoers nào cho phép; nếu gọi `safe-reboot` không có token mới mint, wrapper từ chối và để lại một dòng trong syslog. **Máy không tin lệnh nữa — máy tin một cái token chỉ sống được 10 giây.**

## Vụ 3 — Mạng chết ba ngày, và con ma DNS

Vụ cuối cũng là vụ dài nhất: **gần ba ngày**.

Bối cảnh: máy chạy **OpenVPN** (web-auth) vào mạng nội bộ văn phòng. Sau một lần tắt VPN *không sạch*, `systemd-resolved` **giữ lại DNS server nội bộ của VPN (172.16.254.9) làm resolver đang sống**. Mọi tên miền phải chờ timeout ~15 giây → client HTTP trong bot lỗi `fetch failed` liên tục. Nhưng dịch vụ local (OpenCode, 127.0.0.1) vẫn sống — nên bot **"chết một nửa"**: sống, không crash, chỉ không với tới được thế giới bên ngoài. Hệ thống chết nửa chừng là thứ khó chẩn đoán nhất, vì không có lỗi nào để chỉ vào.

Feature tự-cứu tôi viết cho đúng failure mode đó — `dns-heal` — có chuỗi điều kiện rất chặt: **3 lần** fetch fail liên tiếp ở tầng mạng → chạy probe chỉ-đọc `resolvectl status` → nếu IP DNS ma **vẫn còn đứng** → mới `sudo -n systemctl restart systemd-resolved` (entry NOPASSWD cho **đúng một lệnh đó**), kèm cooldown 10 phút. Và một **cổng an toàn**: cả feature chỉ hoạt động khi IP ma được khai báo trong env `OPENCODE_TG_DNS_STALE_IP` — **env rỗng, feature tắt**.

```ts
export function shouldHeal(state: HealState, now: number, cfg: DnsHealConfig): boolean {
  if (!cfg.enabled) return false;   // cổng an toàn: chưa khai báo IP ma = tắt
  if (state.healInFlight) return false;
  if (state.consecutiveFailures < cfg.minFailures) return false;  // cần 3 lần liên tiếp
  if (state.lastHealAt > 0 && now - state.lastHealAt < cfg.cooldownMs) return false; // 10 phút
  return true;
}
```

Và đây là iron mà tôi buộc phải kể: **feature được viết và merge *trước* sự kiện lớn — nhưng ba ngày nó chưa từng tự fire một lần.** Vì chính cái cổng an toàn mà tôi tự đặt: **tôi quên set IP ma trong `.env` cho tới sau sự kiện.**

> Một tính năng tự-cứu mà chưa từng được arming thì chỉ là một bản ghi nhớ — và cái ngày nó lẽ ra phải làm việc, nó chưa tồn tại.

Đây là một loài bug mới, khác mọi thứ trong series: không phải bug code (code đúng), không phải bug model (model vô tội), mà là **bug cấu hình của chính cơ chế an toàn** — cái cổng ngăn "bắn sai" đã ngăn luôn cả "bắn đúng". Bài học hơi ngược trực giác: **cổng an toàn của một tính năng tự-cứu là một phần của tính năng — và phải được test ở trạng thái "armed"**, chứ không phải trạng thái "off". Sau sự kiện: set IP, arming, sẵn sàng.

Còn sự kiện thật — nền cho cả vụ 3 — thì to hơn con ma DNS: **từ 23:00 ngày 23/10 đến 09:49 ngày 26/10, mạng upstream của văn phòng chết** — server AI nội bộ và internet văn phòng cùng down, một sự kiện hạ tầng, không phải lỗi VPN, không phải lỗi bot. Bot nằm im đúng ba ngày — không crash, chỉ không với tới được bên ngoài — và **dậy bình thường khi mạng về**, trả lời tiếp như không có chuyện gì. Nó dựa vào hai thứ cũ kỹ đến buồn cười: `Restart=always` của systemd, và file `state.json` giữ toàn bộ session. Không có phép màu nào.

## Cơ thể: hệ thống tự nuôi chính nó

Đây là chỗ tôi nối mạch series lại. Cho đến lúc này:

- **Bài 1 — tai:** agent hỏi → nút bấm.
- **Bài 2 — mắt:** turn nền vẫn chuyển kết quả lên.
- **Bài 3 — bàn tay:** chữ ký quyền từ điện thoại.
- **Bài 4 — đồng thời:** hai AI, một repo.
- **Bài 5 — bài kiểm thử:** con người giả gọi lỗi to ra.

Và bài này — **cơ thể**: hệ thống **tự giữ mình sống**.

Chính sách vận hành bây giờ ngắn gọn vừa một dòng: **máy reboot định kỳ sau mỗi 30 ngày uptime** (kernel security patches chỉ có hiệu lực sau reboot). Tôi đã xác minh **51 ngày uptime liên tục không có một lần suspend nào** (lịch sử systemd-inhibit) — một con số mà thời bài 2, khi tôi còn phải tay restart bot giữa lượt, không thể tưởng tượng được.

Con người đã không còn trong vòng loop hoạt động nữa: không phải người canh, không phải người bấm nút, không phải người đọc log. Điều còn lại của con người trong hệ thống này là hai thứ: **chính sách** (30 ngày, TTL token 10 giây, IP ma, ngân sách 12 dispatch) — và sự **hiện diện định kỳ**.

## Điều tôi mang về cho người làm applied AI

- **API "im lặng" biến `catch` thành đồ trang trí.** Tự-cứu bằng exception thì hãy hỏi mọi API một câu: *khi hỏng, ông ấy có hét lên, hay chỉ lặng đi?* Kiểm tra giá trị trả về, đừng chỉ chờ chuông — và nếu API im lặng, logic tự-cứu phải nằm ở nhánh kiểm tra, không phải trong `catch`.
- **Model không chỉ là bộ não — nó còn là tay.** Khoảnh khắc model bắt đầu *viết* lệnh và chạy trên một máy có sudo thật, ranh giới glue/model mất đi. Phòng thủ không nằm ở "cẩn thận" (lời khuyên thì quên được), mà ở cổng cứng: token 128-bit dùng một lần, TTL 10 giây, bị đốt ở *mọi* lần gọi — hợp lệ hay không.
- **Cổng an toàn là một phần của tính năng tự-cứu.** Chưa từng được arming = chưa tồn tại. Hãy test nó ở trạng thái armed, và nhớ: cái cổng ngăn "bắn sai" cũng có thể ngăn luôn "bắn đúng".
- **Thứ giữ hệ thống sống thường là thứ buồn cười nhất.** 93 lần chết dạy tôi về một SDK; nhưng ba ngày mất mạng dạy tôi về hai dòng cấu hình cũ kỹ — `Restart=always` và một file state. Đừng coi thường cái đơn giản; nó mới là thứ chạy 24/7.

Và điều sâu hơn, nối lại suốt series: mỗi bài trước là một giác quan được nối vào cây cầu, và bài này là cái giá để cây cầu **tự đứng** khi mọi người ngủ. Ở giai đoạn này, câu hỏi "applied AI" không còn là "làm sao dùng AI". Nó là: **làm sao AI sống sót khi không có ai.**

---

Phần kỹ thuật: cùng repo Node.js nhỏ — `Service.discover()`/`ensure()` (tự sinh service sau reboot), `dns-heal` (state machine thuần, unit-testable), wrapper `safe-reboot` (token 128-bit dùng một lần, TTL 10s, NOPASSWD cho đúng một lệnh), và hai thứ cũ kỹ đã làm việc nhiều: `Restart=always` + `state.json`. Nếu bạn muốn link repo — hay muốn một con bot tự giữ mình sống trên máy của bạn — cứ nói. Và nếu AI của bạn từng "giết bạn" theo nghĩa nào đó — kể tôi nghe, tôi rất muốn nghe.
