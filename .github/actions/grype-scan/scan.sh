#!/usr/bin/env bash
set -euo pipefail

: "${TARGET:?}" "${LABEL:?}" "${GRYPE_IMAGE:?}" "${RUNNER_TEMP:?}"

OUT="$RUNNER_TEMP/grype-$LABEL"
CACHE="$RUNNER_TEMP/grype-cache"
mkdir -p "$OUT" "$CACHE"

docker run --rm \
  -e GRYPE_CHECK_FOR_APP_UPDATE=false \
  -v "$CACHE:/root/.cache" \
  -v "$OUT:/out" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$GRYPE_IMAGE" "docker:$TARGET" \
  -o json=/out/report.json \
  -o table=/out/report.txt

if command -v sudo >/dev/null 2>&1; then
  sudo chown -R "$(id -u):$(id -g)" "$OUT"
fi

echo "dir=$OUT" >> "${GITHUB_OUTPUT:-/dev/null}"
