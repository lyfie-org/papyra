#!/usr/bin/env bash
#
# edge2.sh — the promises, not the plumbing.
#
# Every check here is a rule Papyra makes about who can see what: per-tenant
# isolation, admin gating, the sharing rules, the lock on a secure note, and the
# wall a provisioned account meets before it has chosen its own password. These
# are the regressions that matter most and the ones a unit test is least likely
# to notice, because they live in middleware, policies and route ordering rather
# than in a service.
#
#   ./edge2.sh
#   PAPYRA_BASE=http://localhost:8080 ./edge2.sh
#
# See lib.sh for the safety rules. In short: tenant ids come from
# /api/auth/me, no account is ever deleted, and only what the harness created
# is cleaned up.

SUITE_NAME="edge2.sh — isolation, gating and sharing"
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

preflight
ensure_account "$QA_USER"     User "$JAR_QA"
ensure_account "$NEWBIE_USER" User "$JAR_NEWBIE"
ensure_account "$TMP_USER"    User "$JAR_TMP"

QA_ID="$(me_id "$JAR_QA")"
NEWBIE_ID="$(me_id "$JAR_NEWBIE")"
TMP_ID="$(me_id "$JAR_TMP")"
[ -n "$QA_ID" ] && [ -n "$NEWBIE_ID" ] && [ -n "$TMP_ID" ] \
  || abort "Could not read a tenant id from /api/auth/me — refusing to continue."

MINE="$EDGE_PREFIX-private"
SHARED="$EDGE_PREFIX-shared"
LOCKED="$EDGE_PREFIX-locked"
SECRET_PHRASE="pomegranate-seventeen"

trap teardown EXIT
cleanup_named "$JAR_QA"
cleanup_named "$JAR_NEWBIE"

# ── Anonymous callers ────────────────────────────────────────────────────────
section "Nothing is readable without a session"

for path in /api/notes /api/categories /api/collections /api/keys /api/webhooks \
            /api/git /api/settings /api/inbox /api/conflicts /api/shares/summary \
            /api/shares/incoming /api/ai/sessions /api/users/search?q=a \
            /api/auth/notifications /api/auth/webauthn/credentials; do
  check "anonymous GET $path is 401" 401 "$JAR_NONE" GET "$path"
done
check "anonymous cannot write a note" 401 "$JAR_NONE" PUT "/api/notes/$EDGE_PREFIX-anon" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'

# ── Tenancy ──────────────────────────────────────────────────────────────────
section "One tenant cannot reach another's notes"

check "qa writes a private note" 200 "$JAR_QA" PUT "/api/notes/$MINE" \
  '{"title":"Private","tags":[],"pinned":false,"archived":false,"body":"'"$SECRET_PHRASE"'"}'

req "$JAR_NEWBIE" GET /api/notes
body_lacks "it is not in the other tenant's list" "$SECRET_PHRASE"

req "$JAR_NEWBIE" GET "/api/search?q=$SECRET_PHRASE"
body_lacks "and search does not surface it either" "$MINE"

check "the other tenant's blocks are not readable" 404 "$JAR_NEWBIE" GET "/api/notes/$MINE/blocks"
# Snapshots resolve under the caller's own vault, so this is 200-and-empty
# rather than 404: the other tenant is not told the note exists at all.
check "snapshots resolve in the caller's own vault" 200 "$JAR_NEWBIE" GET "/api/notes/$MINE/snapshots"
eq "and there are none of somebody else's there" "$(jget 0.id)" ""

# A note id is unique per vault, not per instance: the same id in another vault
# is a different note, and writing it must not touch the first one.
check "the same id in another vault is a different note" 200 "$JAR_NEWBIE" PUT "/api/notes/$MINE" \
  '{"title":"Mine now","tags":[],"pinned":false,"archived":false,"body":"a completely different body"}'
req "$JAR_QA" GET /api/notes
body_has "the original is untouched" "$SECRET_PHRASE"

check_in "and deleting theirs" "200 204" "$JAR_NEWBIE" DELETE "/api/notes/$MINE"
req "$JAR_QA" GET /api/notes
body_has "leaves the original alone" "$SECRET_PHRASE"

# ── Admin gating ─────────────────────────────────────────────────────────────
section "Admin-only routes refuse a plain user"

check "the roster" 403 "$JAR_NEWBIE" GET /api/auth/users
check "provisioning" 403 "$JAR_NEWBIE" POST /api/auth/users '{"username":"nope"}'
# id 999999 belongs to nobody; the policy refuses before the id is ever read,
# and the harness must never aim a delete at an id that could be real.
check "deleting an account" 403 "$JAR_NEWBIE" DELETE /api/auth/users/999999
check "resetting a password" 403 "$JAR_NEWBIE" POST /api/auth/users/999999/reset '{}'
check "minting a recovery link" 403 "$JAR_NEWBIE" POST /api/auth/users/999999/recovery-link '{}'
check "the job list" 403 "$JAR_NEWBIE" GET /api/jobs
check "starting a job" 403 "$JAR_NEWBIE" POST /api/jobs/trash-purge/run
check "reading AI configuration" 403 "$JAR_NEWBIE" GET /api/ai/config
check "writing AI configuration" 403 "$JAR_NEWBIE" PUT /api/ai/config '{}'
check "downloading a model" 403 "$JAR_NEWBIE" POST /api/ai/pull '{"model":"x"}'
check "reading SSO configuration" 403 "$JAR_NEWBIE" GET /api/auth/oidc
check "writing SSO configuration" 403 "$JAR_NEWBIE" PUT /api/auth/oidc '{}'
check "reading email configuration" 403 "$JAR_NEWBIE" GET /api/auth/smtp
check "sending a test email" 403 "$JAR_NEWBIE" POST /api/auth/smtp/test '{}'
check "sending an invite" 403 "$JAR_NEWBIE" POST /api/auth/smtp/invite '{"email":"x@example.com"}'
# This one sweeps every tenant's media, so it is admin-only. The two cache
# rebuilds below are not, and the difference is the point.
check "pruning unreferenced media" 403 "$JAR_NEWBIE" POST /api/system/prune-media

section "…and a plain user's own things are their own"
check "git backup is per account, open to any user" 200 "$JAR_NEWBIE" GET /api/git
# Rebuilding a disposable cache is scoped to the caller's own vault, so it is
# deliberately open to any signed-in user — and it must only ever see their notes.
check "rebuilding one's own search index" 200 "$JAR_NEWBIE" POST /api/system/rebuild-index
eq "and it rebuilt none of somebody else's notes" "$(jget rebuilt)" "0"
check "rebuilding one's own embeddings" 200 "$JAR_NEWBIE" POST /api/system/rebuild-embeddings
eq "and queued none of somebody else's notes" "$(jget queued)" "0"

# ── Sharing ──────────────────────────────────────────────────────────────────
section "Sharing with a person"

check "qa writes a note to share" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body"}'

check "share it with the other account" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"'"$NEWBIE_USER"'"}'
SHARE_ID="$(jget id)"
[ -n "$SHARE_ID" ] && track qa shares "$SHARE_ID"
eq "it starts as view-only" "$(jget access)" "view"

check "sharing again is not a second grant" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"'"$NEWBIE_USER"'"}'
eq "the same share comes back" "$(jget id)" "$SHARE_ID"

check "asking for edit upgrades it" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"edit","granteeUsername":"'"$NEWBIE_USER"'"}'
eq "access is now edit" "$(jget access)" "edit"
eq "still one grant, not a new one" "$(jget id)" "$SHARE_ID"

check "asking for view again does not take edit away" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"'"$NEWBIE_USER"'"}'
eq "edit survives a later view request" "$(jget access)" "edit"

check "sharing with yourself is refused" 400 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"'"$QA_USER"'"}'
check "sharing with nobody is a 404" 404 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"nobody-'"$EDGE_PREFIX"'"}'
check "an unknown kind is refused" 400 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"telepathy","access":"view","granteeUsername":"'"$NEWBIE_USER"'"}'

req "$JAR_NEWBIE" GET /api/shares/incoming
body_has "the sharee sees it in shared-with-me" "$SHARED"
INCOMING_ID="$(jget 0.shareId)"
[ -n "$INCOMING_ID" ] || INCOMING_ID="$SHARE_ID"
check "and can read it" 200 "$JAR_NEWBIE" GET "/api/shares/incoming/$INCOMING_ID"
body_has "getting the real body" "the shared body"

check "somebody else's share id is not found, not forbidden" 404 "$JAR_QA" GET "/api/shares/incoming/$INCOMING_ID"

req "$JAR_QA" GET /api/shares/summary
body_has "the owner's grid says the note is shared" "$SHARED"
body_has "and names who it is shared with, not just a count" "$NEWBIE_USER"

# ── A locked note is nobody's to read ────────────────────────────────────────
section "Locking a note takes it back"

check "qa locks the shared note" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":true}'
eq "the lock is recorded" "$(jget secure)" "true"

req "$JAR_QA" GET /api/notes
body_lacks "a locked body never rides the list" "the shared body"

req "$JAR_NEWBIE" GET /api/shares/incoming
body_lacks "the sharee's list drops it" "$SHARED"
check "and reading it is 410, not a body" 410 "$JAR_NEWBIE" GET "/api/shares/incoming/$INCOMING_ID"

check "a locked note cannot be shared with a person" 400 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"user","access":"view","granteeUsername":"'"$NEWBIE_USER"'"}'
check "nor by link" 400 "$JAR_QA" POST "/api/notes/$SHARED/shares" '{"kind":"link","access":"view"}'

check "an omitted secure flag never silently unlocks" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body"}'
eq "it is still locked" "$(jget secure)" "true"

check "unlocking is explicit" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":false}'
eq "and now it is open" "$(jget secure)" "false"

# ── Public links ─────────────────────────────────────────────────────────────
section "Public links"

check "mint a view link" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" '{"kind":"link","access":"view"}'
TOKEN="$(jget token)"
LINK_ID="$(jget id)"
[ -n "$LINK_ID" ] && track qa shares "$LINK_ID"
[ -n "$TOKEN" ] && pass "it carries a token" || fail "it carries a token" "no token in response"

check "anybody with the link can read it" 200 "$JAR_NONE" GET "/api/shared/$TOKEN"
body_has "and gets the body" "the shared body"
check "a made-up token is 404" 404 "$JAR_NONE" GET "/api/shared/not-a-real-token-$EDGE_PREFIX"
check "a view link cannot be written through" 403 "$JAR_NONE" PUT "/api/shared/$TOKEN" '{"body":"vandalism"}'
req "$JAR_QA" GET /api/notes
body_lacks "so the note was not vandalised" "vandalism"

check "lock the note again" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":true}'
check "the public link now answers 410" 410 "$JAR_NONE" GET "/api/shared/$TOKEN"
body_lacks "and hands over nothing" "the shared body"
check "unlock it again" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":false}'

section "A limited link counts only the reads it served"

check "mint a one-view link" 200 "$JAR_QA" POST "/api/notes/$SHARED/shares" \
  '{"kind":"link","access":"view","maxViews":1}'
ONCE="$(jget token)"
ONCE_ID="$(jget id)"
[ -n "$ONCE_ID" ] && track qa shares "$ONCE_ID"

check "lock the note before anyone reads it" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":true}'
check "a refused read is 410" 410 "$JAR_NONE" GET "/api/shared/$ONCE"
check "unlock it" 200 "$JAR_QA" PUT "/api/notes/$SHARED" \
  '{"title":"Shared","tags":[],"pinned":false,"archived":false,"body":"the shared body","secure":false}'
check "the refusal did not burn the one view" 200 "$JAR_NONE" GET "/api/shared/$ONCE"
check "the second real read is 410" 410 "$JAR_NONE" GET "/api/shared/$ONCE"

section "Revoking"

check "revoke the person share" 204 "$JAR_QA" DELETE "/api/shares/$SHARE_ID"
req "$JAR_NEWBIE" GET /api/shares/incoming
body_lacks "the sharee loses it immediately" "$SHARED"
check "revoking somebody else's share is not found" 404 "$JAR_NEWBIE" DELETE "/api/shares/$LINK_ID"

# ── Secure notes ─────────────────────────────────────────────────────────────
section "A locked note needs a live unlock"

check "write a locked note" 200 "$JAR_QA" PUT "/api/notes/$LOCKED" \
  '{"title":"Locked","tags":[],"pinned":false,"archived":false,"body":"'"$SECRET_PHRASE"'-locked","secure":true}'
req "$JAR_QA" GET /api/notes
body_lacks "its body is withheld even from its owner's list" "$SECRET_PHRASE-locked"
check "the reveal route refuses without a token" 401 "$JAR_QA" GET "/api/notes/$LOCKED/secure"
check "a forged unlock token is refused" 401 "$JAR_QA" GET "/api/notes/$LOCKED/secure" "" \
  -H "X-Unlock-Token: forged-$EDGE_PREFIX"
check "and the other tenant cannot reveal it either" 401 "$JAR_NEWBIE" GET "/api/notes/$LOCKED/secure"

# ── Forced password change ───────────────────────────────────────────────────
section "An account that has not chosen its own password"

# edgetmp is a permanent harness account. The admin resets it (which re-arms the
# flag), the harness proves the wall, then it sets the password back. No account
# is created or deleted here.
check "the account works before the reset" 200 "$JAR_TMP" GET /api/notes

check "an admin resets its password" 200 "$JAR_ADMIN" POST "/api/auth/users/$TMP_ID/reset" \
  '{"password":"'"$QA_PASS"'"}'

check "the flag bites the session that is already open" 403 "$JAR_TMP" GET /api/notes
body_has "with a code the client can branch on" '"code":"password_change_required"'
check "…on every route" 403 "$JAR_TMP" GET /api/categories
check "…including writes" 403 "$JAR_TMP" PUT "/api/notes/$EDGE_PREFIX-blocked" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'

check "but it can still see who it is" 200 "$JAR_TMP" GET /api/auth/me
eq "and is told what is wrong" "$(jget mustChangePassword)" "true"

check "a wrong current password is refused" 400 "$JAR_TMP" POST /api/auth/password \
  '{"current":"not-the-password","next":"'"$QA_PASS"'"}'
check "a weak new password is refused" 400 "$JAR_TMP" POST /api/auth/password \
  '{"current":"'"$QA_PASS"'","next":"abc"}'
check "choosing its own password clears it" 204 "$JAR_TMP" POST /api/auth/password \
  '{"current":"'"$QA_PASS"'","next":"'"$QA_PASS"'"}'
check "and the account works again" 200 "$JAR_TMP" GET /api/notes

section "A generated first password is shown once and never again"

check "reset with a blank password generates one" 200 "$JAR_ADMIN" POST "/api/auth/users/$TMP_ID/reset" '{}'
GENERATED="$(jget password)"
[ -n "$GENERATED" ] && pass "it is returned once, at reset" \
                    || fail "it is returned once, at reset" "no password in the response"
req "$JAR_ADMIN" GET /api/auth/users
body_lacks "the roster never carries a password" "$GENERATED"
body_has "only the fact that one is pending" '"mustChangePassword":true'

# Put the account back the way the harness expects to find it next run.
[ "$(login "$JAR_TMP" "$TMP_USER" "$GENERATED")" = "200" ] \
  && pass "the generated password works" || fail "the generated password works" "login refused it"
check "set it back to the harness password" 204 "$JAR_TMP" POST /api/auth/password \
  '{"current":"'"$GENERATED"'","next":"'"$QA_PASS"'"}'

# ── Avatars ──────────────────────────────────────────────────────────────────
section "A profile picture is decided by its bytes, not its name"

PNG="$WORK/tiny.png"
SVG="$WORK/tiny.svg"
BIG="$WORK/big.png"
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > "$PNG" 2>/dev/null || printf '\x89PNG\r\n\x1a\n' > "$PNG"
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$SVG"
# A genuine PNG header followed by 5 MB of filler, so the size cap is what
# refuses it rather than the format sniff.
cat "$PNG" > "$BIG"
head -c 5000000 /dev/zero >> "$BIG" 2>/dev/null || yes x | head -c 5000000 >> "$BIG"

up() {  # up <file> <sent-filename>
  STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -b "$JAR_QA" -c "$JAR_QA" \
    --max-time 60 -F "file=@$(winpath "$1");filename=$2" \
    "$BASE/api/auth/avatar" 2>>"$WORK/curl.err")"
  [ -n "$STATUS" ] || STATUS="000"
}

up "$PNG" "tiny.png"
eq "a real PNG is accepted" "$STATUS" "200"
up "$SVG" "avatar.png"
eq "an SVG wearing a .png name is refused" "$STATUS" "400"
up "$PNG" "avatar.svg"
eq "a real PNG wearing a .svg name is still a PNG" "$STATUS" "200"
up "$BIG" "huge.png"
eq "anything over the cap is refused" "$STATUS" "400"

req "$JAR_NEWBIE" GET "/api/auth/avatar/$QA_USER"
eq "another signed-in person can see it" "$STATUS" "200"
req "$JAR_NONE" GET "/api/auth/avatar/$QA_USER"
eq "an anonymous caller cannot" "$STATUS" "401"

req "$JAR_QA" GET "/api/auth/avatar/nobody-$EDGE_PREFIX"
eq "a name that belongs to nobody is 404" "$STATUS" "404"
req "$JAR_QA" GET "/api/auth/avatar/$TMP_USER"
eq "and so is somebody with no picture — no account oracle" "$STATUS" "404"

# ── Path jail ────────────────────────────────────────────────────────────────
section "Nothing escapes the vault"

check_in "media traversal" "400 404" "$JAR_QA" GET "/api/media/..%2F..%2F..%2Fappsettings.json"
check_in "encoded media traversal" "400 404" "$JAR_QA" GET "/api/media/%2e%2e%2fappsettings.json"
check "a traversing note id" 400 "$JAR_QA" PUT "/api/notes/..%2F..%2Fescape" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'
check "a percent that could survive double-decoding" 400 "$JAR_QA" PUT "/api/notes/a%25%32%66b" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'
check "an alternate data stream" 400 "$JAR_QA" PUT "/api/notes/note%3Astream" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'
check "a reserved Windows device name" 400 "$JAR_QA" PUT "/api/notes/NUL" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'
check "…including the numbered ones" 400 "$JAR_QA" PUT "/api/notes/COM1" \
  '{"title":"x","tags":[],"pinned":false,"archived":false,"body":""}'
check_in "a traversing shared-media filename" "400 404" "$JAR_NONE" \
  GET "/api/shared/$TOKEN/media/..%2F..%2Fappsettings.json"

# ── Conversations ────────────────────────────────────────────────────────────
section "A conversation belongs to one person"

check "an id that does not exist is not found" 404 "$JAR_QA" GET /api/ai/sessions/999999
check "…and reads the same to everybody" 404 "$JAR_NEWBIE" GET /api/ai/sessions/999999
check "renaming it is not found" 404 "$JAR_NEWBIE" PATCH /api/ai/sessions/999999 '{"title":"x"}'
check "deleting it is not found" 404 "$JAR_NEWBIE" DELETE /api/ai/sessions/999999

finish
