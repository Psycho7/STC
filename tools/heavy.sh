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
# A leaked child (say, a Chromium left behind by a killed capture) keeps its
# slot until it dies. A waiter therefore names the holders instead of waiting
# silently, and gives up once no legitimate queue would still be ahead of it.
REPORT_EVERY_SECONDS=600
MAX_WAIT_SECONDS=3600
EX_TEMPFAIL=75

[[ $# -gt 0 ]] || { echo "usage: tools/heavy.sh <command> [args...]" >&2; exit 64; }
# Without flock every slot would read as busy and the loop would wait forever.
command -v flock >/dev/null || { echo "tools/heavy.sh: needs flock" >&2; exit 127; }

report_holders() {
  echo "tools/heavy.sh: all $SLOTS slots busy after ${1}s; holders:" >&2
  fuser -v "$LOCK_PREFIX".*.lock 2>&1 | sed 's/^/  /' >&2
}

waited=0
while :; do
  for ((slot = 0; slot < SLOTS; slot++)); do
    exec {fd}>"$LOCK_PREFIX.$slot.lock"
    if flock -n "$fd"; then
      "$@"
      exit $?
    fi
    exec {fd}>&-
  done

  if ((waited % REPORT_EVERY_SECONDS == 0)); then
    report_holders "$waited"
  fi
  if ((waited >= MAX_WAIT_SECONDS)); then
    echo "tools/heavy.sh: gave up after ${waited}s; not running: $*" >&2
    exit "$EX_TEMPFAIL"
  fi

  sleep "$POLL_SECONDS"
  ((waited += POLL_SECONDS))
done
