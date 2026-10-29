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
