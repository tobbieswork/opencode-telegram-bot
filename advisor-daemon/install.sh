#!/usr/bin/env bash
# Install the advisor daemon as a user service (auto-start, auto-restart):
# launchd on macOS, systemd --user on Linux. The hub reaches it over Tailscale.
#
# Everything is optional — run it bare and it works out the rest:
#   ADVISOR_TOKEN    shared secret; the hub needs the SAME value. Reused from an
#                    existing install, otherwise generated and printed once.
#   ADVISOR_AGENTS   e.g. "claude,agy" — default: every supported CLI in PATH
#   ADVISOR_HOST     address to listen on — default: this machine's Tailscale IPv4
#   ADVISOR_PORT     default 8391
#   ADVISOR_CLAUDE_BIN / ADVISOR_AGY_BIN   CLI paths (resolved from PATH otherwise)
#   ADVISOR_WORKROOT default ~/mac-advisor (sessions registry + logs)
#   ADVISOR_MAX_TURNS / ADVISOR_TTL_MS / ADVISOR_TURN_TIMEOUT_MS   tuning
# The older MAC_ADVISOR_* names still work.
#
# Usage:  cd advisor-daemon && ./install.sh        (re-run after changing any of the above)
set -euo pipefail
cd "$(dirname "$0")"
umask 077 # the service file holds the token: owner-only

REPO_ROOT="$(cd .. && pwd -P)"
OS="$(uname -s)"
LABEL="com.opencode-tg.advisor"                       # launchd (macOS)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OLD_LABEL="com.tobbies.macadvisor"                     # installs before the rename
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
UNIT="opencode-advisor.service"                       # systemd --user (Linux)
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
ENV_FILE="$HOME/.config/opencode-advisor/advisor.env"

die() { echo "✗ $*" >&2; exit 1; }
# ADVISOR_<x> first, then the pre-rename MAC_ADVISOR_<x>.
pick() { local v="${!1:-}"; [ -n "$v" ] || v="${!2:-}"; printf '%s' "$v"; }

case "$OS" in
  Darwin | Linux) ;;
  *) die "chỉ hỗ trợ macOS (launchd) và Linux (systemd --user); với hệ khác chạy tay: npx tsx advisor-daemon/advisor.ts" ;;
esac

# --- node + tsx -------------------------------------------------------------
command -v node >/dev/null || die "node không có trong PATH (cần Node >= 20)"
# process.execPath is the real binary — not a per-shell shim (fnm multishell,
# nvm …) that disappears when this terminal closes.
NODE_BIN="$(node -p 'process.execPath')"
[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $("$NODE_BIN" -v) quá cũ (cần >= 20)"
[ -d "$REPO_ROOT/node_modules" ] || { echo "npm ci…"; (cd "$REPO_ROOT" && npm ci --no-fund --no-audit); }
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[ -x "$TSX_BIN" ] || die "không tìm thấy $TSX_BIN"

# --- existing install (reuse its token so the hub keeps working) ------------
existing() { # existing <VAR>: value from the current service file, if any
  if [ "$OS" = Darwin ]; then
    for p in "$PLIST" "$OLD_PLIST"; do
      [ -f "$p" ] || continue
      for k in "ADVISOR_$1" "MAC_ADVISOR_$1"; do
        /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$k" "$p" 2>/dev/null && return 0
      done
    done
  elif [ -f "$ENV_FILE" ]; then
    sed -n "s/^ADVISOR_$1=\"\(.*\)\"$/\1/p" "$ENV_FILE" | head -1
    return 0
  fi
  return 0
}

# --- token ------------------------------------------------------------------
TOKEN="$(pick ADVISOR_TOKEN MAC_ADVISOR_TOKEN)"
TOKEN_SOURCE="env"
if [ -z "$TOKEN" ]; then TOKEN="$(existing TOKEN)"; TOKEN_SOURCE="giữ từ bản cài cũ"; fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 32 2>/dev/null || od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  TOKEN_SOURCE="mới tạo"
fi
[ ${#TOKEN} -ge 16 ] || die "ADVISOR_TOKEN quá ngắn (cần >= 16 ký tự)"

# --- listen address: Tailscale only, unless told otherwise -------------------
HOST="$(pick ADVISOR_HOST MAC_ADVISOR_HOST)"
if [ -z "$HOST" ]; then
  TS_BIN="$(command -v tailscale || true)"
  [ -n "$TS_BIN" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || TS_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [ -n "$TS_BIN" ] && HOST="$("$TS_BIN" ip -4 2>/dev/null | head -1 || true)"
  [ -n "$HOST" ] || die "không lấy được IP Tailscale (Tailscale đã bật chưa?). Hoặc đặt ADVISOR_HOST=<IP> — vd 127.0.0.1 để chỉ thử trên máy này."
fi
[ "$HOST" != "0.0.0.0" ] && [ "$HOST" != "::" ] || echo "⚠ ADVISOR_HOST=$HOST mở cổng trên MỌI mạng máy này vào (Wi-Fi quán cà phê…). Chỉ token chặn — nên dùng IP Tailscale."
PORT="$(pick ADVISOR_PORT MAC_ADVISOR_PORT)"
PORT="${PORT:-8391}"

# --- agents -----------------------------------------------------------------
CLAUDE_BIN="$(pick ADVISOR_CLAUDE_BIN MAC_ADVISOR_CLAUDE_BIN)"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
AGY_BIN="${ADVISOR_AGY_BIN:-$(command -v agy || true)}"
AGENTS="$(pick ADVISOR_AGENTS MAC_ADVISOR_AGENTS)"
if [ -z "$AGENTS" ]; then
  [ -n "$CLAUDE_BIN" ] && AGENTS="claude"
  [ -n "$AGY_BIN" ] && AGENTS="${AGENTS:+$AGENTS,}agy"
  [ -n "$AGENTS" ] || die "không tìm thấy CLI nào (claude, agy) trong PATH. Cài một cái và đăng nhập, hoặc đặt ADVISOR_CLAUDE_BIN / ADVISOR_AGY_BIN."
fi
for a in $(echo "$AGENTS" | tr ',' ' '); do
  case "$a" in
    claude) [ -n "$CLAUDE_BIN" ] || die "ADVISOR_AGENTS có claude nhưng không tìm thấy 'claude' — đặt ADVISOR_CLAUDE_BIN" ;;
    agy | gemini) [ -n "$AGY_BIN" ] || die "ADVISOR_AGENTS có $a nhưng không tìm thấy 'agy' — đặt ADVISOR_AGY_BIN" ;;
    *) die "ADVISOR_AGENTS: agent '$a' không hỗ trợ (có: claude, agy)" ;;
  esac
done

WORKROOT="$(pick ADVISOR_WORKROOT MAC_ADVISOR_WORKROOT)"
WORKROOT="${WORKROOT:-$HOME/mac-advisor}"
mkdir -p "$WORKROOT/logs"

# KEY=value pairs the daemon gets (empty values are skipped).
ENV_PAIRS=(
  "ADVISOR_TOKEN=$TOKEN"
  "ADVISOR_HOST=$HOST"
  "ADVISOR_PORT=$PORT"
  "ADVISOR_AGENTS=$AGENTS"
  "ADVISOR_CLAUDE_BIN=$CLAUDE_BIN"
  "ADVISOR_AGY_BIN=$AGY_BIN"
  "ADVISOR_WORKROOT=$WORKROOT"
  "ADVISOR_MAX_TURNS=$(pick ADVISOR_MAX_TURNS MAC_ADVISOR_MAX_TURNS)"
  "ADVISOR_TTL_MS=$(pick ADVISOR_TTL_MS MAC_ADVISOR_TTL_MS)"
  "ADVISOR_TURN_TIMEOUT_MS=$(pick ADVISOR_TURN_TIMEOUT_MS MAC_ADVISOR_TURN_TIMEOUT_MS)"
  "PATH=$PATH"
  "HOME=$HOME"
)

install_macos() {
  xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  local env_xml="" kv
  for kv in "${ENV_PAIRS[@]}"; do
    [ -n "${kv#*=}" ] || continue
    env_xml+="    <key>${kv%%=*}</key><string>$(xml_escape "${kv#*=}")</string>"$'\n'
  done
  # Stop the old-named and the current agent, then write the plist.
  local l
  for l in "$OLD_LABEL" "$LABEL"; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "gui/$(id -u)/$l" >/dev/null 2>&1 || break
      sleep 0.5
    done
  done
  rm -f "$OLD_PLIST"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$TSX_BIN")</string>
    <string>$(xml_escape "$REPO_ROOT/advisor-daemon/advisor.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO_ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$WORKROOT")/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$WORKROOT")/logs/launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
${env_xml}  </dict>
</dict>
</plist>
EOF
  chmod 600 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "plist không hợp lệ: $PLIST"
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
}

install_linux() {
  command -v systemctl >/dev/null || die "không có systemctl — chạy tay: npx tsx advisor-daemon/advisor.ts (đặt các biến ADVISOR_*)"
  mkdir -p "$(dirname "$ENV_FILE")" "$(dirname "$UNIT_FILE")"
  local kv v
  : > "$ENV_FILE"
  for kv in "${ENV_PAIRS[@]}"; do
    v="${kv#*=}"
    [ -n "$v" ] || continue
    v="${v//\\/\\\\}"
    v="${v//\"/\\\"}"
    printf '%s="%s"\n' "${kv%%=*}" "$v" >> "$ENV_FILE"
  done
  chmod 600 "$ENV_FILE"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=opencode-telegram-bot advisor daemon (Claude / Gemini second opinion)
After=network-online.target

[Service]
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$ENV_FILE
ExecStart="$NODE_BIN" "$TSX_BIN" "$REPO_ROOT/advisor-daemon/advisor.ts"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null
  systemctl --user restart "$UNIT"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    echo "ℹ Để daemon chạy cả khi bạn chưa đăng nhập: sudo loginctl enable-linger $USER"
  fi
}

if [ "$OS" = Darwin ]; then install_macos; else install_linux; fi

# --- verify it came up ------------------------------------------------------
URL="http://$HOST:$PORT"
case "$HOST" in *:*) URL="http://[$HOST]:$PORT" ;; esac
HEALTH=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  HEALTH="$(curl -s -m 2 "$URL/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done

echo
if [ -n "$HEALTH" ]; then echo "✓ advisor daemon đang chạy — $HEALTH"; else echo "⚠ chưa thấy daemon trả lời ở $URL/health — xem $WORKROOT/logs/"; fi
echo "  agents:    $AGENTS"
echo "  lắng nghe: $URL"
echo "  log:       $WORKROOT/logs/advisor.log"
echo "  gỡ:        ./uninstall.sh"
echo
echo "Trên máy chạy bot (hub), thêm vào .env rồi restart bot:"
echo "  ADVISOR_URL=$URL"
if [ "$TOKEN_SOURCE" = "mới tạo" ]; then
  echo "  ADVISOR_TOKEN=$TOKEN"
  echo "  (token mới tạo — chỉ in một lần này; nó được lưu trong file service, chỉ bạn đọc được)"
else
  echo "  ADVISOR_TOKEN=<giữ nguyên token hiện có — $TOKEN_SOURCE>"
fi
echo "Kiểm tra từ hub: npm run advisor:doctor"
