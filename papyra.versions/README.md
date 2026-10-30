# papyra.versions

The other end of Papyra's daily update check: `versions.papyra.app`. The check is optional;
`PAPYRA_UPDATE_CHECK_ENABLED=false` on an install means it never reaches this Worker. About 100 lines of JavaScript,
no dependencies, written to be read. What the check is and why: <https://papyra.app/docs/update-check/>.

| Route | What it does |
| --- | --- |
| `GET /latest.json?id=<uuid>&v=<version>` | Answers with the newest release (read from GitHub, cached an hour) and counts the install. |
| `GET /stats.json` | The public numbers: installs counted, active in the last 30 days, seen today, countries and versions. Shown on papyra.app. |

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

## Making the numbers hard to move

Anyone can send a request that looks like an install, and nothing in an open-source client can prove
otherwise. So the count is an estimate, built to be slow and expensive to inflate and easy to clean up:

- **Two days.** An install is counted only once it has checked in on two different days, at least 24 hours
  apart (`MIN_DAYS`, `MIN_SPAN_HOURS` in [`src/count.js`](src/count.js)). Times are kept to the hour. A ping at
  23:59 and another at 00:01 is two days but not a day apart, so it doesn't count.
- **Real versions only.** The version must be a release on `GITHUB_REPO` or a development build
  (`1.2.3-dev.<commit>`). GitHub's list of releases is kept, and asked for again only when an unknown number
  turns up, at most every five minutes ([`src/known.js`](src/known.js)). If GitHub can't say and nothing is
  remembered, the number's shape is trusted rather than losing real installs.
- **An hourly cap on new installs** (`MAX_NEW_PER_HOUR`, 200). Over it, a new ID isn't stored; the install asks
  again tomorrow. Installs already known are never turned away. A flood can crowd out new installs for as long as
  it lasts, but not the update notice or the numbers already counted.
- **One write per install per day.** A ping from an install already seen today writes nothing, so repeated
  requests can't use up D1's write quota.
- **A ceiling on the public total.** `/stats.json` can rise by at most `SURGE_MIN` (100) or `SURGE_SHARE`
  (25%) of what it was when the day began, whichever is more. A sudden flood shows up over days, which leaves
  time to look at it. The totals shown are the only figures held back.
- **Cleaning up.** Rows are plain, so a flood can be deleted afterwards, for example installs that never came
  back:

  ```sh
  npx wrangler d1 execute papyra-versions --remote --command \
    "DELETE FROM installs WHERE days = 1 AND first_seen < date('now', '-7 days')"
  ```

Not in the Worker, because it never reads the address: a **rate limit per address**, set at Cloudflare's edge
(see Deploy). The settings above are `[vars]` in [`wrangler.toml`](wrangler.toml).

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
- **A check the Worker turns away** (no room this hour, an unknown version) is still answered normally; the
  install doesn't notice and asks again tomorrow.
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

A database made before check-in hours and day counts existed needs
`npx wrangler d1 execute papyra-versions --remote --file=migrate-2026-10-30.sql` once (a new one doesn't).

Then add a rate limit in the Cloudflare dashboard (**Security → WAF → Rate limiting rules**; check the current
free-plan limits there): requests to hostname `versions.papyra.app` and path `/latest.json`, counted per IP
address, more than 10 in 10 seconds → block. A real install asks once a day, so this never touches one. Count IPv6
addresses per /64 if the dashboard offers it.

`versions.papyra.app` must be a hostname on a zone in the same Cloudflare account.
The latest release comes from the GitHub release marked "latest" on `GITHUB_REPO`, so publishing a
release is all it takes for admins to be told.
