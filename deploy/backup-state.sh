#!/usr/bin/env bash
# OpenCode bot state backup: one snapshot of the durable data/ files into a
# private GitHub repo, keeping the newest 7 generations. Driven nightly by
# backup-state.timer (03:30); safe to run by hand at any time.
#
# Backed up (from DATA_DIR):
#   - every top-level *.json EXCEPT *.bak*  (state.json, users.json,
#     schedules.json, rotation-health.json, ... — new state files are
#     picked up automatically)
#   - notes/  (user notes)
# NOT backed up: audit.log (a log, not state) and the cache/artifact dirs
# (figma/, node/, manager/, research/, ai-improve/, uploads/).
#
# Remote repo layout (one immutable generation per backup):
#   snapshots/<YYYY-MM-DDTHH-MM-SSZ>/{*.json, notes/}
#   README.md  (restore instructions)
#
# Usage:
#   backup-state.sh                  # snapshot: copy -> validate -> commit -> push -> prune
#   backup-state.sh restore [TS] DEST
#                                   # extract the latest (or TS) snapshot into DEST
#
# Env overrides (used by scripts/test-backup-state.ts):
#   STATE_BACKUP_DATA_DIR    default /home/phatnd12/fpt/opencode-telegram-bot/data
#   STATE_BACKUP_REMOTE      default https://github.com/tobbieswork/opencode-bot-state.git
#   STATE_BACKUP_CACHE       default $HOME/.cache/opencode-bot/backup-state-remote
#   STATE_BACKUP_KEEP        default 7
#   STATE_BACKUP_TIMESTAMP   default current UTC time
#
# Install:
#   cp deploy/backup-state.service deploy/backup-state.timer ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now backup-state.timer
#
# Restore (full steps):
#   systemctl --user stop opencode-bot            # or touch data/bot-maintenance.lock
#   backup-state.sh restore [TS] /home/phatnd12/fpt/opencode-telegram-bot/data
#   jq -e . /home/phatnd12/fpt/opencode-telegram-bot/data/state.json >/dev/null
#   systemctl --user start opencode-bot
set -euo pipefail

DATA_DIR="${STATE_BACKUP_DATA_DIR:-/home/phatnd12/fpt/opencode-telegram-bot/data}"
REMOTE="${STATE_BACKUP_REMOTE:-https://github.com/tobbieswork/opencode-bot-state.git}"
CACHE="${STATE_BACKUP_CACHE:-$HOME/.cache/opencode-bot/backup-state-remote}"
KEEP="${STATE_BACKUP_KEEP:-7}"
TS="${STATE_BACKUP_TIMESTAMP:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"

GIT=(git)
CRED_FILE=""

cleanup() { [ -n "$CRED_FILE" ] && rm -f "$CRED_FILE" || true; }
trap cleanup EXIT

die() { echo "[backup-state] ERROR: $*" >&2; exit 1; }

# ── auth: only https GitHub remotes need a token; file:// / ssh run as-is ─────
setup_auth() {
  case "$REMOTE" in
    http://github.com/*|https://github.com/*)
      command -v gh >/dev/null || die "gh not found (needed for GitHub auth)"
      TOKEN="$(gh auth token 2>/dev/null)" || die "gh auth token failed — run: gh auth login"
      [ -n "$TOKEN" ] || die "empty token from gh auth token"
      CRED_FILE="$CACHE.git-credentials"
      mkdir -p "$CACHE"
      (umask 077 && printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > "$CRED_FILE")
      GIT=(git -c "credential.helper=store --file=$CRED_FILE")
      ;;
  esac
}

# ── keep a local clone of the remote in $CACHE ────────────────────────────────
sync_cache() {
  mkdir -p "$CACHE"
  if [ -d "$CACHE/.git" ]; then
    "${GIT[@]}" -C "$CACHE" fetch origin -q || die "git fetch failed"
    "${GIT[@]}" -C "$CACHE" reset --hard -q origin/main || die "git reset to origin/main failed"
    return 0
  fi
  rm -rf "$CACHE"
  if "${GIT[@]}" ls-remote --heads "$REMOTE" 2>/dev/null | grep -q "refs/heads/main"; then
    "${GIT[@]}" clone -q "$REMOTE" "$CACHE" || die "git clone failed"
  else
    # Remote has no main yet: create it (GitHub only), then start fresh.
    case "$REMOTE" in
      https://github.com/*)
        local slug="${REMOTE#https://github.com/}"
        slug="${slug%.git}"
        if ! gh repo view "$slug" >/dev/null 2>&1; then
          gh repo create "$slug" --private >/dev/null || die "gh repo create $slug failed"
        fi
        ;;
    esac
    git init -q -b main "$CACHE"
    git -C "$CACHE" remote add origin "$REMOTE"
  fi
  git -C "$CACHE" config user.name "opencode-bot (state backup)"
  git -C "$CACHE" config user.email "opencode-bot-backup@noreply.local"
}

# ── copy the durable files into snapshots/<TS>/ ──────────────────────────────
take_snapshot() {
  [ -d "$DATA_DIR" ] || die "data dir not found: $DATA_DIR"
  local snap="$CACHE/snapshots/$TS"
  rm -rf "$snap"
  mkdir -p "$snap"

  local f b copied=0
  for f in "$DATA_DIR"/*.json; do
    [ -e "$f" ] || continue
    b="${f##*/}"
    case "$b" in *.bak*) continue ;; esac
    cp -p "$f" "$snap/$b"
    copied=$((copied + 1))
  done
  [ "$copied" -gt 0 ] || die "no state files found in $DATA_DIR (data dir layout changed?)"
  [ -d "$DATA_DIR/notes" ] && cp -rp "$DATA_DIR/notes" "$snap/notes"

  # state.json is written atomically by the bot (tmp + rename), so cp cannot
  # catch a partial file — but refuse to back up corrupt JSON anyway.
  local j
  for j in "$snap"/*.json; do
    [ -e "$j" ] || continue
    jq empty "$j" >/dev/null 2>&1 || die "refusing to back up invalid JSON: ${j##*/}"
  done
}

seed_readme() {
  [ -f "$CACHE/README.md" ] && return 0
  cat > "$CACHE/README.md" <<'README'
# opencode-bot-state

Nightly state backup of the OpenCode Telegram bot, written by
`deploy/backup-state.sh` on the bot box (systemd user timer
`backup-state.timer`, daily at 03:30 local). **Private repo** — contains
session and personal data. Do not edit files here; generations are immutable.

## Layout

    snapshots/<UTC timestamp>/      one generation per backup
      state.json  users.json  schedules.json  rotation-health.json
      notes/
    README.md

The newest 7 generations are kept; older ones are pruned by the backup job.

## Restore

    # 1. stop the bot (or `touch data/bot-maintenance.lock` so the watchdog
    #    does not restart it mid-surgery)
    systemctl --user stop opencode-bot

    # 2. extract a generation into the data dir (latest, or a specific one)
    /home/phatnd12/fpt/opencode-telegram-bot/deploy/backup-state.sh \
        restore [2026-11-19T03-30-00Z] /home/phatnd12/fpt/opencode-telegram-bot/data

    # 3. verify, then start the bot
    jq -e . /home/phatnd12/fpt/opencode-telegram-bot/data/state.json >/dev/null
    systemctl --user start opencode-bot

Restore copies the generation's files over `data/`; files that are not part of
the generation are left untouched.
README
}

# ── drop tracked generations beyond the newest $KEEP ─────────────────────────
prune_local() {
  git -C "$CACHE" rev-parse --verify -q HEAD >/dev/null 2>&1 || return 0
  local gens n g
  gens="$(ls -1 "$CACHE/snapshots" 2>/dev/null | sort)"
  [ -n "$gens" ] || return 0
  n="$(printf '%s\n' "$gens" | wc -l)"
  [ "$n" -gt "$KEEP" ] || return 0
  while IFS= read -r g; do
    [ -n "$g" ] && git -C "$CACHE" rm -rq "snapshots/$g"
  done <<< "$(printf '%s\n' "$gens" | head -n $((n - KEEP)))"
}

do_restore() {
  local a="${1:-}" b="${2:-}"
  local ts_arg="" dest=""
  if [ -n "$b" ]; then
    case "$a" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*) ts_arg="$a"; dest="$b" ;;
      *) die "invalid TIMESTAMP: $a (expected YYYY-MM-DDTHH-MM-SSZ, e.g. 2026-11-19T03-30-00Z)" ;;
    esac
  else
    dest="$a"
  fi
  [ -n "$dest" ] || die "usage: $0 restore [TIMESTAMP] DEST"
  setup_auth
  sync_cache
  [ -n "$ts_arg" ] || ts_arg="$(ls -1 "$CACHE/snapshots" 2>/dev/null | sort | tail -n 1)"
  [ -n "$ts_arg" ] || die "no snapshots in $REMOTE"
  [ -d "$CACHE/snapshots/$ts_arg" ] || die "snapshot not found: $ts_arg (available: $(ls -1 "$CACHE/snapshots" 2>/dev/null | sort | tr '\n' ' '))"
  mkdir -p "$dest"
  cp -rp "$CACHE/snapshots/$ts_arg/." "$dest/"
  echo "[backup-state] restored $ts_arg -> $dest"
}

case "${1:-}" in
  "")
    setup_auth
    sync_cache
    take_snapshot
    seed_readme
    prune_local
    "${GIT[@]}" -C "$CACHE" add -A
    if ! "${GIT[@]}" -C "$CACHE" diff --cached --quiet; then
      "${GIT[@]}" -C "$CACHE" commit -q -m "snapshot: $TS"
      branch="$(git -C "$CACHE" branch --show-current)"
      "${GIT[@]}" -C "$CACHE" push -q -u origin "$branch" || die "git push failed"
      echo "[backup-state] snapshot $TS pushed to $REMOTE"
    else
      echo "[backup-state] $TS unchanged, nothing to push"
    fi
    ;;
  restore)
    shift
    do_restore "$@"
    ;;
  *)
    die "unknown subcommand: $1 (expected: none, or restore)"
    ;;
esac
