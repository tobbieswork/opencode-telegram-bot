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
[ -d "$REPO_ROOT/node_modules" ] || (echo "npm install…"; (cd "$REPO_ROOT" && npm install --no-fund --no-audit))
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[ -x "$TSX_BIN" ] || { echo "✗ không tìm thấy $TSX_BIN"; exit 1; }
command -v claude >/dev/null || echo "⚠ 'claude' chưa có trong PATH của launchd — daemon sẽ fail khi chạy task. Sửa: export PATH trước khi chạy install, hoặc đặt MAC_NODE_CLAUDE_BIN=/đường/dẫn/claude"

mkdir -p "$WORKROOT/logs"

# Stop any previous instance, then write the plist with absolute paths.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_BIN</string>
    <string>$REPO_ROOT/node/mac-daemon/daemon.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$WORKROOT/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$WORKROOT/logs/launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>MAC_NODE_WORKROOT</key><string>$WORKROOT</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ Mac node daemon installed"
echo "  workroot:  $WORKROOT"
echo "  log:       $WORKROOT/logs/daemon.log   (tail -f để theo dõi)"
echo "  trạng thái: launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  gỡ:        ./uninstall.sh"
