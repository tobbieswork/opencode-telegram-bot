#!/usr/bin/env bash
# Install the Mac node daemon as a launchd user agent (auto-start, auto-restart).
# Usage:  cd node/mac-daemon && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd -P)"
WORKROOT="${MAC_NODE_WORKROOT:-$HOME/mac-node}"
LABEL="com.tobbies.macnode"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v node >/dev/null || { echo "✗ node không có trong PATH (cần Node >= 20)"; exit 1; }
NODE_BIN="$(command -v node)"
[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "✗ Node $("$NODE_BIN" -v) quá cũ (cần >= 20)"; exit 1; }
[ -d "$REPO_ROOT/node_modules" ] || { echo "npm ci…"; (cd "$REPO_ROOT" && npm ci --no-fund --no-audit); }
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[ -x "$TSX_BIN" ] || { echo "✗ không tìm thấy $TSX_BIN"; exit 1; }
# Resolve claude now: launchd does not read your shell profile, so a bare
# "claude" that only works in your terminal would fail inside the daemon.
CLAUDE_BIN="${MAC_NODE_CLAUDE_BIN:-$(command -v claude || true)}"
[ -n "$CLAUDE_BIN" ] || echo "⚠ không tìm thấy 'claude' — daemon sẽ fail khi chạy task. Sửa: export PATH trước khi chạy install, hoặc đặt MAC_NODE_CLAUDE_BIN=/đường/dẫn/claude"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# Only the knobs the user actually set (or resolved) go into the plist.
ENV_XML=""
for kv in "MAC_NODE_CLAUDE_BIN=$CLAUDE_BIN" \
          "MAC_NODE_POLL_MS=${MAC_NODE_POLL_MS:-}" \
          "MAC_NODE_MAX_TURNS=${MAC_NODE_MAX_TURNS:-}" \
          "MAC_NODE_TIMEOUT_MS=${MAC_NODE_TIMEOUT_MS:-}"; do
  [ -n "${kv#*=}" ] || continue
  ENV_XML+="    <key>${kv%%=*}</key><string>$(xml_escape "${kv#*=}")</string>"$'\n'
done

mkdir -p "$WORKROOT/logs"

# Stop any previous instance, then write the plist with absolute paths.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout is asynchronous — wait until the old job is gone before bootstrapping.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
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
    <string>$(xml_escape "$REPO_ROOT/node/mac-daemon/daemon.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO_ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$WORKROOT")/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$WORKROOT")/logs/launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$PATH")</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>MAC_NODE_WORKROOT</key><string>$(xml_escape "$WORKROOT")</string>
${ENV_XML}  </dict>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || { echo "✗ plist không hợp lệ: $PLIST"; exit 1; }

# One retry: right after bootout launchd can still answer "Input/output error".
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
echo "✓ Mac node daemon installed"
echo "  workroot:  $WORKROOT"
echo "  log:       $WORKROOT/logs/daemon.log   (tail -f để theo dõi)"
echo "  trạng thái: launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  gỡ:        ./uninstall.sh"
