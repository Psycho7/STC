#!/usr/bin/env bash
# Runs a command once one of the machine-wide heavy-command slots is free, so
# agents working in separate worktrees never run more than SLOTS of the
# commands routed through it at once. Usage: tools/heavy.sh <command> [args...]
#
# The command inherits the slot's lock, so the slot stays taken for as long as
# anything it started is alive: a killed wrapper or a process left running in
# the background still holds memory, and still holds the slot.
set -u

SLOTS=2
# Fixed /tmp rather than $TMPDIR: agent sessions can point TMPDIR at private
# scratch dirs, and the slots only work if every session sees the same files.
LOCK_PREFIX=/tmp/stc-heavy
POLL_SECONDS=2

[[ $# -gt 0 ]] || { echo "usage: tools/heavy.sh <command> [args...]" >&2; exit 64; }
# Without flock every slot would read as busy and the loop would wait forever.
command -v flock >/dev/null || { echo "tools/heavy.sh: needs flock" >&2; exit 127; }

while :; do
  for ((slot = 0; slot < SLOTS; slot++)); do
    exec {fd}>"$LOCK_PREFIX.$slot.lock"
    if flock -n "$fd"; then
      "$@"
      exit $?
    fi
    exec {fd}>&-
  done
  sleep "$POLL_SECONDS"
done
