#!/usr/bin/env bash
# Runs both suites and reports one verdict. Non-zero if either failed.
#
#   ./run.sh
#   PAPYRA_BASE=http://localhost:8080 ./run.sh

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

bash "$HERE/edge.sh";  CORE=$?
bash "$HERE/edge2.sh"; SEC=$?

echo
if [ "$CORE" -eq 0 ] && [ "$SEC" -eq 0 ]; then
  echo "edge harness: both suites green"
  exit 0
fi

[ "$CORE" -ne 0 ] && echo "edge.sh failed (exit $CORE)"
[ "$SEC"  -ne 0 ] && echo "edge2.sh failed (exit $SEC)"
exit 1
