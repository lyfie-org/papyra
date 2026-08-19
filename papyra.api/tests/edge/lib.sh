# shellcheck shell=bash
# Shared plumbing for the Papyra edge harnesses (edge.sh, edge2.sh).
#
# These are black-box HTTP checks against a *running* instance. `dotnet test`
# proves the code; this proves the deployed surface — routing, auth policies,
# cookies, per-tenant isolation, and the status codes a real client actually
# receives. It is the fastest regression signal in the project.
#
# ── SAFETY. Read this before editing anything below. ─────────────────────────
#
#  1. Tenant ids are ALWAYS read from /api/auth/me. An earlier version of this
#     harness hardcoded uid 1, and on an instance where uid 1 was a real person
#     it deleted that account mid-run. Nothing here may hardcode an id.
#
#  2. NOTHING HERE DELETES AN ACCOUNT, and nothing here may. The harness's three
#     accounts (qa, newbie, edgetmp) are created once and reused forever; every
#     run is idempotent against them. Two checks do aim a DELETE at the account
#     route, and both are cases the server is required to REFUSE — an admin
#     deleting their own id (400) and a non-admin deleting id 999999, which
#     belongs to nobody and which the policy rejects before the id is ever read.
#     Asserting a refusal is the only reason that route may appear here. A
#     DELETE that could succeed must never be written into these suites.
#
#  3. If one of those usernames already exists and the harness cannot sign in
#     with the expected password, it ABORTS with an explanation rather than
#     resetting or recreating it. That name may belong to a real person.
#
#  4. The harness refuses a non-loopback host unless PAPYRA_EDGE_ALLOW_REMOTE=1
#     is set, so a stray PAPYRA_BASE cannot point these writes at a live
#     instance by accident.
#
#  5. Every note, category, collection, key, webhook and share it creates is
#     named with $EDGE_PREFIX and removed in cleanup. It touches nothing else.

# Deliberately NOT `set -e`: a failed check must record itself and let the run
# continue, otherwise the first regression hides every one after it.
set -uo pipefail

BASE="${PAPYRA_BASE:-http://localhost:5220}"
ADMIN_USER="${PAPYRA_ADMIN_USER:-admin}"
ADMIN_PASS="${PAPYRA_ADMIN_PASS:-AdminPass123!}"

# The harness accounts. Password is shared and deliberately throwaway.
QA_USER="${PAPYRA_QA_USER:-qa}"
NEWBIE_USER="${PAPYRA_NEWBIE_USER:-newbie}"
TMP_USER="${PAPYRA_TMP_USER:-edgetmp}"
QA_PASS='PapyraQA!2026'

# Everything the harness creates carries this prefix, and cleanup removes
# exactly and only what carries it.
EDGE_PREFIX="edge-harness"

EDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/papyra-edge-$$")"
mkdir -p "$WORK"
BODY_FILE="$WORK/body"
STATUS=""

JAR_ADMIN="$WORK/admin.jar"
JAR_QA="$WORK/qa.jar"
JAR_NEWBIE="$WORK/newbie.jar"
JAR_TMP="$WORK/tmp.jar"
JAR_NONE="$WORK/anon.jar"   # never receives a Set-Cookie; the anonymous caller

PASSED=0
FAILED=0
FAILURES=()
SUITE_NAME="${SUITE_NAME:-edge}"

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[90m'; C_HEAD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_DIM=""; C_HEAD=""; C_OFF=""
fi

# ── JSON ─────────────────────────────────────────────────────────────────────
# jq is not on a stock Git-for-Windows shell, so the reader ships with the
# harness in two runtimes and picks whichever actually works.
#
# Two Windows-specific traps, both of which cost a debugging session once:
#   * `python3` on Windows is usually a Microsoft Store stub. It is on PATH and
#     `command -v` finds it, but running it prints "Python was not found" and
#     exits 49 — so each candidate is probed by RUNNING it, never by looking it
#     up.
#   * A native Windows interpreter cannot open an MSYS path like /c/Users/...,
#     so the script path is converted with cygpath where that exists.
JSON_SCRIPT_DIR="$EDGE_DIR"
if command -v cygpath >/dev/null 2>&1; then
  JSON_SCRIPT_DIR="$(cygpath -w "$EDGE_DIR")"
fi

JSON_CMD=""
_pick_json_runtime() {
  local probe='{"ok":"yes"}'
  local candidate
  for candidate in \
    "python3 ${JSON_SCRIPT_DIR}/json_get.py" \
    "python ${JSON_SCRIPT_DIR}/json_get.py" \
    "py -3 ${JSON_SCRIPT_DIR}/json_get.py" \
    "node ${JSON_SCRIPT_DIR}/json_get.js"; do
    if [ "$(printf '%s' "$probe" | $candidate ok 2>/dev/null)" = "yes" ]; then
      JSON_CMD="$candidate"
      return 0
    fi
  done
  echo "No working python or node on PATH — the harness needs one to read JSON." >&2
  exit 2
}
_pick_json_runtime

# winpath <path> — a path a native Windows binary can open.
#
# curl's `-o` survives an MSYS path because the shell rewrites that argument,
# but the filename inside `-F "file=@..."` is not rewritten, and mingw curl then
# fails with "Failed to open/read local data from file/application". Anything
# handed to curl *inside* an argument has to go through this.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# jget <dotted-path> [file] — one value out of the last response body.
jget() {
  local path="$1" file="${2:-$BODY_FILE}"
  $JSON_CMD "$path" < "$file" 2>/dev/null | head -1
}

# ── Requests ─────────────────────────────────────────────────────────────────
# req <jar> <method> <path> [json-body] [extra curl args...]
# Leaves the status in $STATUS and the body in $BODY_FILE.
req() {
  local jar="$1" method="$2" path="$3" body="${4:-}"
  shift 4 2>/dev/null || shift $#
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method"
              -b "$jar" -c "$jar" --max-time 30)
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  STATUS="$(curl "${args[@]}" "$@" "$BASE$path" 2>>"$WORK/curl.err")"
  [ -n "$STATUS" ] || STATUS="000"
}

# Same, with an API key instead of a cookie.
req_key() {
  local key="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method"
              -H "X-API-Key: $key" --max-time 30)
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  STATUS="$(curl "${args[@]}" "$BASE$path" 2>>"$WORK/curl.err")"
  [ -n "$STATUS" ] || STATUS="000"
}

# ── Assertions ───────────────────────────────────────────────────────────────
pass() { PASSED=$((PASSED + 1)); printf '  %sPASS%s %s\n' "$C_OK" "$C_OFF" "$1"; }

fail() {
  FAILED=$((FAILED + 1))
  FAILURES+=("$1")
  printf '  %sFAIL%s %s\n' "$C_BAD" "$C_OFF" "$1"
  [ -n "${2:-}" ] && printf '       %s%s%s\n' "$C_DIM" "$2" "$C_OFF"
  return 0
}

# check <name> <expected-status> <jar> <method> <path> [body]
check() {
  local name="$1" want="$2"; shift 2
  req "$@"
  if [ "$STATUS" = "$want" ]; then
    pass "$name"
  else
    fail "$name" "expected $want, got $STATUS — $(head -c 200 "$BODY_FILE" | tr -d '\n')"
  fi
}

# check_in <name> <expected-status-list> ... — for a call whose success has more
# than one legitimate code (204 or 200 depending on the handler).
check_in() {
  local name="$1" want="$2"; shift 2
  req "$@"
  case " $want " in
    *" $STATUS "*) pass "$name" ;;
    *) fail "$name" "expected one of [$want], got $STATUS — $(head -c 200 "$BODY_FILE" | tr -d '\n')" ;;
  esac
}

# eq <name> <actual> <expected> — assert on a value already pulled out.
eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$3', got '$2'"; fi
}

ne() {
  if [ "$2" != "$3" ]; then pass "$1"; else fail "$1" "expected anything but '$3'"; fi
}

# body_has / body_lacks <name> <pattern> — grep the last response body.
body_has() {
  if grep -q -- "$2" "$BODY_FILE"; then pass "$1"
  else fail "$1" "body did not contain '$2' — $(head -c 200 "$BODY_FILE" | tr -d '\n')"; fi
}

body_lacks() {
  if grep -q -- "$2" "$BODY_FILE"; then
    fail "$1" "body contained '$2' and must not"
  else pass "$1"; fi
}

section() { printf '\n%s%s%s\n' "$C_HEAD" "$1" "$C_OFF"; }

# ── Sign-in ──────────────────────────────────────────────────────────────────
login() {
  local jar="$1" user="$2" pass="$3"
  rm -f "$jar"
  req "$jar" POST /api/auth/login "$(printf '{"username":"%s","password":"%s"}' "$user" "$pass")"
  echo "$STATUS"
}

# me_id <jar> — the caller's own id, from the server. Never hardcode one.
me_id() {
  req "$1" GET /api/auth/me
  jget id
}

me_role() {
  req "$1" GET /api/auth/me
  jget role
}

abort() {
  printf '\n%sABORT%s %s\n' "$C_BAD" "$C_OFF" "$1" >&2
  exit 2
}

# ── Preflight ────────────────────────────────────────────────────────────────
preflight() {
  local host
  host="$(printf '%s' "$BASE" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  case "$host" in
    localhost|127.0.0.1|::1|0.0.0.0|host.docker.internal) ;;
    *)
      [ "${PAPYRA_EDGE_ALLOW_REMOTE:-0}" = "1" ] || abort \
        "$BASE is not loopback. This harness writes data. Set PAPYRA_EDGE_ALLOW_REMOTE=1 if you really mean it."
      ;;
  esac

  req "$JAR_NONE" GET /health
  [ "$STATUS" = "200" ] || abort "No instance answering at $BASE (GET /health → $STATUS). Start one first."

  [ "$(login "$JAR_ADMIN" "$ADMIN_USER" "$ADMIN_PASS")" = "200" ] \
    || abort "Could not sign in as '$ADMIN_USER'. Set PAPYRA_ADMIN_USER / PAPYRA_ADMIN_PASS."

  [ "$(me_role "$JAR_ADMIN")" = "Admin" ] \
    || abort "'$ADMIN_USER' is not an admin; the harness needs one to provision its accounts."
}

# ensure_account <username> <role> <jar> — sign in, provisioning on first run.
#
# If the account exists and the password does not match, this ABORTS. It never
# resets a password it did not set: the name may belong to a real person, and
# taking over their account to run tests is exactly the failure this harness
# once caused in a worse form.
ensure_account() {
  local user="$1" role="$2" jar="$3"

  if [ "$(login "$jar" "$user" "$QA_PASS")" = "200" ]; then
    # Signed in. It may still be carrying a forced-password-change flag from a
    # previous run's reset test; clearing it is setting the password it already
    # has, which is ours to set.
    req "$jar" GET /api/auth/me
    if [ "$(jget mustChangePassword)" = "true" ]; then
      req "$jar" POST /api/auth/password \
        "$(printf '{"current":"%s","next":"%s"}' "$QA_PASS" "$QA_PASS")"
    fi
    return 0
  fi

  # Not signed in. Either it does not exist (provision it) or it exists with a
  # password that is not ours (stop).
  req "$JAR_ADMIN" GET /api/auth/users
  if grep -q "\"username\":\"$user\"" "$BODY_FILE"; then
    abort "An account named '$user' already exists and its password is not the harness password.
       The harness will not reset it — it may belong to a real person.
       Rename that account, or point the harness elsewhere with PAPYRA_QA_USER / PAPYRA_NEWBIE_USER / PAPYRA_TMP_USER."
  fi

  req "$JAR_ADMIN" POST /api/auth/users "$(printf \
    '{"username":"%s","name":"Edge %s","password":"%s","role":"%s"}' \
    "$user" "$user" "$QA_PASS" "$role")"
  [ "$STATUS" = "200" ] || abort "Could not provision '$user' (POST /api/auth/users → $STATUS)."

  [ "$(login "$jar" "$user" "$QA_PASS")" = "200" ] || abort "Provisioned '$user' but cannot sign in as it."

  # A provisioned account is always flagged; clear it so the account is usable.
  req "$jar" POST /api/auth/password \
    "$(printf '{"current":"%s","next":"%s"}' "$QA_PASS" "$QA_PASS")"
  [ "$STATUS" = "204" ] || abort "Could not clear the forced password change on '$user' ($STATUS)."
}

# ── Cleanup ──────────────────────────────────────────────────────────────────
#
# Two halves, because the resources divide in two:
#
#   * Numeric-id rows (collections, keys, webhooks, shares) are recorded as they
#     are created and deleted from that ledger. Nothing is inferred, so nothing
#     belonging to anyone else can be caught by mistake.
#   * Name-keyed resources (notes, categories) are also swept by $EDGE_PREFIX,
#     because their ids are the names the harness chose: a crashed run would
#     otherwise leave a note that the next run collides with.
#
# Neither half can reach an account.

LEDGER="$WORK/created"
: > "$LEDGER"

# track <jar-label> <group> <id> — remember something to delete at the end.
track() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$LEDGER"; }

jar_for() {
  case "$1" in
    admin) echo "$JAR_ADMIN" ;; qa) echo "$JAR_QA" ;;
    newbie) echo "$JAR_NEWBIE" ;; tmp) echo "$JAR_TMP" ;;
    *) echo "$JAR_QA" ;;
  esac
}

cleanup_ledger() {
  # Reverse order: a share is deleted before the note it points at.
  local label group id
  while IFS=$'\t' read -r label group id; do
    [ -n "${id:-}" ] || continue
    req "$(jar_for "$label")" DELETE "/api/$group/$id"
  done < <(tac "$LEDGER" 2>/dev/null || sed '1!G;h;$!d' "$LEDGER")
  : > "$LEDGER"
}

# cleanup_named <jar> — sweep this caller's prefixed notes and categories.
cleanup_named() {
  local jar="$1" n c

  req "$jar" GET /api/notes
  for n in $(grep -o "\"id\":\"$EDGE_PREFIX[^\"]*\"" "$BODY_FILE" \
             | sed 's/"id":"//; s/"$//' | sort -u); do
    req "$jar" DELETE "/api/notes/$n"
  done

  req "$jar" GET /api/categories
  for c in $(grep -o "\"name\":\"$EDGE_PREFIX[^\"]*\"" "$BODY_FILE" \
             | sed 's/"name":"//; s/"$//' | sort -u); do
    req "$jar" DELETE "/api/categories/$c"
  done
}

cleanup_all() {
  cleanup_ledger
  cleanup_named "$JAR_QA"
  cleanup_named "$JAR_NEWBIE"
  cleanup_named "$JAR_ADMIN"
}

# The suites install this as their EXIT trap. Cleanup runs first and the scratch
# directory goes last — `finish` must not remove $WORK itself, or the trap it
# triggers would find its cookie jars and response buffer already gone.
teardown() {
  cleanup_all
  rm -rf "$WORK"
}

finish() {
  printf '\n%s%s: %d passed, %d failed%s\n' \
    "$C_HEAD" "$SUITE_NAME" "$PASSED" "$FAILED" "$C_OFF"
  if [ "$FAILED" -gt 0 ]; then
    printf '%sFailures:%s\n' "$C_BAD" "$C_OFF"
    for f in "${FAILURES[@]}"; do printf '  · %s\n' "$f"; done
    exit 1
  fi
  exit 0
}
