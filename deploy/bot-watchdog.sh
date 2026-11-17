#!/usr/bin/env bash
# Bot watchdog: revive opencode-bot when it is dead or wedged.
#
# Checks, in order:
#   1. maintenance lock present -> skip (deliberate stop, e.g. state.json surgery)
#   2. service not active      -> start   (covers: interrupted stop, reboot, OOM-kill race)
#   3. journal silent >15 min  -> restart (covers: process alive but wedged)
#
# Run every 60s by bot-watchdog.timer (oneshot). Silent when healthy;
# logs only on action, so the journal stays clean.
#
# Install: see deploy/bot-watchdog.service / deploy/bot-watchdog.timer.
set -u
UNIT="opencode-bot"
LOCK="/home/phatnd12/fpt/opencode-telegram-bot/data/bot-maintenance.lock"
STALE_SINCE="15 min ago"

if [ -e "$LOCK" ]; then
  echo "[bot-watchdog] maintenance lock present, skipping"
  exit 0
fi

if ! systemctl --user is-active --quiet "$UNIT"; then
  echo "[bot-watchdog] $UNIT not active -> starting"
  if systemctl --user start "$UNIT"; then
    echo "[bot-watchdog] started"
  else
    echo "[bot-watchdog] start FAILED"
  fi
  exit 0
fi

if [ -z "$(journalctl --user -u "$UNIT" --since "$STALE_SINCE" --quiet -n 1 2>/dev/null)" ]; then
  echo "[bot-watchdog] journal silent for >15 min (wedged?) -> restarting"
  if systemctl --user restart "$UNIT"; then
    echo "[bot-watchdog] restarted"
  else
    echo "[bot-watchdog] restart FAILED"
  fi
fi
exit 0
