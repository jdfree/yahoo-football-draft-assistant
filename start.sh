#!/usr/bin/env bash
#
# Start the draft assistant.
#
#   ./start.sh          serve on 8765 and print what to paste into the draft room
#   ./start.sh 9000     use a different port
#   ./start.sh stop     stop a running server and exit
#
# Stops any server already on the port first, so re-running this is always safe:
# a stale server left over from an earlier draft is the usual reason the page
# hangs while fetching.
set -uo pipefail
cd "$(dirname "$0")"

MODE="run"
PORT=8765
case "${1:-}" in
  stop)     MODE="stop" ;;
  ""|*[!0-9]*) [ -n "${1:-}" ] && { echo "usage: $0 [port|stop]" >&2; exit 2; } ;;
  *)        PORT="$1" ;;
esac
[ "$MODE" = "stop" ] && PORT="${2:-8765}"

listeners() { lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null; }

pids=$(listeners)
if [ -n "$pids" ]; then
  echo "stopping server on port $PORT (pid $(echo "$pids" | tr '\n' ' '))"
  kill $pids 2>/dev/null
  sleep 1
  pids=$(listeners)
  [ -n "$pids" ] && { kill -9 $pids 2>/dev/null; sleep 1; }
elif [ "$MODE" = "stop" ]; then
  echo "nothing running on port $PORT"
fi
[ "$MODE" = "stop" ] && exit 0

cat <<TXT

  Draft assistant — serving on http://localhost:$PORT
  Stop it with Ctrl-C, or ./start.sh stop

  EASIEST — make a bookmark once, click it in every draft. No console, and no
  "allow pasting" prompt. Create a bookmark and paste this as the URL:

     javascript:(function(){var s=document.createElement('script');s.src='http://localhost:$PORT/bootstrap.js';document.body.appendChild(s);})()

  Then: open your draft room, wait for the board, click the bookmark.

  OR from the console (F12), paste the same thing without the javascript: prefix:

     var s=document.createElement('script');s.src='http://localhost:$PORT/bootstrap.js';document.body.appendChild(s);

  Brave and Chrome make you type  allow pasting  into the console once before
  they accept a paste. Brave may also ask permission to reach localhost — allow
  it, or open Shields and allow localhost for the Yahoo tab.

  That is all. It runs live, and your slot and league size are read from the
  room, so there is nothing to configure. It manages the queue and never drafts
  for you, except to stop back-to-back picks doubling up on one position.

  To watch without touching the queue, run this BEFORE loading it:
     window.YS_CONFIG={DRY_RUN:true};

TXT

exec python3 serve.py "$PORT"
