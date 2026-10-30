#!/usr/bin/env bash
# Stop and remove the advisor daemon service (launchd on macOS, systemd --user
# on Linux) and its service file, which holds the token. Keeps the workroot
# (~/mac-advisor — sessions registry + logs) on disk.
set -euo pipefail
if [ "$(uname -s)" = Darwin ]; then
  for LABEL in com.opencode-tg.advisor com.tobbies.macadvisor; do
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  done
else
  systemctl --user disable --now opencode-advisor.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/opencode-advisor.service" "$HOME/.config/opencode-advisor/advisor.env"
  systemctl --user daemon-reload 2>/dev/null || true
fi
echo "✓ advisor daemon stopped & uninstalled (data còn ở ~/mac-advisor)"
