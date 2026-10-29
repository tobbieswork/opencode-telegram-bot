#!/usr/bin/env bash
# Stop and remove the Mac node daemon launchd agent.
# (Keeps ~/mac-node — data, reports, and the private repo clone — on disk.)
set -euo pipefail
LABEL="com.tobbies.macnode"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ Mac node daemon stopped & uninstalled (data còn ở ~/mac-node)"
