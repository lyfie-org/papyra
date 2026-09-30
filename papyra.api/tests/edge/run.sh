#!/usr/bin/env bash
# Runs every suite and reports one verdict. Non-zero if any failed.
#
#   ./run.sh
#   PAPYRA_BASE=http://localhost:8080 ./run.sh

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

bash "$HERE/edge.sh";  CORE=$?
bash "$HERE/edge2.sh"; SEC=$?
bash "$HERE/media.sh"; MEDIA=$?

echo
if [ "$CORE" -eq 0 ] && [ "$SEC" -eq 0 ] && [ "$MEDIA" -eq 0 ]; then
  echo "edge harness: all suites green"
  exit 0
fi

[ "$CORE" -ne 0 ] && echo "edge.sh failed (exit $CORE)"
[ "$SEC"  -ne 0 ] && echo "edge2.sh failed (exit $SEC)"
[ "$MEDIA" -ne 0 ] && echo "media.sh failed (exit $MEDIA)"
exit 1
