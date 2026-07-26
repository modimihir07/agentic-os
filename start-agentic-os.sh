#!/usr/bin/env bash
# Agentic OS server launcher — idempotent + fully detached.
# Safe to run repeatedly: if the server is already listening it does nothing.
# This is the FALLBACK path used only when systemd is unavailable
# (e.g. a WSL instance that hasn't started the user session).
set -u

DIR="/home/austin/agentic-os"
LOG="/tmp/agentic-os.log"
PIDFILE="$DIR/.agentic-os.pid"
HOST="0.0.0.0"
PORT="$(python3 -c "import json;print(json.load(open('data/settings.json')).get('dashboard',{}).get('port',8080))" 2>/dev/null || echo 8080)"

# Already serving? Then do nothing (idempotent).
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "Agentic OS already listening on :$PORT — nothing to do."
  exit 0
fi

cd "$DIR" || { echo "FATAL: cannot cd to $DIR"; exit 1; }

# Remove a stale pidfile if its process is no longer alive.
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$OLD" ] && ! kill -0 "$OLD" 2>/dev/null; then
    rm -f "$PIDFILE"
  fi
fi

# setsid detaches into a new session so the server outlives the launching
# shell (cron tick, session end, terminal close).
setsid python3 server.py >> "$LOG" 2>&1 < /dev/null &
echo "$!" > "$PIDFILE"
echo "Launched Agentic OS (pid $(cat "$PIDFILE")) — log: $LOG"

# Brief wait, then verify it actually came up.
sleep 4
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "OK: serving on http://$HOST:$PORT"
else
  echo "WARN: not listening after 4s — tail of $LOG:"
  tail -15 "$LOG"
fi
