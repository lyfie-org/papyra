#!/usr/bin/env bash
#
# edge.sh — the core surface.
#
# Walks the endpoints a signed-in person actually touches and asserts the status
# code and shape a real client would receive. Companion: edge2.sh, which covers
# tenancy, admin gating and the sharing rules.
#
#   ./edge.sh                          # against http://localhost:5220
#   PAPYRA_BASE=http://localhost:8080 ./edge.sh
#
# See lib.sh for the safety rules this harness works under. In short: it reads
# every tenant id from /api/auth/me, it never deletes an account, and it removes
# only what it created.

SUITE_NAME="edge.sh — core surface"
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

preflight
ensure_account "$QA_USER"     User  "$JAR_QA"
ensure_account "$NEWBIE_USER" User  "$JAR_NEWBIE"

ADMIN_ID="$(me_id "$JAR_ADMIN")"
QA_ID="$(me_id "$JAR_QA")"
NOTE="$EDGE_PREFIX-note"
TODO="$EDGE_PREFIX-todo"

trap teardown EXIT
cleanup_named "$JAR_QA"   # clear anything a crashed run left behind

# ── Health and identity ──────────────────────────────────────────────────────
section "Health and identity"

check "GET /health is 200" 200 "$JAR_NONE" GET /health
body_has "health names the app" '"app":"Papyra API"'

check "anonymous /api/auth/me is 401" 401 "$JAR_NONE" GET /api/auth/me
check "wrong password is 401" 401 "$JAR_NONE" POST /api/auth/login \
  '{"username":"'"$QA_USER"'","password":"definitely-not-the-password"}'
check "empty credentials are 400" 400 "$JAR_NONE" POST /api/auth/login '{}'

req "$JAR_QA" GET /api/auth/me
eq  "signed-in caller sees its own username" "$(jget username)" "$QA_USER"
eq  "the harness account is a plain User" "$(jget role)" "User"
eq  "and has no forced password change pending" "$(jget mustChangePassword)" "false"
ne  "the two accounts are different tenants" "$QA_ID" "$ADMIN_ID"
[ -n "$QA_ID" ] && pass "tenant id came from /api/auth/me, not a constant" \
                || fail "tenant id came from /api/auth/me, not a constant" "id was empty"

check "GET /api/auth/providers is anonymous" 200 "$JAR_NONE" GET /api/auth/providers

# ── Notes ────────────────────────────────────────────────────────────────────
section "Notes"

check "create a note" 200 "$JAR_QA" PUT "/api/notes/$NOTE" \
  '{"title":"Edge harness note","tags":["edge"],"pinned":false,"archived":false,"body":"A quiet paragraph about rivers."}'
eq "the note comes back with its id" "$(jget id)" "$NOTE"

check "list notes" 200 "$JAR_QA" GET /api/notes
body_has "the new note is in the list" "\"id\":\"$NOTE\""

check "create a to-do" 200 "$JAR_QA" PUT "/api/notes/$TODO" \
  '{"title":"Edge harness to-do","tags":[],"pinned":false,"archived":false,"body":"- [ ] water the plants","kind":"todo"}'
eq "kind todo survives the round trip" "$(jget kind)" "todo"

check "a traversing note id is refused" 400 "$JAR_QA" PUT "/api/notes/..%2F..%2Fetc%2Fpasswd" \
  '{"title":"nope","tags":[],"pinned":false,"archived":false,"body":""}'
check "a slashed note id is refused" 400 "$JAR_QA" PUT "/api/notes/a%2Fb" \
  '{"title":"nope","tags":[],"pinned":false,"archived":false,"body":""}'

check "note activity for the heatmap" 200 "$JAR_QA" GET /api/notes/activity
check "read the manual order" 200 "$JAR_QA" GET /api/notes/order
check "write the manual order" 200 "$JAR_QA" PUT /api/notes/order \
  '{"entries":[{"id":"'"$NOTE"'","key":1.5,"setAt":0}]}'

check "block anchors for transclusion" 200 "$JAR_QA" GET "/api/notes/$NOTE/blocks"
check "backlinks" 200 "$JAR_QA" GET "/api/notes/$NOTE/backlinks"
check "snapshots" 200 "$JAR_QA" GET "/api/notes/$NOTE/snapshots"
check "a secure read with no unlock token is 401" 401 "$JAR_QA" GET "/api/notes/$NOTE/secure"
body_has "and says it is locked, in a code the client can branch on" '"code":"locked"'

check_in "trash the to-do" "200 204" "$JAR_QA" POST "/api/notes/$TODO/trash"
req "$JAR_QA" GET /api/notes
body_has "a trashed note is still listed, flagged" '"trashed":true'
check_in "restore it" "200 204" "$JAR_QA" POST "/api/notes/$TODO/untrash"
check_in "delete it for good" "200 204" "$JAR_QA" DELETE "/api/notes/$TODO"
req "$JAR_QA" GET /api/notes
body_lacks "and it is gone from the list" "\"id\":\"$TODO\""

# ── Categories ───────────────────────────────────────────────────────────────
section "Categories"

CAT="$EDGE_PREFIX-cat"
check "create a category" 200 "$JAR_QA" POST /api/categories \
  '{"name":"'"$CAT"'","color":"#7aaa8a"}'
check "list categories" 200 "$JAR_QA" GET /api/categories
body_has "the new category is listed" "\"name\":\"$CAT\""
check_in "delete the category" "200 204" "$JAR_QA" DELETE "/api/categories/$CAT"

# ── Smart collections ────────────────────────────────────────────────────────
section "Smart collections"

check "create a collection" 200 "$JAR_QA" POST /api/collections \
  '{"name":"'"$EDGE_PREFIX"'-coll","rulesJson":"{\"match\":\"all\",\"conditions\":[{\"field\":\"tag\",\"value\":\"edge\"}]}"}'
COLL="$(jget id)"
[ -n "$COLL" ] && track qa collections "$COLL"
[ -n "$COLL" ] && pass "it comes back with an id" || fail "it comes back with an id" "no id in response"

check "list collections" 200 "$JAR_QA" GET /api/collections
body_has "the new collection is listed" "$EDGE_PREFIX-coll"
check "the notes it matches" 200 "$JAR_QA" GET "/api/collections/$COLL/notes"

# ── API keys ─────────────────────────────────────────────────────────────────
section "API keys"

check "mint a key" 200 "$JAR_QA" POST /api/keys '{"name":"'"$EDGE_PREFIX"'-key"}'
KEY="$(jget token)"
KEY_ID="$(jget id)"
[ -n "$KEY_ID" ] && track qa keys "$KEY_ID"
[ -n "$KEY" ] && pass "the secret is returned once, on creation" \
              || fail "the secret is returned once, on creation" "no key in response"

check "list keys" 200 "$JAR_QA" GET /api/keys
body_lacks "the list never echoes the secret" "$KEY"

req_key "$KEY" GET /api/notes
eq "the key authenticates a request" "$STATUS" "200"
req_key "not-a-real-key" GET /api/notes
eq "a bogus key does not" "$STATUS" "401"

check_in "revoke the key" "200 204" "$JAR_QA" DELETE "/api/keys/$KEY_ID"
req_key "$KEY" GET /api/notes
eq "a revoked key stops working" "$STATUS" "401"

# ── Webhooks ─────────────────────────────────────────────────────────────────
section "Webhooks"

check "register a webhook" 200 "$JAR_QA" POST /api/webhooks \
  '{"event":"NoteCreated","url":"http://localhost:9/'"$EDGE_PREFIX"'","secret":"s3cret"}'
HOOK="$(jget id)"
[ -n "$HOOK" ] && track qa webhooks "$HOOK"
check "list webhooks" 200 "$JAR_QA" GET /api/webhooks
body_lacks "the list never echoes the signing secret" 's3cret'
check_in "delete the webhook" "200 204" "$JAR_QA" DELETE "/api/webhooks/$HOOK"

# ── Search ───────────────────────────────────────────────────────────────────
section "Search"

check "keyword search" 200 "$JAR_QA" GET "/api/search?q=rivers"
body_has "it finds the note by a word in its body" "$NOTE"
check "an empty query is answered, not refused" 200 "$JAR_QA" GET "/api/search?q="
check "semantic search answers even with no model" 200 "$JAR_QA" GET "/api/search/semantic?q=rivers"

# ── Settings, inbox, conflicts ───────────────────────────────────────────────
section "Settings, inbox, conflicts"

check "read trash retention" 200 "$JAR_QA" GET /api/settings
check "write trash retention" 200 "$JAR_QA" PUT /api/settings '{"trashRetentionDays":30}'
check "the inbox" 200 "$JAR_QA" GET /api/inbox
check_in "mark the inbox read" "200 204" "$JAR_QA" POST /api/inbox/read
check "conflicts" 200 "$JAR_QA" GET /api/conflicts
check "notification preferences" 200 "$JAR_QA" GET /api/auth/notifications
check "write notification preferences" 204 "$JAR_QA" PUT /api/auth/notifications \
  '{"mention":true,"share":true}'

# ── Sharing surface (the rules live in edge2.sh) ─────────────────────────────
section "Sharing surface"

check "the whole-grid share summary" 200 "$JAR_QA" GET /api/shares/summary
check "shared with me" 200 "$JAR_QA" GET /api/shares/incoming
check "an unknown public token is 404" 404 "$JAR_NONE" GET "/api/shared/no-such-token"

# ── Assistant ────────────────────────────────────────────────────────────────
section "Assistant"

check "AI status" 200 "$JAR_QA" GET /api/ai/status
check "the curated model list" 200 "$JAR_QA" GET /api/ai/models
check "conversation history" 200 "$JAR_QA" GET /api/ai/sessions
check "a conversation that does not exist is 404" 404 "$JAR_QA" GET /api/ai/sessions/999999
check "renaming one that does not exist is 404" 404 "$JAR_QA" PATCH /api/ai/sessions/999999 '{"title":"x"}'
check "deleting one that does not exist is 404" 404 "$JAR_QA" DELETE /api/ai/sessions/999999

# ── Backup, export, media ────────────────────────────────────────────────────
section "Backup, export, media"

check "git backup settings" 200 "$JAR_QA" GET /api/git
body_lacks "the stored token is never echoed" '"token"'
body_has "only whether one is stored" '"hasToken"'
check "export the vault" 200 "$JAR_QA" GET /api/export
check "a missing media file is 404" 404 "$JAR_QA" GET "/api/media/$EDGE_PREFIX-nothing.png"
check_in "a traversing media path does not escape" "400 404" "$JAR_QA" GET "/api/media/..%2F..%2Fappsettings.json"

# ── Passkeys and profile ─────────────────────────────────────────────────────
section "Passkeys and profile"

check "registered passkeys" 200 "$JAR_QA" GET /api/auth/webauthn/credentials
check "update the display name" 200 "$JAR_QA" PUT /api/auth/profile \
  '{"name":"Edge '"$QA_USER"'","email":""}'
check "somebody with no picture is 404, not an error" 404 "$JAR_QA" GET "/api/auth/avatar/$NEWBIE_USER"
check "and so is a name that belongs to nobody" 404 "$JAR_QA" GET "/api/auth/avatar/nobody-$EDGE_PREFIX"

# ── Directory ────────────────────────────────────────────────────────────────
section "Directory"

check "the mention typeahead answers" 200 "$JAR_QA" GET "/api/users/search?q=$NEWBIE_USER"
body_has "and finds the other account" "\"username\":\"$NEWBIE_USER\""
body_lacks "without leaking ids or email" '"email"'

req "$JAR_QA" GET "/api/users/search?q=$QA_USER"
body_lacks "you are never offered yourself to mention" "\"username\":\"$QA_USER\""

check "a wildcard is not a query" 200 "$JAR_QA" GET "/api/users/search?q=%25"
eq "and matches nobody" "$(jget 0.username)" ""

# ── Admin surface, as an admin ───────────────────────────────────────────────
section "Admin surface (as admin)"

check "the account roster" 200 "$JAR_ADMIN" GET /api/auth/users
check "background jobs" 200 "$JAR_ADMIN" GET /api/jobs
body_has "jobs report their last run" '"lastRun"'
check "AI configuration" 200 "$JAR_ADMIN" GET /api/ai/config
body_lacks "a stored API key is never echoed back" '"openAiKey"'
body_has "only whether one is stored" '"hasOpenAiKey"'
check "SSO configuration" 200 "$JAR_ADMIN" GET /api/auth/oidc
check "email configuration" 200 "$JAR_ADMIN" GET /api/auth/smtp
check "an admin cannot delete their own account" 400 "$JAR_ADMIN" DELETE "/api/auth/users/$ADMIN_ID"
body_has "and is told why" "your own account"

finish
