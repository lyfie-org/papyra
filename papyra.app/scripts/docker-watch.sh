#!/usr/bin/env bash
# Rebuild the website image and restart its container whenever the site changes.
#
#   bash papyra.app/scripts/docker-watch.sh start    # run in the background
#   bash papyra.app/scripts/docker-watch.sh status
#   bash papyra.app/scripts/docker-watch.sh stop
#   bash papyra.app/scripts/docker-watch.sh run      # in the foreground (Ctrl+C to quit)
#
# Watches what the image is built from: papyra.app (minus build output), papyra.web
# (the in-browser demo), CHANGELOG.md, CONTRIBUTING.md and VERSION. It polls file
# modification times rather than relying on inotify, so it works on any mount.
# Edits are given a few seconds to settle, the new image is built BEFORE the old
# container is replaced, and a failed build leaves the running site untouched.
#
# Settings (environment): SITE_PORT (4321), SITE_BIND (127.0.0.1), SITE_IMAGE
# (papyra-site:local), SITE_CONTAINER (papyra-site), SITE_SETTLE seconds (5),
# SITE_POLL seconds (3).

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${SITE_IMAGE:-papyra-site:local}"
CONTAINER="${SITE_CONTAINER:-papyra-site}"
PORT="${SITE_PORT:-4321}"
BIND="${SITE_BIND:-127.0.0.1}"
SETTLE="${SITE_SETTLE:-5}"
POLL="${SITE_POLL:-3}"

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/papyra-site-watch"
PIDFILE="$STATE/pid"
LOG="$STATE/watch.log"
mkdir -p "$STATE"

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }

# One fingerprint of every watched file's path, size and modification time.
fingerprint() {
  (
    cd "$ROOT" || exit 1
    {
      find papyra.app papyra.web \
        \( -name node_modules -o -name dist -o -name .astro -o -path papyra.app/public/demo \) -prune -o \
        -type f -printf '%p %s %T@\n'
      for f in CHANGELOG.md CONTRIBUTING.md VERSION; do
        [ -f "$f" ] && stat -c '%n %s %Y' "$f"
      done
    } | sort | md5sum | cut -d' ' -f1
  )
}

rebuild() {
  log "building $IMAGE ..."
  if ! (cd "$ROOT" && DOCKER_BUILDKIT=1 docker build -q -f papyra.app/Dockerfile -t "$IMAGE" . >/dev/null); then
    log "BUILD FAILED, the running site is unchanged. Fix the error and save again; run the docker build by hand to see it."
    return 1
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if docker run -d --name "$CONTAINER" --restart unless-stopped -p "$BIND:$PORT:80" "$IMAGE" >/dev/null; then
    log "site updated: http://$BIND:$PORT"
  else
    log "could not start the container (is port $PORT in use?)"
    return 1
  fi
}

run() {
  log "watching $ROOT (image $IMAGE, port $PORT)"
  last=""
  # Build once at the start only if there is no running container yet.
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    rebuild
  fi
  last="$(fingerprint)"
  while true; do
    sleep "$POLL"
    now="$(fingerprint)"
    [ "$now" = "$last" ] && continue
    # Something changed: wait until it has stopped changing for $SETTLE seconds.
    while true; do
      sleep "$SETTLE"
      again="$(fingerprint)"
      [ "$again" = "$now" ] && break
      now="$again"
    done
    log "change detected"
    rebuild
    last="$(fingerprint)"
  done
}

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE")"
  # Only ours if the process is still this script.
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q 'docker-watch.sh' "/proc/$pid/cmdline" 2>/dev/null && echo "$pid"
}

case "${1:-run}" in
  run) run ;;
  start)
    if pid="$(running_pid)"; then echo "already watching (pid $pid), log: $LOG"; exit 0; fi
    setsid nohup bash "${BASH_SOURCE[0]}" run >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "watching in the background (pid $!), log: $LOG"
    ;;
  stop)
    if pid="$(running_pid)"; then kill "$pid" && rm -f "$PIDFILE" && echo "stopped (pid $pid)"; else echo "not running"; fi
    ;;
  status)
    if pid="$(running_pid)"; then echo "watching (pid $pid), log: $LOG"; tail -n 5 "$LOG" 2>/dev/null; else echo "not running"; fi
    ;;
  *) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
