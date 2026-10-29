#!/usr/bin/env bash
# Stop and remove the Claude advisor daemon launchd agent.
# (Keeps ~/mac-advisor — session registry — on disk.)
set -euo pipefail
LABEL="com.tobbies.macadvisor"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ Claude advisor daemon stopped & uninstalled (data còn ở ~/mac-advisor)"
