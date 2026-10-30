// Is this version number one that exists? A request can say any number; only real releases (and development
// builds, which carry the commit they were made from) are counted. The list of releases comes from GitHub
// and is kept: it is asked for again only when someone reports a number we don't have, and then at most once
// every five minutes, so a flood of invented versions can't turn into a flood of calls to GitHub.

const DEV = /^\d+\.\d+\.\d+-dev\.[0-9a-f]{7,12}$/;
const STABLE = /^\d+\.\d+\.\d+$/;
const RECHECK_SECONDS = 300;

/**
 * @param {import('./count.js').D1Like} db
 * @param {() => Promise<string[] | null>} listReleases every release number, or null when GitHub can't say
 * @param {string} version a number that already looks like one
 */
export async function isKnownVersion(db, listReleases, version, now = () => Math.floor(Date.now() / 1000)) {
  if (DEV.test(version)) return true;
  if (!STABLE.test(version)) return false;

  let kept = null;
  try {
    const row = await db.prepare("SELECT value, updated_at FROM meta WHERE key = 'releases'").bind().first();
    if (row) kept = { versions: JSON.parse(row.value), age: now() - row.updated_at };
  } catch { /* no memory of it yet */ }
  if (kept?.versions.includes(version)) return true;
  // GitHub can't say (nothing remembered): trust the shape rather than lose real installs. A list that is
  // remembered and doesn't have the number means it isn't counted today (the install asks again tomorrow).
  const listed = kept !== null && kept.versions.length > 0;
  if (kept && kept.age < RECHECK_SECONDS) return !listed;

  let fresh = null;
  try { fresh = await listReleases(); } catch { /* fall back to what we kept */ }
  // A failed attempt is remembered too (with the old list), so GitHub is not asked again within the window.
  const list = fresh?.length ? fresh : kept?.versions ?? [];
  await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('releases', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(JSON.stringify(list), now()).run().catch(() => {});
  return list.length > 0 ? list.includes(version) : true;
}
