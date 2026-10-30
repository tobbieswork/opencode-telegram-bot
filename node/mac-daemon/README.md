# Claude advisor daemon

Một daemon để Manager có một *cố
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
