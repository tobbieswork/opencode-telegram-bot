#!/bin/sh
# safe-reboot — reboot the machine ONLY with a FRESH single-use token minted by
# opencode-bot (uptime-monitor reboot feature). The NOPASSWD sudoers entry
# permits THIS script, not `systemctl reboot`:
#   - a stray/static `sudo -n systemctl reboot`  -> refused by sudo (no rule)
#   - a stale/missing/mismatched token           -> refused here, logged, exit 1
# The 2026-10-23 incident (a commit message with backticks around the literal
# reboot command rebooted the box) is what this wrapper exists to prevent.
#
# Token file: $SUDO_USER's  ~/.local/state/opencode-bot/reboot-token
# Format:     one line  <64-hex-token> <epoch-ms>
# Policy:     arg == file token AND file age < TTL  -> burn file, reboot
#             anything else                          -> burn file, log, exit 1
#
# Install:
#   sudo install -m 755 deploy/safe-reboot.sh /usr/local/sbin/safe-reboot
#   (then update /etc/sudoers.d/phatnd12-maint to permit safe-reboot, not reboot)

TTL_MS=10000

log() { logger -t safe-reboot "$*"; }

if [ $# -ne 1 ]; then
	log "DENIED: expected 1 token argument, got $#"
	exit 1
fi

HOME_DIR=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)
TOKEN_FILE="$HOME_DIR/.local/state/opencode-bot/reboot-token"

if [ -z "$HOME_DIR" ] || [ ! -f "$TOKEN_FILE" ]; then
	log "DENIED: no token file for user '$SUDO_USER'"
	exit 1
fi

FILE_TOKEN=$(cut -d' ' -f1 "$TOKEN_FILE")
FILE_TS=$(cut -d' ' -f2 "$TOKEN_FILE")
NOW_MS=$(( $(date +%s%N) / 1000000 ))

# Single use: burn on every invocation, success or failure.
rm -f "$TOKEN_FILE"

if [ -n "$FILE_TS" ] && [ "$1" = "$FILE_TOKEN" ]; then
	AGE_MS=$(( NOW_MS - FILE_TS ))
	if [ "$AGE_MS" -ge 0 ] && [ "$AGE_MS" -lt "$TTL_MS" ]; then
		log "OK: reboot authorized (token age ${AGE_MS}ms)"
		exec /usr/bin/systemctl reboot
	fi
	log "DENIED: stale token (age ${AGE_MS}ms, TTL ${TTL_MS}ms)"
else
	# Deliberately do not log the argument or the file token.
	log "DENIED: token mismatch"
fi
exit 1
