# Edge harness

Black-box HTTP checks against a **running** Papyra instance. `dotnet test` proves
the code; these prove the deployed surface — routing, auth policies, cookies,
per-tenant isolation, and the status codes a real client actually receives.
Two suites, 239 checks.

| Suite | What it covers | Checks |
|---|---|---|
| `edge.sh` | The core surface: health, sign-in, notes, to-dos, trash, categories, smart collections, API keys, webhooks, search, settings, inbox, snapshots, backup, export, media, the directory, and the admin screens as an admin | 99 |
| `edge2.sh` | The promises: anonymous access, per-tenant isolation, admin gating, the sharing rules, locked notes, the forced-password-change wall, avatar format sniffing, the path jail, conversation scoping | 140 |

## Running

Start an instance, then run the suites against it:

```bash
bash papyra.api/tests/edge/run.sh
```

The default target is `http://localhost:5220`. Point it elsewhere with
`PAPYRA_BASE`:

```bash
PAPYRA_BASE=http://localhost:8080 bash papyra.api/tests/edge/run.sh
```

### A throwaway instance to run against

The harness writes data, so the best target is a vault that exists only for it.
`.claude/launch.json` has a `papyra-api-edge` entry that serves port **5221**
from a gitignored `.edgedata` directory, entirely separate from the dev vault:

```bash
dotnet run --project papyra.api/src/Papyra.Api -- --Papyra:DataDir=.edgedata --urls http://localhost:5221
```

On a brand-new vault, create the first admin once:

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"username":"admin","name":"Admin","password":"AdminPass123!"}' http://localhost:5221/api/auth/setup
```

Then:

```bash
PAPYRA_BASE=http://localhost:5221 bash papyra.api/tests/edge/run.sh
```

**Do not run these against the dev-sign-in launch entries.**
`Papyra:DevSignInAs` treats every loopback request as a signed-in user, so all
the "anonymous callers get 401" checks would pass for the wrong reason — or
rather, fail loudly, which is the harness telling you the target is wrong.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `PAPYRA_BASE` | `http://localhost:5220` | Instance to test |
| `PAPYRA_ADMIN_USER` / `PAPYRA_ADMIN_PASS` | `admin` / `AdminPass123!` | An admin, used once to provision the harness accounts |
| `PAPYRA_QA_USER` / `PAPYRA_NEWBIE_USER` / `PAPYRA_TMP_USER` | `qa` / `newbie` / `edgetmp` | The harness accounts |
| `PAPYRA_EDGE_ALLOW_REMOTE` | unset | Required to target a non-loopback host |

The harness accounts share the password `PapyraQA!2026`. They are created on the
first run and reused after that; every run is idempotent.

## Safety

An earlier version of this harness hardcoded tenant id 1 and, on an instance
where uid 1 was a real person, **deleted that account mid-run**. The rules that
came out of it are enforced in `lib.sh` and must stay:

1. **Tenant ids come from `/api/auth/me`.** Never a constant.
2. **No account is ever deleted.** Two checks aim a `DELETE` at the account
   route, and both are cases the server is required to *refuse* — an admin
   deleting their own id, and a non-admin deleting id 999999, which belongs to
   nobody. Asserting a refusal is the only reason that route may appear. A
   `DELETE` that could succeed must never be added.
3. **A name that is taken stops the run.** If `qa`, `newbie` or `edgetmp`
   already exists and the harness password does not work, it aborts and says so
   rather than resetting the password. That name may belong to a real person.
4. **A non-loopback target stops the run** unless `PAPYRA_EDGE_ALLOW_REMOTE=1`.
5. **Cleanup removes only what the run created** — numeric-id rows from a ledger
   written as they are created, and notes and categories by the `edge-harness`
   name prefix.

## Writing a check

```bash
check      "name" <status> <jar> <METHOD> <path> [json-body]   # one expected status
check_in   "name" "200 204" <jar> <METHOD> <path> [json-body]  # any of several
eq         "name" "$(jget some.field)" "expected"              # a value from the last body
ne         "name" "$actual" "not-this"
body_has   "name" "pattern"                                    # grep the last body
body_lacks "name" "pattern"                                    # the one that catches leaks
```

Jars: `$JAR_ADMIN`, `$JAR_QA`, `$JAR_NEWBIE`, `$JAR_TMP`, and `$JAR_NONE` for the
anonymous caller. `jget` takes a dotted path (`id`, `0.shareId`, `user.name`).

Anything with a numeric id that the run creates should be handed to
`track <jar-label> <group> <id>` so cleanup can remove it.

**Give every check a distinct name.** Two checks called "delete it" cost a
debugging round trip: the failure list names the check, and an ambiguous name
points at the wrong one.

## Platform notes

Both were learned the hard way on Git for Windows:

- **`python3` is usually a Microsoft Store stub.** It is on `PATH` and
  `command -v` finds it, but running it prints "Python was not found" and exits
  49. `lib.sh` probes each interpreter by *running* it.
- **A native Windows binary cannot open an MSYS path** like `/c/Users/...`.
  Anything passed *inside* a curl argument — the filename in
  `-F "file=@..."`, the script path handed to Python — goes through `winpath`.
  Arguments the shell rewrites on its own (`curl -o`) do not need it.

`curl` is the only external requirement beyond a Python or Node interpreter for
reading JSON; `jq` is not needed and is not on a stock Windows shell anyway.
