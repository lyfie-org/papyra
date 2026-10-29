import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cleanPing, record, stats, steadyStats } from '../src/count.js';
import worker from '../src/index.js';

// Node's own SQLite behind the few D1 calls the Worker makes.
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
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

test('a ping is a random id, a version, a processor family and an OS family; anything else is not counted', () => {
  assert.deepEqual(cleanPing(params({ id: id(1), v: '1.2.3', arch: 'arm64', os: 'macos' }), 'us'),
    { id: id(1), version: '1.2.3', arch: 'arm64', os: 'macos', country: 'US' });
  assert.equal(cleanPing(params({ id: 'not-a-uuid', v: '1.2.3' }), 'US'), null);
  assert.equal(cleanPing(params({ id: id(1), v: 'dev' }), 'US'), null);
  assert.equal(cleanPing(params({}), 'US'), null);
});

test('a development build reports its development version', () => {
  assert.equal(cleanPing(params({ id: id(1), v: '1.1.0-dev.abc1234' }), 'US').version, '1.1.0-dev.abc1234');
  assert.equal(cleanPing(params({ id: id(1), v: '1.1.0-' }), 'US'), null);
  assert.equal(cleanPing(params({ id: id(1), v: '1.1.0-dev abc' }), 'US'), null);
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

test('the same install is counted once, however often it checks in', async () => {
  const db = d1();
  const ping = full(1);
  await record(db, ping, '2026-10-01');
  await record(db, { ...ping, version: '1.1.0', country: 'DE', arch: 'arm64' }, '2026-10-02');
  const rows = db.sqlite.prepare('SELECT * FROM installs').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { id: id(1), first_seen: '2026-10-01', last_seen: '2026-10-02', version: '1.1.0', arch: 'arm64', os: 'linux', country: 'DE', pings: 2 });
});

test('stats count installs ever seen, active in the last 30 days, and seen today', async () => {
  const db = d1();
  await record(db, full(1), '2026-10-30'); // today
  await record(db, full(2), '2026-10-12'); // active
  await record(db, full(3, { version: '1.1.0-dev.abc1234', country: 'DE', arch: 'arm64', os: 'macos' }), '2026-10-01'); // active (30 days)
  await record(db, full(4, { version: '0.9.0', country: 'JP' }), '2026-08-01'); // gone quiet
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
  await record(db, full(1), '2026-10-20');
  await record(db, full(2), '2026-10-20');
  await record(db, full(3), '2026-09-25'); // active on 10-20 (25 days back), would be dropped by 10-30
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
  await record(db, full(1), '2026-10-30');
  await record(db, full(2), '2026-10-30');
  const first = await steadyStats(db, '2026-10-30');
  assert.deepEqual([first.installs, first.active], [2, 2]);

  // The table loses a row (a bad restore): the public number does not go down.
  db.sqlite.prepare('DELETE FROM installs WHERE id = ?').run(id(2));
  const after = await steadyStats(db, '2026-10-30');
  assert.deepEqual([after.installs, after.active, after.stale], [2, 2, true]);

  // New installs raise it again as normal.
  await record(db, full(3), '2026-10-30');
  await record(db, full(4), '2026-10-30');
  assert.equal((await steadyStats(db, '2026-10-30')).installs, 3);
});

test('if the numbers cannot be worked out at all, the last good ones are served', async () => {
  const db = d1();
  await record(db, full(1), '2026-10-30');
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

test('the Worker answers with the release, counts the install, and keeps nothing else', async () => {
  const db = d1();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.4.0', name: 'v1.4.0' }));
  try {
    const waiting = [];
    const request = new Request(`https://versions.papyra.app/latest.json?id=${id(7)}&v=1.0.0&arch=arm64&os=linux`, {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' },
    });
    // What the edge adds to a request: the country (never the address, to this code).
    Object.defineProperty(request, 'cf', { value: { country: 'NZ' } });
    const res = await worker.fetch(request, { DB: db, GITHUB_REPO: 'lyfie-org/papyra' }, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);

    assert.deepEqual(await res.json(), { version: '1.4.0', url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.4.0' });
    const rows = db.sqlite.prepare('SELECT * FROM installs').all();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].country, rows[0].arch, rows[0].os], ['NZ', 'arm64', 'linux']);
    // Nothing in the table could hold the address.
    assert.ok(!JSON.stringify(rows).includes('203.0.113'));
    assert.deepEqual(db.sqlite.prepare('PRAGMA table_info(installs)').all().map((c) => c.name),
      ['id', 'first_seen', 'last_seen', 'version', 'arch', 'os', 'country', 'pings']);
  } finally {
    globalThis.fetch = saved;
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
  globalThis.fetch = async () => {
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
