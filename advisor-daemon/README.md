# Advisor daemon (Claude / Gemini)

Daemon chạy trên máy có sẵn CLI của agent (Mac hoặc Linux) để bot (hub) hỏi
**ý kiến thứ hai** từ một model khác qua `/ask` hoặc tool `consult` của
Manager. Agent chỉ **tư vấn**: trả lời từ ngữ cảnh được gửi qua, không sửa file,
không chạy lệnh. Hub gọi tới qua **Tailscale**; cổng không mở ra internet.

```
/ask gemini <câu hỏi>  (Telegram)
  → hub: POST /ask {agent, sessionId?, message, context?}  (Bearer token, qua Tailscale)
  → daemon: claude -p … | agy --print=…   (lượt đầu)  /  resume session (hỏi tiếp)
  → {answer, sessionId, cost, tokens} → hub → topic "🧠 Gemini: …"
```

| Agent | CLI | Gõ trong `/ask` | Chế độ chỉ đọc |
|---|---|---|---|
| Claude | `claude` (Claude Code) | `claude` | `--permission-mode plan` + chỉ Read/Grep/Glob |
| Gemini | `agy` (Antigravity CLI) | `gemini` hoặc `agy` | `--mode plan` + `--sandbox` + `--settings` khóa quyền (xem dưới) |

Một daemon chạy được nhiều agent; hub dùng **một** URL + token và chọn agent
theo từng câu hỏi.

## Cài đặt (1 lần)

Yêu cầu trên máy advisor: Node ≥ 20, repo này đã clone, ít nhất một CLI đã
cài **và đăng nhập** (`claude` → `/login`; `agy` → đăng nhập Google), và
**Tailscale đang chạy** (cả trên máy chạy bot).

```bash
cd advisor-daemon
./install.sh
```

Script tự làm hết:
- tìm `claude` / `agy` trong PATH và bật những agent có mặt;
- lấy IP Tailscale của máy làm địa chỉ nghe (không nghe trên Wi-Fi/LAN);
- tạo token ngẫu nhiên (hoặc **giữ token cũ** khi cài lại, để hub không phải đổi);
- cài service tự chạy khi khởi động, tự sống lại khi crash: **launchd** trên
  macOS, **systemd --user** trên Linux. File service chứa token, quyền `0600`;
- in ra 2 dòng để dán vào `.env` của bot:

```
ADVISOR_URL=http://100.x.y.z:8391
ADVISOR_TOKEN=…
```

Trên máy chạy bot: dán 2 dòng đó vào `.env`, restart bot, rồi kiểm tra:

```bash
npm run advisor:doctor          # cấu hình, kết nối, token, agent — không tốn lượt
npm run advisor:doctor -- --live  # hỏi thật mỗi agent một câu
```

Tùy chỉnh: đặt biến **trước khi** chạy `./install.sh` (chạy lại để đổi).

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `ADVISOR_AGENTS` | mọi CLI tìm thấy | Danh sách agent, vd `claude,agy` |
| `ADVISOR_TOKEN` | giữ cũ / tự tạo | Secret dùng chung với hub (≥ 16 ký tự) |
| `ADVISOR_HOST` | IP Tailscale | Địa chỉ nghe. `127.0.0.1` để thử trên máy |
| `ADVISOR_PORT` | `8391` | Cổng HTTP |
| `ADVISOR_CLAUDE_BIN` / `ADVISOR_AGY_BIN` | tìm trong PATH | Đường dẫn CLI |
| `ADVISOR_WORKROOT` | `~/mac-advisor` | Registry session + logs |
| `ADVISOR_MAX_TURNS` | `8` | Số turn tối đa mỗi lượt (Claude) |
| `ADVISOR_TURN_TIMEOUT_MS` | `300000` | Dừng một lượt sau 5 phút |
| `ADVISOR_TTL_MS` | `86400000` | Xoá session không dùng sau 24h |

Tên cũ `MAC_ADVISOR_*` vẫn dùng được.

Phía bot: `ADVISOR_DEFAULT_AGENT=claude|gemini` chọn agent khi `/ask` không
ghi tên agent.

### Nâng cấp từ bản cài cũ (`com.tobbies.macadvisor`)

Chạy lại `./install.sh` sau khi pull. Script gỡ service tên cũ, giữ token cũ
(hub không cần đổi gì) và đổi địa chỉ nghe từ `0.0.0.0` sang IP Tailscale. Nếu
`MAC_ADVISOR_URL` của hub đang trỏ vào IP Tailscale của máy này thì vẫn đúng.

## Vận hành

```bash
tail -f ~/mac-advisor/logs/advisor.log                  # log chạy
curl -s http://<IP Tailscale>:8391/health               # {ok, agents, sessions}
launchctl print gui/$(id -u)/com.opencode-tg.advisor | head -20   # macOS
systemctl --user status opencode-advisor                # Linux
./uninstall.sh                                          # dừng + gỡ (giữ data)
```

Linux: để daemon chạy cả khi bạn chưa đăng nhập, bật linger một lần:
`sudo loginctl enable-linger $USER`.

Hệ khác hoặc chạy tay: `ADVISOR_TOKEN=… ADVISOR_HOST=… npx tsx advisor-daemon/advisor.ts`.

## An toàn

- **Token**: mọi `/ask` / `/forget` cần `Authorization: Bearer <TOKEN>`;
  thiếu/sai là 401 (so sánh hằng thời gian). Không có token thì daemon từ chối
  tất cả. `/health` không cần token và chỉ trả `{ok, agents, sessions}`.
- **Chỉ tailnet**: mặc định nghe trên IP Tailscale (hoặc `127.0.0.1`), không
  bao giờ `0.0.0.0` trừ khi bạn tự đặt — daemon sẽ cảnh báo trong log.
- **Chỉ đọc**:
  - Claude chạy `--permission-mode plan` với allowlist Read/Grep/Glob, không có
    tuỳ chọn nào để nới.
  - agy không có cờ allowlist, nên khóa 3 lớp: `--mode plan`; `--settings`
    **thay** quyền của bạn trong lượt chạy đó bằng `allow: []` +
    `deny: command(*)` (các allow rule bạn dùng khi làm việc tay, như
    `command(git commit)`, không áp dụng ở đây; `settings.json` của bạn không
    bị sửa); và `--sandbox`. Chạy headless nên mọi thao tác cần quyền đều bị từ
    chối thay vì treo — câu trả lời khi đó nói rõ công cụ nào bị chặn.
- **Đầu vào**: body tối đa 256 KB; `sessionId` chỉ nhận ký tự chữ, số, `-`, `_`.
- **Một lượt mỗi agent mỗi lúc** — resume không bao giờ chạy đua.
- **Session** xoá khi `/forget` (hub gọi khi `/prune` topic) hoặc sau TTL 24h
  không dùng. Với agy, daemon chỉ xoá khỏi registry — agy giữ hội thoại trong
  kho riêng của nó và chưa có lệnh xoá.

### Dữ liệu gửi đi

Câu hỏi và `context` được gửi tới nhà cung cấp model của agent (Anthropic với
Claude, Google với Gemini) theo tài khoản đã đăng nhập trên máy advisor. Với
agy, prompt nằm trong tham số dòng lệnh trong lúc chạy, nên user khác trên
cùng máy thấy được qua `ps`. **Đừng gửi dữ liệu khách hàng, hợp đồng, sức
khoẻ, thanh toán hay thông tin định danh** qua `/ask` — tóm tắt hoặc ẩn danh
trước khi hỏi.
