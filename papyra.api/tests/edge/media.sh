#!/usr/bin/env bash
#
# media.sh — attachments, end to end over real HTTP.
#
# Uploads are served from Papyra's own origin, so these are security checks as
# much as feature checks: what the bytes are decides how a file is stored and
# served (never the name), active content can never run as the app, a share
# link reaches only its own note's files, and a locked note's pictures stay in
# the vault.
#
#   ./media.sh
#   PAPYRA_BASE=http://localhost:8080 ./media.sh
#
# See lib.sh for the safety rules. Everything written is prefixed and removed.

SUITE_NAME="media.sh — attachments and how they are served"
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

preflight
ensure_account "$QA_USER" User "$JAR_QA"
QA_ID="$(me_id "$JAR_QA")"
[ -n "$QA_ID" ] || abort "Could not read a tenant id from /api/auth/me — refusing to continue."

HEADERS="$WORK/headers.txt"
NOTE="$EDGE_PREFIX-media"
OTHER="$EDGE_PREFIX-media-other"

trap teardown EXIT
cleanup_named "$JAR_QA"

# upload <jar> <local-file> <as-name> — leaves the stored name in $UPLOADED.
upload() {
  STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -b "$1" -c "$1" --max-time 60 \
    -F "file=@$(winpath "$2");filename=$3" "$BASE/api/media/upload" 2>>"$WORK/curl.err")"
  UPLOADED="$(jget filename)"
}

# fetch <jar> <path> — GET with response headers captured to $HEADERS.
fetch() {
  STATUS="$(curl -sS -o "$BODY_FILE" -D "$HEADERS" -w '%{http_code}' -b "$1" -c "$1" --max-time 30 \
    "$BASE$2" 2>>"$WORK/curl.err")"
}

header_has() {
  if grep -qi -- "$2" "$HEADERS"; then pass "$1"
  else fail "$1" "headers lacked '$2' — $(tr -d '\r' < "$HEADERS" | tr '\n' ' ' | head -c 300)"; fi
}

header_lacks() {
  if grep -qi -- "$2" "$HEADERS"; then fail "$1" "headers contained '$2' and must not"
  else pass "$1"; fi
}

# ── What gets stored ─────────────────────────────────────────────────────────
section "The bytes decide what a file is"

printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdacd`\x00\x00\x00\x06\x00\x020\x81\xd0/\x00\x00\x00\x00IEND\xaeB`\x82' > "$WORK/pic.bin"
upload "$JAR_QA" "$WORK/pic.bin" "holiday.jpeg"
eq "an image uploads" "$STATUS" "200"
PIC="$UPLOADED"
case "$PIC" in *.png) pass "…stored under the extension its bytes prove (.png)" ;;
  *) fail "…stored under the extension its bytes prove (.png)" "got '$PIC'" ;; esac

printf '<html><script>alert(document.cookie)</script></html>' > "$WORK/page.html"
upload "$JAR_QA" "$WORK/page.html" "innocent.png"
eq "a page renamed .png still uploads" "$STATUS" "200"
PAGE="$UPLOADED"
case "$PAGE" in *.txt) pass "…but is stored as inert text" ;;
  *) fail "…but is stored as inert text" "got '$PAGE'" ;; esac

printf 'unused' > "$WORK/other.txt"
upload "$JAR_QA" "$WORK/other.txt" "other.txt"
UNUSED="$UPLOADED"

# ── How it is served ─────────────────────────────────────────────────────────
section "How attachments are served"

fetch "$JAR_QA" "/api/media/$PIC"
eq "the picture reads back" "$STATUS" "200"
header_has "as image/png" "content-type: image/png"
header_has "with nosniff" "x-content-type-options: nosniff"
header_has "privately cacheable" "cache-control: private"
header_has "with a validator" "etag:"
header_lacks "and inline (no download prompt)" "content-disposition"

fetch "$JAR_QA" "/api/media/$PAGE"
eq "the uploaded page reads back" "$STATUS" "200"
header_has "as plain text" "content-type: text/plain"
header_has "under a sandboxed, script-free policy" "content-security-policy: sandbox; default-src 'none'"

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_QA" -H 'Range: bytes=0-7' "$BASE/api/media/$PIC")"
eq "byte ranges work (video seeking)" "$STATUS" "206"

# ── Streaming, thumbnails, metadata ─────────────────────────────────────────
section "Uploads stream; pictures get thumbnails and metadata"

fetch "$JAR_QA" "/api/media/$PIC/meta"
eq "metadata for the picture" "$STATUS" "200"
body_has "…with its shape" '"width":1'
fetch "$JAR_QA" "/api/media/$PIC/thumb?w=320"
eq "a thumbnail for the picture" "$STATUS" "200"
header_has "…as WebP" "content-type: image/webp"
fetch "$JAR_QA" "/api/media/$PAGE/thumb"
eq "no thumbnail for a text file" "$STATUS" "404"
header_has "…and says why" "x-papyra-reason: unsupported"

# Opaque bytes are a generic file: 50 MB allowed, refused as they stream past it.
head -c $((40 * 1024 * 1024)) /dev/zero > "$WORK/40mb.bin"
upload "$JAR_QA" "$WORK/40mb.bin" "big.bin"
eq "a 40 MB file uploads (above Kestrel's 28.6 MB default)" "$STATUS" "200"
head -c $((60 * 1024 * 1024)) /dev/zero > "$WORK/60mb.bin"
upload "$JAR_QA" "$WORK/60mb.bin" "bigger.mp4"
eq "a 60 MB file named .mp4 is refused (it isn't a video)" "$STATUS" "413"
rm -f "$WORK/40mb.bin" "$WORK/60mb.bin"

# ── Share links ──────────────────────────────────────────────────────────────
section "A share link reaches only its own note's files"

check "a note embedding the picture" 200 "$JAR_QA" PUT "/api/notes/$NOTE" \
  "{\"title\":\"media\",\"tags\":[],\"pinned\":false,\"archived\":false,\"body\":\"![[${PIC}|300]]\"}"
check "a second note with its own file" 200 "$JAR_QA" PUT "/api/notes/$OTHER" \
  "{\"title\":\"other\",\"tags\":[],\"pinned\":false,\"archived\":false,\"body\":\"![[${UNUSED}]]\"}"
check "share the first by link" 200 "$JAR_QA" POST "/api/notes/$NOTE/shares" '{"kind":"link","access":"view"}'
TOKEN="$(jget token)"
SHARE_ID="$(jget id)"
[ -n "$SHARE_ID" ] && track qa shares "$SHARE_ID"

fetch "$JAR_NONE" "/api/shared/$TOKEN/media/$PIC"
eq "the shared note's picture is readable by link" "$STATUS" "200"
header_has "…revalidated every time" "cache-control: private, no-cache"
check "another note's file is not" 404 "$JAR_NONE" GET "/api/shared/$TOKEN/media/$UNUSED"
check "nor an unreferenced upload" 404 "$JAR_NONE" GET "/api/shared/$TOKEN/media/$PAGE"
check_in "nor a traversal" "400 404" "$JAR_NONE" GET "/api/shared/$TOKEN/media/..%2F..%2Fappsettings.json"

# ── Anonymous ────────────────────────────────────────────────────────────────
section "Nothing without a session"
check "anonymous /api/media is refused" 401 "$JAR_NONE" GET "/api/media/$PIC"

finish
