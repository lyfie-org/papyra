// Counting installs — the whole of it. No IP address passes through this file: the caller hands
// over a country code (read from the connection by Cloudflare) and the facts the app sent.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 1.2.3, or a development build: 1.2.3-dev.abc1234
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,40})?$/;
const ARCHES = ['x64', 'arm64', 'arm'];
const SYSTEMS = ['linux', 'windows', 'macos'];

/**
 * The facts a Papyra install sends (`?id=<random uuid>&v=<version>&arch=<x64|arm64|arm>&os=<linux|windows|macos>`)
 * plus the country, or null when the request isn't one (then it is simply not counted).
 * @param {URLSearchParams} params
 * @param {string | null | undefined} country a two-letter code from the edge; anything else becomes "ZZ"
 */
export function cleanPing(params, country) {
  const id = params.get('id') ?? '';
  const version = params.get('v') ?? '';
  if (!UUID.test(id) || !VERSION.test(version)) return null;
  const code = typeof country === 'string' ? country.toUpperCase() : '';
  const arch = (params.get('arch') ?? '').toLowerCase();
  const os = (params.get('os') ?? '').toLowerCase();
  return {
    id: id.toLowerCase(),
    version,
    // Only the families we list are kept; anything else is "other".
    arch: ARCHES.includes(arch) ? arch : 'other',
    os: SYSTEMS.includes(os) ? os : 'other',
    // "XX" is no country and "T1" is Tor: both are just "unknown".
    country: /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : 'ZZ',
  };
}

/** Count this install: new ones are added, known ones are marked seen today. @param {D1Like} db */
export async function record(db, ping, today) {
  await db.prepare(
    `INSERT INTO installs (id, first_seen, last_seen, version, arch, os, country) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET last_seen = ?2, version = ?3, arch = ?4, os = ?5, country = ?6, pings = pings + 1`,
  ).bind(ping.id, today, ping.version, ping.arch, ping.os, ping.country).run();
}

/** An install is "active" if it has checked in within this many days. */
export const ACTIVE_DAYS = 30;

/** Days between two yyyy-mm-dd dates (b − a). */
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * The public numbers (served at /stats.json and shown on papyra.app). @param {D1Like} db
 *
 * "Active in the last 30 days" is counted back from the newest check-in we have, not from the clock.
 * So if no pings arrive for a few days — a glitch here, an outage there — the numbers hold where they
 * were instead of draining away, and `stale` says that the data is behind. Normally the newest
 * check-in is today and this is the same thing as counting back from today.
 */
export async function stats(db, today) {
  const newest = (await db.prepare('SELECT MAX(last_seen) AS day FROM installs').bind().first())?.day;
  const asOf = newest && newest < today ? newest : today;
  const since = `date(?1, '-${ACTIVE_DAYS} days')`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS installs,
            COALESCE(SUM(last_seen >= ${since}), 0) AS active,
            COALESCE(SUM(last_seen = ?1), 0) AS day FROM installs`,
  ).bind(asOf).first();
  const grouped = async (expression) => (await db.prepare(
    `SELECT ${expression} AS name, COUNT(*) AS count FROM installs WHERE last_seen >= ${since}
     GROUP BY name ORDER BY count DESC, name LIMIT 12`,
  ).bind(asOf).all()).results ?? [];
  return {
    installs: row?.installs ?? 0,
    active: row?.active ?? 0,
    today: row?.day ?? 0,
    activeDays: ACTIVE_DAYS,
    regions: (await grouped('country')).map((r) => ({ country: r.name, count: r.count })),
    versions: (await grouped('version')).map((r) => ({ version: r.name, count: r.count })),
    channels: (await grouped("CASE WHEN version LIKE '%-%' THEN 'dev' ELSE 'release' END")).map((r) => ({ channel: r.name, count: r.count })),
    arches: (await grouped('arch')).map((r) => ({ arch: r.name, count: r.count })),
    systems: (await grouped('os')).map((r) => ({ os: r.name, count: r.count })),
    asOf,
    // Behind by more than a couple of days: pings have stopped arriving (the numbers are the last good ones).
    stale: daysBetween(asOf, today) > 2,
    updated: today,
  };
}

/**
 * What /stats.json answers with: the live numbers, steadied by the last good ones. Installs only ever
 * grow, so a count lower than one already shown is wrong; and if the live numbers can't be worked
 * out at all, the last good ones are served. @param {D1Like} db
 */
export async function steadyStats(db, today, now = () => Math.floor(Date.now() / 1000)) {
  const remembered = async () => {
    try {
      const row = await db.prepare("SELECT value FROM meta WHERE key = 'stats'").bind().first();
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  };
  let live = null;
  try {
    live = await stats(db, today);
  } catch {
    /* fall through to what we remembered */
  }
  const before = await remembered();
  if (!live) return before ? { ...before, stale: true } : null;
  if (before && live.installs < before.installs) {
    // Rows never leave the table, so fewer than before means the table is incomplete (a restore, a bad
    // migration): keep showing the last good numbers.
    return { ...before, stale: true };
  }
  if (!before || before.installs !== live.installs || before.active !== live.active || before.asOf !== live.asOf) {
    await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('stats', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
      .bind(JSON.stringify(live), now()).run().catch(() => {});
  }
  return live;
}

/**
 * @typedef {{ prepare(sql: string): { bind(...values: unknown[]): {
 *   run(): Promise<unknown>, first(): Promise<any>, all(): Promise<{ results: any[] }> } } }} D1Like
 */
