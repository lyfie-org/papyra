// Counting installs — the whole of it. No IP address passes through this file: the caller hands
// over a country code (read from the connection by Cloudflare) and the facts the app sent.
//
// Anyone can send a request that looks like an install, so the numbers are built to be hard to move:
//   • an install counts only once it has checked in on two different days at least 24 hours apart;
//   • only so many new installs are taken in each hour;
//   • an install that has already checked in today costs no write at all;
//   • the public number can't jump by more than a set amount in a day (see steadyStats).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 1.2.3, or a development build: 1.2.3-dev.abc1234 (the commit it was built from)
const VERSION = /^\d+\.\d+\.\d+(-dev\.[0-9a-f]{7,12})?$/;
const ARCHES = ['x64', 'arm64', 'arm'];
const SYSTEMS = ['linux', 'windows', 'macos'];

/** An install counts once it has checked in on this many different days… */
export const MIN_DAYS = 2;
/** …and at least this many hours separate its first check-in from its latest. */
export const MIN_SPAN_HOURS = 24;
/** New installs taken in per hour; the rest are simply asked again by the install tomorrow. */
export const MAX_NEW_PER_HOUR = 200;
/** The public number rises by at most this much a day, or this share of what it was (whichever is more). */
export const SURGE_MIN = 100;
export const SURGE_SHARE = 0.25;

const MATURE = `days >= ${MIN_DAYS} AND last_hour - first_hour >= ${MIN_SPAN_HOURS}`;

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

/**
 * Count this install: a new one is added (if this hour has room), a known one is marked seen on a new day.
 * Answers what happened: "new", "again", "seen" (already counted today: nothing written) or "held" (no room
 * this hour: not stored, and the install asks again tomorrow). @param {D1Like} db @param {Date} when
 */
export async function record(db, ping, when, limits = {}) {
  const day = when.toISOString().slice(0, 10);
  const hour = Math.floor(when.getTime() / 3_600_000);

  const known = await db.prepare('SELECT last_seen FROM installs WHERE id = ?1').bind(ping.id).first();
  if (known) {
    if (known.last_seen >= day) return 'seen';
    await db.prepare(
      `UPDATE installs SET last_seen = ?2, last_hour = ?3, version = ?4, arch = ?5, os = ?6, country = ?7,
         pings = pings + 1, days = days + 1 WHERE id = ?1`,
    ).bind(ping.id, day, hour, ping.version, ping.arch, ping.os, ping.country).run();
    return 'again';
  }

  const joined = (await db.prepare('SELECT COUNT(*) AS n FROM installs WHERE first_hour = ?1').bind(hour).first())?.n ?? 0;
  if (joined >= (limits.maxNewPerHour ?? MAX_NEW_PER_HOUR)) return 'held';
  await db.prepare(
    `INSERT INTO installs (id, first_seen, last_seen, first_hour, last_hour, days, version, arch, os, country)
     VALUES (?1, ?2, ?2, ?3, ?3, 1, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING`,
  ).bind(ping.id, day, hour, ping.version, ping.arch, ping.os, ping.country).run();
  return 'new';
}

/** An install is "active" if it has checked in within this many days. */
export const ACTIVE_DAYS = 30;

/** Days between two yyyy-mm-dd dates (b − a). */
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * The public numbers (served at /stats.json and shown on papyra.app). @param {D1Like} db
 *
 * Only installs that have matured (see MIN_DAYS) are counted. "Active in the last 30 days" is counted back
 * from the newest check-in we have, not from the clock. So if no pings arrive for a few days — a glitch here,
 * an outage there — the numbers hold where they were instead of draining away, and `stale` says that the data
 * is behind. Normally the newest check-in is today and this is the same thing as counting back from today.
 */
export async function stats(db, today) {
  const newest = (await db.prepare('SELECT MAX(last_seen) AS day FROM installs').bind().first())?.day;
  const asOf = newest && newest < today ? newest : today;
  const since = `date(?1, '-${ACTIVE_DAYS} days')`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS installs,
            COALESCE(SUM(last_seen >= ${since}), 0) AS active,
            COALESCE(SUM(last_seen = ?1), 0) AS day FROM installs WHERE ${MATURE}`,
  ).bind(asOf).first();
  const grouped = async (expression) => (await db.prepare(
    `SELECT ${expression} AS name, COUNT(*) AS count FROM installs WHERE ${MATURE} AND last_seen >= ${since}
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
 * grow, so a count lower than one already shown is wrong; if the live numbers can't be worked out at
 * all, the last good ones are served; and the totals can't jump by more than a set amount in a day —
 * a sudden flood of installs shows up gradually, which leaves time to look at it. @param {D1Like} db
 */
export async function steadyStats(db, today, now = () => Math.floor(Date.now() / 1000), surge = {}) {
  const min = surge.min ?? SURGE_MIN;
  const share = surge.share ?? SURGE_SHARE;
  const remembered = async () => {
    try {
      const row = await db.prepare("SELECT value FROM meta WHERE key = 'stats'").bind().first();
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  };
  // What the public sees: the remembered figures, without the bookkeeping.
  const shown = ({ base, ...rest }) => rest;
  let live = null;
  try {
    live = await stats(db, today);
  } catch {
    /* fall through to what we remembered */
  }
  const before = await remembered();
  if (!live) return before ? { ...shown(before), stale: true } : null;
  if (before && live.installs < before.installs) {
    // Rows never leave the table, so fewer than before means the table is incomplete (a restore, a bad
    // migration): keep showing the last good numbers.
    return { ...shown(before), stale: true };
  }

  // The totals as they stood when today began; today's figures may rise by a limited amount from there.
  const base = before?.base?.day === today ? before.base
    : { day: today, installs: before?.installs ?? live.installs, active: before?.active ?? live.active };
  const ceiling = (start) => start + Math.max(min, Math.ceil(start * share));
  const out = { ...live, installs: Math.min(live.installs, ceiling(base.installs)), active: Math.min(live.active, ceiling(base.active)) };

  if (!before || before.installs !== out.installs || before.active !== out.active || before.asOf !== out.asOf || before.base?.day !== base.day) {
    await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('stats', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
      .bind(JSON.stringify({ ...out, base }), now()).run().catch(() => {});
  }
  return out;
}

/**
 * @typedef {{ prepare(sql: string): { bind(...values: unknown[]): {
 *   run(): Promise<unknown>, first(): Promise<any>, all(): Promise<{ results: any[] }> } } }} D1Like
 */
