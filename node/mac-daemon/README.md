# Mac node daemon

The Mac side of `/node`: a small daemon that watches the `node/mac` git
branch, runs queued tasks with the **Claude Code CLI** in a private
worktree, and files a report back — all over git, no open ports.

```
/nodes task "..." (Telegram) → hub commits tasks/<id>.md → push
Mac daemon (poll 30s) → claim → git worktree → claude -p → done/<id>.md → push
hub (poll 30s) → report về chat
```

## Setup (1 lần)

```bash
cd node/mac-daemon
./install.sh
```

Yêu cầu: Node ≥ 20, `claude` đã login (`claude /login`), repo đã `git pull`.
Daemon tự chạy khi máy khởi động, tự sống lại khi crash (launchd).

Tùy chỉnh: đặt env **trước khi chạy** `./install.sh` (script ghi vào plist;
chạy lại sẽ ghi đè plist, nên đừng sửa tay):

```bash
MAC_NODE_POLL_MS=15000 ./install.sh
```

`PATH` và đường dẫn `claude` được chốt lúc install — đổi phiên bản Node hoặc
dời `claude` thì chạy lại `./install.sh`.

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `MAC_NODE_WORKROOT` | `~/mac-node` | Repo clone riêng + worktrees + logs |
| `MAC_NODE_POLL_MS` | `30000` | Khoảng thời gian poll (tối thiểu 10s) |
| `MAC_NODE_CLAUDE_BIN` | `claude` | Đường dẫn binary claude |
| `MAC_NODE_MAX_TURNS` | `200` | Số turn tối đa mỗi task |
| `MAC_NODE_TIMEOUT_MS` | `1800000` | Timeout cứng mỗi task (30 phút) |
| `MAC_NODE_GIT_TOKEN` | *(trống)* | Token GitHub để clone/push khi origin là **SSH** (launchd không có ssh-agent). Đặt: `MAC_NODE_GIT_TOKEN=$(gh auth token) ./install.sh` |

## Vận hành

```bash
tail -f ~/mac-node/logs/daemon.log            # log chạy
launchctl print gui/$(id -u)/com.tobbies.macnode | head -20   # trạng thái
./uninstall.sh                                # dừng + gỡ (giữ data)
```

## An toàn

- Claude chạy với permission profile cố định: sửa file trong worktree +
  allowlist lệnh bash (git/npm/node/ls/cat…) — không sudo, không network,
  không có prompt nào treo được (chạy headless, không ai trả lời).
- Code chỉ push lên branch `node-code/<id>` — không bao giờ đụng main.
- Daemon dùng clone riêng trong `~/mac-node/repo` — không chạm clone
  làm việc của bạn.

---

# Claude advisor daemon

Một daemon **riêng** (chạy song song với node daemon) để Manager có một *cố
vấn* Claude: trả lời từ ngữ cảnh được gửi qua, **không chạy code**, không cần
repo. Reachable từ hub qua **Tailscale** — không mở port ra internet, chỉ
thiết bị trong tailnet.

```
Manager (hub) → tool consult / /ask → POST /ask {sessionId?, message, context?}
Mac advisor daemon → claude -p (lần đầu) | claude --resume <sid> (hỏi tiếp)
→ {answer, sessionId, cost, tokens} → hub → Telegram topic
```

## Setup (1 lần)

```bash
cd node/mac-daemon
export MAC_ADVISOR_TOKEN='<secret>'   # hub phải dùng CÙNG secret
./install-advisor.sh
```

Yêu cầu: Node ≥ 20, `claude` đã login, **Tailscale đang chạy** trên Mac.
Daemon tự chạy khi máy khởi động, tự sống lại khi crash (launchd).

`MAC_ADVISOR_TOKEN` là khoá duy nhất mở `/ask` — nó được ghi vào plist (chỉ
bạn đọc được). Hub cần đúng giá trị này ở `MAC_ADVISOR_TOKEN` trong `.env`.

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `MAC_ADVISOR_TOKEN` | *(bắt buộc)* | Secret shared — hub dùng cùng giá trị |
| `MAC_ADVISOR_WORKROOT` | `~/mac-advisor` | Registry session + logs |
| `MAC_ADVISOR_PORT` | `8391` | Port HTTP (chỉ Tailscale vào được) |
| `MAC_ADVISOR_MAX_TURNS` | `8` | Số turn tối đa mỗi lượt cố vấn |
| `MAC_ADVISOR_TTL_MS` | `86400000` | Xoá session không dùng sau 24h (lưới an toàn) |
| `MAC_ADVISOR_CLAUDE_BIN` | `claude` | Đường dẫn binary claude |

## Vận hành

```bash
tail -f ~/mac-advisor/logs/advisor.log            # log chạy
curl -s 127.0.0.1:8391/health                     # {ok, sessions}
launchctl print gui/$(id -u)/com.tobbies.macadvisor | head -20
./uninstall-advisor.sh                             # dừng + gỡ (giữ data)
```

## An toàn

- Chỉ nhận yêu cầu kèm `Authorization: Bearer <TOKEN>` — thiếu/sai là 401.
- Chạy `claude` với profile **chỉ đọc** (`--permission-mode plan` +
  Read/Grep/Glob) — không sửa file, không chạy lệnh, không chạy code.
- Một lượt claude mỗi lúc (khóa toàn cục) — `--resume` không thể chạy đua.
- Session xoá khi: `/forget` (hub gọi khi `/prune` topic) hoặc TTL 24h không dùng.
