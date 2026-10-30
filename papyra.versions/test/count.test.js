import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cleanPing, record, stats, steadyStats } from '../src/count.js';
import { isKnownVersion } from '../src/known.js';
import worker from '../src/index.js';

// Node's own SQLite behind the few D1 calls the Worker makes.
function d1(schema = '../schema.sql') {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL(schema, import.meta.url), 'utf8'));
  return wrap(sqlite);
}
function wrap(sqlite) {
  return {
    sqlite,
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => sqlite.prepare(sql).run(...values),
        first: async () => { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
        all: async () => ({ results: sqlite.prepare(sql).all(...values).map((r) => ({ ...r })) }),
      }),
    }),
  };
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const params = (obj) => new URLSearchParams(obj);
const full = (n, extra = {}) => ({ id: id(n), version: '1.0.0', arch: 'x64', os: 'linux', country: 'US', ...extra });
// A moment: noon UTC on a day, unless a time is given.
const at = (day, time = '12:00:00') => new Date(`${day}T${time}Z`);
const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
// An install that has been counted: it checked in the day before `lastDay`, and again on it.
async function joined(db, ping, lastDay) {
  await record(db, ping, at(dayBefore(lastDay)));
  await record(db, ping, at(lastDay));
}

test('a ping is a random id, a version, a processor family and an OS family; anything else is not counted', () => {
  assert.deepEqual(cleanPing(params({ id: id(1), v: '1.2.3', arch: 'arm64', os: 'macos' }), 'us'),
    { id: id(1), version: '1.2.3', arch: 'arm64', os: 'macos', country: 'US' });
  assert.equal(cleanPing(params({ id: 'not-a-uuid', v: '1.2.3' }), 'US'), null);
  assert.equal(cleanPing(params({ id: id(1), v: 'dev' }), 'US'), null);
  assert.equal(cleanPing(params({}), 'US'), null);
});

test('a development build reports its development version; no other text after a number is accepted', () => {
  assert.equal(cleanPing(params({ id: id(1), v: '1.1.0-dev.abc1234' }), 'US').version, '1.1.0-dev.abc1234');
  for (const v of ['1.1.0-', '1.1.0-dev abc', '1.1.0-dev.', '1.1.0-dev.xyz', '1.1.0-dev.abc12', '1.1.0-buy.pills.now', '1.1.0-rc.1'])
    assert.equal(cleanPing(params({ id: id(1), v }), 'US'), null, v);
});

test('only the listed processor and OS families are kept; anything else is "other"', () => {
  const ping = (arch, os) => cleanPing(params({ id: id(1), v: '1.0.0', ...(arch ? { arch } : {}), ...(os ? { os } : {}) }), 'US');
  assert.deepEqual([ping('X64', 'Linux').arch, ping('X64', 'Linux').os], ['x64', 'linux']);
  assert.deepEqual([ping('riscv64', 'plan9').arch, ping('riscv64', 'plan9').os], ['other', 'other']);
  assert.deepEqual([ping().arch, ping().os], ['other', 'other']); // an older client sends neither
  assert.deepEqual([ping('203.0.113.9', 'host-name').arch, ping('203.0.113.9', 'host-name').os], ['other', 'other']);
});

test('only a two-letter country is kept; everything else is "ZZ"', () => {
  for (const country of [undefined, null, '', 'XX', 'T1', 'USA', '12', '203.0.113.9'])
    assert.equal(cleanPing(params({ id: id(1), v: '1.0.0' }), country).country, 'ZZ');
});

test('the same install is one row, however often it checks in', async () => {
  const db = d1();
  const ping = full(1);
  assert.equal(await record(db, ping, at('2026-10-01')), 'new');
  assert.equal(await record(db, { ...ping, version: '1.1.0', country: 'DE', arch: 'arm64' }, at('2026-10-02')), 'again');
  const rows = db.sqlite.prepare('SELECT * FROM installs').all();
  assert.equal(rows.length, 1);
  const noon = (day) => Date.parse(`${day}T12:00:00Z`) / 3_600_000;
  assert.deepEqual({ ...rows[0] }, {
    id: id(1), first_seen: '2026-10-01', last_seen: '2026-10-02', first_hour: noon('2026-10-01'), last_hour: noon('2026-10-02'),
    days: 2, version: '1.1.0', arch: 'arm64', os: 'linux', country: 'DE', pings: 2,
  });
});

test('an install that has already checked in today costs no write', async () => {
  const db = d1();
  await record(db, full(1), at('2026-10-01', '09:00:00'));
  assert.equal(await record(db, { ...full(1), version: '1.1.0' }, at('2026-10-01', '17:00:00')), 'seen');
  const row = db.sqlite.prepare('SELECT * FROM installs').get();
  assert.deepEqual([row.pings, row.days, row.version], [1, 1, '1.0.0']);
});

test('an install counts only after two different days at least 24 hours apart', async () => {
  const db = d1();
  // Seen once: not counted. Seen just before and just after midnight: two days, but not a day apart.
  await record(db, full(1), at('2026-10-01'));
  await record(db, full(2), at('2026-10-01', '23:59:00'));
  await record(db, full(2), at('2026-10-02', '00:01:00'));
  assert.equal((await stats(db, '2026-10-02')).installs, 0);
  // A day later, at the same time of day it first came, it counts.
  await record(db, full(2), at('2026-10-03', '00:01:00'));
  await record(db, full(3), at('2026-10-01', '12:00:00'));
  await record(db, full(3), at('2026-10-02', '12:00:00'));
  const s = await stats(db, '2026-10-03');
  assert.equal(s.installs, 2);
  assert.equal(s.today, 1);
});

test('each hour takes in only so many new installs; known ones are never turned away', async () => {
  const db = d1();
  const limits = { maxNewPerHour: 2 };
  assert.equal(await record(db, full(1), at('2026-10-01', '10:05:00'), limits), 'new');
  assert.equal(await record(db, full(2), at('2026-10-01', '10:30:00'), limits), 'new');
  assert.equal(await record(db, full(3), at('2026-10-01', '10:59:00'), limits), 'held');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM installs').get().n, 2);
  // The next hour has room, and an install already known is updated whatever the hour looks like.
  assert.equal(await record(db, full(3), at('2026-10-01', '11:00:00'), limits), 'new');
  assert.equal(await record(db, full(1), at('2026-10-02', '10:05:00'), limits), 'again');
});

test('stats count installs ever seen, active in the last 30 days, and seen today', async () => {
  const db = d1();
  await joined(db, full(1), '2026-10-30'); // today
  await joined(db, full(2), '2026-10-12'); // active
  await joined(db, full(3, { version: '1.1.0-dev.abc1234', country: 'DE', arch: 'arm64', os: 'macos' }), '2026-10-01'); // active (30 days)
  await joined(db, full(4, { version: '0.9.0', country: 'JP' }), '2026-08-01'); // gone quiet
  const s = await stats(db, '2026-10-30');
  assert.equal(s.installs, 4);
  assert.equal(s.active, 3);
  assert.equal(s.today, 1);
  assert.deepEqual(s.regions, [{ country: 'US', count: 2 }, { country: 'DE', count: 1 }]);
  assert.deepEqual(s.versions, [{ version: '1.0.0', count: 2 }, { version: '1.1.0-dev.abc1234', count: 1 }]);
  assert.deepEqual(s.channels, [{ channel: 'release', count: 2 }, { channel: 'dev', count: 1 }]);
  assert.deepEqual(s.arches, [{ arch: 'x64', count: 2 }, { arch: 'arm64', count: 1 }]);
  assert.deepEqual(s.systems, [{ os: 'linux', count: 2 }, { os: 'macos', count: 1 }]);
  assert.deepEqual([s.asOf, s.stale], ['2026-10-30', false]);
});

test('a few days without any pings leaves the numbers where they were', async () => {
  const db = d1();
  await joined(db, full(1), '2026-10-20');
  await joined(db, full(2), '2026-10-20');
  await joined(db, full(3), '2026-09-25'); // active on 10-20 (25 days back), would be dropped by 10-30
  assert.equal((await stats(db, '2026-10-20')).active, 3);
  // Ten days of silence: counted back from today one would vanish; counted from the last data, none do.
  const quiet = await stats(db, '2026-10-30');
  assert.equal(quiet.active, 3);
  assert.deepEqual([quiet.asOf, quiet.stale], ['2026-10-20', true]);
  // Two quiet days are not yet worth calling stale.
  assert.equal((await stats(db, '2026-10-22')).stale, false);
});

test('installs only grow; if the table looks emptier than before, the last good numbers are served', async () => {
  const db = d1();
  await joined(db, full(1), '2026-10-30');
  await joined(db, full(2), '2026-10-30');
  const first = await steadyStats(db, '2026-10-30');
  assert.deepEqual([first.installs, first.active], [2, 2]);

  // The table loses a row (a bad restore): the public number does not go down.
  db.sqlite.prepare('DELETE FROM installs WHERE id = ?').run(id(2));
  const after = await steadyStats(db, '2026-10-30');
  assert.deepEqual([after.installs, after.active, after.stale], [2, 2, true]);

  // New installs raise it again as normal.
  await joined(db, full(3), '2026-10-30');
  await joined(db, full(4), '2026-10-30');
  assert.equal((await steadyStats(db, '2026-10-30')).installs, 3);
});

test('the public total cannot jump: a flood shows up a little each day', async () => {
  const db = d1();
  const add = db.sqlite.prepare(
    `INSERT INTO installs (id, first_seen, last_seen, first_hour, last_hour, days, version, arch, os, country)
     VALUES (?, '2026-10-28', '2026-10-30', 100, 200, 3, '1.0.0', 'x64', 'linux', 'US')`);
  for (let n = 1; n <= 10; n++) add.run(id(n));
  const first = await steadyStats(db, '2026-10-30');
  assert.equal(first.installs, 10);
  assert.ok(!('base' in first), 'the bookkeeping is not published');

  // 500 more arrive the same day: the room is 100 (the minimum), so the page says 110.
  for (let n = 11; n <= 510; n++) add.run(id(n));
  assert.deepEqual([(await steadyStats(db, '2026-10-30')).installs, (await steadyStats(db, '2026-10-30')).active], [110, 110]);
  // Tomorrow it moves on from there, and so on until it has caught up.
  assert.equal((await steadyStats(db, '2026-10-31')).installs, 210);
  assert.equal((await steadyStats(db, '2026-11-01')).installs, 310);
});

test('if the numbers cannot be worked out at all, the last good ones are served', async () => {
  const db = d1();
  await joined(db, full(1), '2026-10-30');
  await steadyStats(db, '2026-10-30');
  const down = () => { throw new Error('D1 is down'); };
  const broken = {
    prepare: (sql) => (sql.includes('FROM installs')
      ? { bind: () => ({ first: async () => down(), all: async () => down(), run: async () => down() }) }
      : db.prepare(sql)),
  };
  const served = await steadyStats(broken, '2026-10-30');
  assert.deepEqual([served.installs, served.stale], [1, true]);
  // …and with nothing remembered there is simply no answer.
  assert.equal(await steadyStats({ prepare: () => ({ bind: () => ({ first: async () => down() }) }) }, '2026-10-30'), null);
});

test('an empty table is zeroes, not an error', async () => {
  const s = await stats(d1(), '2026-10-30');
  assert.deepEqual([s.installs, s.active, s.today, s.regions.length], [0, 0, 0, 0]);
});

test('a database made from the earlier schema can be moved over without losing a row', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE installs (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, version TEXT NOT NULL,
    arch TEXT NOT NULL, os TEXT NOT NULL, country TEXT NOT NULL, pings INTEGER NOT NULL DEFAULT 1);
    INSERT INTO installs VALUES ('a', '2026-10-01', '2026-10-03', '1.0.0', 'x64', 'linux', 'US', 3);
    INSERT INTO installs VALUES ('b', '2026-10-01', '2026-10-01', '1.0.0', 'x64', 'linux', 'US', 1);
    INSERT INTO installs VALUES ('c', '2026-10-01', '2026-10-20', '1.0.0', 'x64', 'linux', 'US', 2);`);
  sqlite.exec(readFileSync(new URL('../migrate-2026-10-30.sql', import.meta.url), 'utf8'));
  const rows = Object.fromEntries(sqlite.prepare('SELECT * FROM installs').all().map((r) => [r.id, { ...r }]));
  const midnight = Date.parse('2026-10-01T00:00:00Z') / 3_600_000;
  assert.deepEqual([rows.a.days, rows.b.days, rows.c.days], [3, 1, 2]); // never more days than check-ins
  assert.deepEqual([rows.a.first_hour, rows.a.last_hour], [midnight + 12, midnight + 48 + 12]);
});

// ---------------------------------------------------------------------------------------- real versions

test('a version is real if it is a release GitHub lists or a development build; the list is asked for rarely', async () => {
  const db = d1();
  let calls = 0;
  let list = ['1.0.0', '1.1.0'];
  const listReleases = async () => { calls += 1; return list; };
  let t = 1000;
  const now = () => t;
  assert.equal(await isKnownVersion(db, listReleases, '1.1.0', now), true);
  assert.equal(await isKnownVersion(db, listReleases, '9.9.9', now), false);
  assert.equal(calls, 1);
  // Invented numbers asked about again and again do not reach GitHub again for five minutes.
  for (let n = 0; n < 5; n++) assert.equal(await isKnownVersion(db, listReleases, `8.8.${n}`, now), false);
  assert.equal(calls, 1);
  // A release published since turns up after the wait.
  list = ['1.0.0', '1.1.0', '1.2.0'];
  assert.equal(await isKnownVersion(db, listReleases, '1.2.0', now), false);
  t += 301;
  assert.equal(await isKnownVersion(db, listReleases, '1.2.0', now), true);
  assert.equal(calls, 2);
  // A development build is accepted without asking anyone.
  assert.equal(await isKnownVersion(db, listReleases, '1.2.0-dev.abc1234', now), true);
  assert.equal(calls, 2);
});

test('when GitHub cannot say: trust the shape if nothing is remembered, the remembered list if there is one', async () => {
  const down = async () => null;
  assert.equal(await isKnownVersion(d1(), down, '1.0.0'), true);

  const db = d1();
  let t = 1000;
  await isKnownVersion(db, async () => ['1.0.0'], '1.0.0', () => t);
  t += 400;
  assert.equal(await isKnownVersion(db, down, '1.0.0', () => t), true);
  assert.equal(await isKnownVersion(db, down, '7.7.7', () => t), false);
});

// ---------------------------------------------------------------------------------------------- Worker

const releases = [{ tag_name: 'v1.4.0' }, { tag_name: 'v1.0.0' }];
// GitHub as the Worker sees it: the newest release, and the list of releases.
function github() {
  const calls = { latest: 0, list: 0 };
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/releases/latest')) {
      calls.latest += 1;
      return new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.4.0', name: 'v1.4.0' }));
    }
    calls.list += 1;
    return new Response(JSON.stringify(releases));
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

async function ping(db, query, country = 'NZ') {
  const waiting = [];
  const request = new Request(`https://versions.papyra.app/latest.json?${query}`, {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' },
  });
  // What the edge adds to a request: the country (never the address, to this code).
  Object.defineProperty(request, 'cf', { value: { country } });
  const res = await worker.fetch(request, { DB: db, GITHUB_REPO: 'lyfie-org/papyra' }, { waitUntil: (p) => waiting.push(p) });
  await Promise.all(waiting);
  return res;
}

test('the Worker answers with the release, counts the install, and keeps nothing else', async () => {
  const db = d1();
  const gh = github();
  try {
    const res = await ping(db, `id=${id(7)}&v=1.0.0&arch=arm64&os=linux`);
    assert.deepEqual(await res.json(), { version: '1.4.0', url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.4.0' });
    const rows = db.sqlite.prepare('SELECT * FROM installs').all();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].country, rows[0].arch, rows[0].os, rows[0].days], ['NZ', 'arm64', 'linux', 1]);
    // Nothing in the table could hold the address.
    assert.ok(!JSON.stringify(rows).includes('203.0.113'));
    assert.deepEqual(db.sqlite.prepare('PRAGMA table_info(installs)').all().map((c) => c.name),
      ['id', 'first_seen', 'last_seen', 'first_hour', 'last_hour', 'days', 'version', 'arch', 'os', 'country', 'pings']);
  } finally {
    gh.restore();
  }
});

test('a version nobody released is answered like any other but never counted', async () => {
  const db = d1();
  const gh = github();
  try {
    const res = await ping(db, `id=${id(1)}&v=9.9.9`);
    assert.equal(res.status, 200);
    await ping(db, `id=${id(2)}&v=1.4.0-dev.abc1234`);
    await ping(db, `id=${id(3)}&v=1.4.0`);
    assert.deepEqual(db.sqlite.prepare('SELECT id FROM installs ORDER BY id').all().map((r) => r.id), [id(2), id(3)]);
  } finally {
    gh.restore();
  }
});

test('stats are public and cacheable; unknown paths are 404', async () => {
  const db = d1();
  const res = await worker.fetch(new Request('https://versions.papyra.app/stats.json'), { DB: db }, { waitUntil() {} });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).installs, 0);
  assert.equal((await worker.fetch(new Request('https://versions.papyra.app/nope'), { DB: db }, {})).status, 404);
});

test('the latest release is asked of GitHub at most once an hour, and its last answer survives GitHub being down', async () => {
  const db = d1();
  const saved = globalThis.fetch;
  let calls = 0;
  let up = true;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/releases/latest')) return new Response(JSON.stringify(releases));
    calls += 1;
    return up
      ? new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.4.0' }))
      : new Response('rate limited', { status: 403 });
  };
  const ask = () => worker.fetch(new Request(`https://versions.papyra.app/latest.json?id=${id(9)}&v=1.0.0`), { DB: db, GITHUB_REPO: 'lyfie-org/papyra' }, { waitUntil() {} });
  try {
    assert.equal((await (await ask()).json()).version, '1.4.0');
    assert.equal((await (await ask()).json()).version, '1.4.0');
    assert.equal(calls, 1); // the second was answered from what we kept

    // A day later GitHub is down: the last release we heard of is still the answer.
    db.sqlite.prepare("UPDATE meta SET updated_at = updated_at - 90000 WHERE key = 'latest'").run();
    up = false;
    const res = await ask();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, '1.4.0');
  } finally {
    globalThis.fetch = saved;
  }
});

test('with no memory and GitHub down, the answer is an honest 502 (the install just tries again tomorrow)', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const res = await worker.fetch(new Request('https://versions.papyra.app/latest.json'), { DB: d1(), GITHUB_REPO: 'lyfie-org/papyra' }, { waitUntil() {} });
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = saved;
  }
});
