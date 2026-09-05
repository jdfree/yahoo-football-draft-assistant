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

  EASIEST — make a bookmark once, then click it in every draft.

  This will NOT work if you paste it into the address bar: Chrome strips the
  "javascript:" prefix and searches for the rest. It has to go in a BOOKMARK.

    1. Show the bookmarks bar:  Cmd-Shift-B  (Ctrl-Shift-B on Windows/Linux)
    2. Right-click an empty spot on that bar, choose "Add page..."
    3. Name it anything, e.g.  Draft assistant
    4. Paste this as the URL, then Save:

     javascript:(function(){var s=document.createElement('script');s.src='http://localhost:$PORT/bootstrap.js';document.body.appendChild(s);})()

    If the Add-page dialog strips the prefix too, save it with any placeholder
    URL, then right-click the bookmark, choose Edit, and paste there instead.

  Then: open your draft room, wait for the board, click the bookmark, and click
  "Allow" when Chrome asks for permission to reach localhost.

  OR from the console (F12), paste the same thing without the javascript: prefix:

     var s=document.createElement('script');s.src='http://localhost:$PORT/bootstrap.js';document.body.appendChild(s);

  Chrome makes you type  allow pasting  into the console once before it accepts
  a paste. The bookmark route skips that.

  That is all. It runs live, and your slot and league size are read from the
  room, so there is nothing to configure. It manages the queue and never drafts
  for you, except to stop back-to-back picks doubling up on one position.

  To watch without touching the queue, run this BEFORE loading it:
     window.YS_CONFIG={DRY_RUN:true};

TXT

exec python3 serve.py "$PORT"
