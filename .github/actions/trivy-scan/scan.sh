#!/usr/bin/env bash
set -euo pipefail

: "${TARGET:?}" "${KIND:?}" "${LABEL:?}" "${TRIVY_IMAGE:?}"
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}"

OUT="$RUNNER_TEMP/trivy-$LABEL"
CACHE="$RUNNER_TEMP/trivy-cache"
mkdir -p "$OUT" "$CACHE"

export TRIVY_DB_REPOSITORY="${TRIVY_DB_REPOSITORY:-public.ecr.aws/aquasecurity/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2}"

docker_args=(--rm
  -e TRIVY_DB_REPOSITORY
  -e TRIVY_SKIP_JAVA_DB_UPDATE=true
  -e TRIVY_NO_PROGRESS=true
  -v "$CACHE:/root/.cache"
  -v "$OUT:/out"
  -v "$GITHUB_WORKSPACE:/ws:ro")

scan_args=(--scanners vuln)
if [ -f "$GITHUB_WORKSPACE/.trivyignore" ]; then
  scan_args+=(--ignorefile /ws/.trivyignore)
fi

if [ "$KIND" = "image" ]; then
  docker_args+=(-v /var/run/docker.sock:/var/run/docker.sock)
  subject="$TARGET"
else
  subject="/ws"
fi

trivy() { docker run "${docker_args[@]}" "$TRIVY_IMAGE" "$@"; }

trivy "$KIND" "${scan_args[@]}" --format json --output /out/report.json "$subject"
trivy convert --format table --output /out/report.txt /out/report.json
trivy "$KIND" "${scan_args[@]}" --format cyclonedx --output /out/sbom.cdx.json "$subject"

if command -v sudo >/dev/null 2>&1; then
  sudo chown -R "$(id -u):$(id -g)" "$OUT"
fi

echo "dir=$OUT" >> "${GITHUB_OUTPUT:-/dev/null}"
