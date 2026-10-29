# papyra.versions

The other end of Papyra's daily update check: `versions.papyra.app`. The check is optional;
`PAPYRA_UPDATE_CHECK_ENABLED=false` on an install means it never reaches this Worker. About 100 lines of JavaScript,
no dependencies, written to be read. What the check is and why: <https://papyra.app/docs/update-check/>.

| Route | What it does |
| --- | --- |
| `GET /latest.json?id=<uuid>&v=<version>` | Answers with the newest release (read from GitHub, cached an hour) and counts the install. |
| `GET /stats.json` | The public numbers: installs ever seen, active in the last 30 days, seen today, countries and versions. Shown on papyra.app. |

## Why

To count installs. It keeps the person building Papyra motivated, and it feels good to see that it is actually being used.

## What is collected

One row per install, and nothing else: see [`schema.sql`](schema.sql) for the whole table, and
<https://papyra.app/docs/update-check/> for the plain-English list of what an install sends. There is no
column for an IP address, a host name, a user or a note.

**The IP address is never read here.** [`src/index.js`](src/index.js) uses `request.cf.country` and nothing
else about the connection; there is no logging in the code, and `observability` is off in
[`wrangler.toml`](wrangler.toml), so the Worker keeps no request log either. A test
(`test/count.test.js`) sends a request carrying an address and checks that nothing in the stored row
could hold it.

Requests that don't look like an install are not counted, and a server with no release version at all
(`dotnet run`, the test suite) never sends one.

## When installs ping

Once a day each, at a time of day fixed per install (from its ID), never between 02:30 and 03:30 UTC;
a check that can't get through is retried after an hour (then two, four, six), and
the time a retry gets through becomes that install's new time of day. That hour is quiet on purpose: the site is rebuilt in the middle of it (03:00 UTC, in
`.github/workflows/site.yml`) from numbers nothing is writing to. The Worker doesn't enforce it — a ping
that arrives anyway is counted. The schedule is [`UpdateSchedule.cs`](../papyra.api/src/Papyra.Api/Storage/UpdateSchedule.cs).

## When pings go missing

- **Active** is counted back from the newest check-in, not from today, so a few quiet days leave it where it
  was (`stale` in `/stats.json` says the data is behind).
- **Installs** only grow: if the table ever looks emptier than before, the last good numbers are served.
- If the numbers can't be worked out at all, the last good ones are served; the site also bakes the last
  numbers into every build, and shows them if its live request fails.
- GitHub is asked for the latest release at most once an hour and its last answer is kept, so an install
  still hears about the last release when GitHub is down or rate-limiting.

## Run the tests

```sh
cd papyra.versions
node --test "test/*.test.js"      # Node 22.5+ (uses the built-in SQLite in place of D1)
```

## Deploy

```sh
npx wrangler d1 create papyra-versions                      # paste the printed id into wrangler.toml
npx wrangler d1 execute papyra-versions --remote --file=schema.sql
npx wrangler deploy                                         # serves versions.papyra.app
```

`versions.papyra.app` must be a hostname on a zone in the same Cloudflare account.
The latest release comes from the GitHub release marked "latest" on `GITHUB_REPO`, so publishing a
release is all it takes for admins to be told.
