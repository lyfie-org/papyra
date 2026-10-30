// versions.papyra.app — what a Papyra install's daily update check talks to. Two routes:
//
//   GET /latest.json?id=&v=&arch=&os=   the newest release; counts the install
//   GET /stats.json                     the public numbers (shown on papyra.app)
//
// Nothing here reads, keeps or logs an IP address. Cloudflare resolves the connection to a country
// code at its edge (`request.cf.country`); only that two-letter code reaches this code. There is no
// console.log, and `observability` is off in wrangler.toml. Details: ../README.md. A request that looks like
// an install is only counted if its version is real and there is room (count.js, known.js).

import { cleanPing, record, steadyStats } from './count.js';
import { isKnownVersion } from './known.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const LATEST_FRESH_SECONDS = 3600;

const today = () => new Date().toISOString().slice(0, 10);
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A number from the environment (wrangler.toml [vars]), or undefined to use the built-in default. */
const setting = (value) => (Number.isFinite(Number(value)) && value !== undefined && value !== '' ? Number(value) : undefined);

function githubHeaders(env) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'papyra-versions' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`; // optional: only for a higher rate limit
  return headers;
}

/** Every release number GitHub lists for the repository; null when GitHub can't say. */
async function releaseNumbers(env) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases?per_page=100`, { headers: githubHeaders(env) });
  if (!res.ok) return null;
  const releases = await res.json();
  return Array.isArray(releases)
    ? releases.map((r) => String(r.tag_name ?? '').replace(/^v/, '')).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    : null;
}

/** GitHub's newest release, in the shape the update popup wants; null when GitHub can't say. */
async function fromGitHub(env) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, { headers: githubHeaders(env) });
  if (!res.ok) return null;
  const release = await res.json();
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return { version, url: release.html_url };
}

/**
 * The newest release. GitHub is asked at most once an hour, and its last answer is kept: if it is down
 * or rate-limiting, installs still get the last release we heard of rather than an error.
 */
async function latestRelease(env) {
  let kept = null;
  try {
    const row = await env.DB.prepare("SELECT value, updated_at FROM meta WHERE key = 'latest'").bind().first();
    if (row) kept = { ...JSON.parse(row.value), age: nowSeconds() - row.updated_at };
  } catch { /* no memory of it yet */ }
  if (kept && kept.age < LATEST_FRESH_SECONDS) return { version: kept.version, url: kept.url };

  try {
    const fresh = await fromGitHub(env);
    if (fresh) {
      await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('latest', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
        .bind(JSON.stringify(fresh), nowSeconds()).run().catch(() => {});
      return fresh;
    }
  } catch { /* fall back to what we kept */ }
  return kept ? { version: kept.version, url: kept.url } : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/latest.json') {
      // Count it (if it looks like an install), but never make the answer wait for or depend on that.
      const ping = cleanPing(url.searchParams, request.cf?.country ?? request.headers.get('cf-ipcountry'));
      if (ping) {
        ctx.waitUntil((async () => {
          if (!(await isKnownVersion(env.DB, () => releaseNumbers(env), ping.version))) return;
          await record(env.DB, ping, new Date(), { maxNewPerHour: setting(env.MAX_NEW_PER_HOUR) });
        })().catch(() => {}));
      }
      const latest = await latestRelease(env);
      return new Response(JSON.stringify(latest ?? { error: 'unavailable' }), {
        status: latest ? 200 : 502,
        headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/stats.json') {
      const stats = await steadyStats(env.DB, today(), nowSeconds, { min: setting(env.SURGE_MIN), share: setting(env.SURGE_SHARE) });
      return new Response(JSON.stringify(stats ?? { error: 'unavailable' }), {
        status: stats ? 200 : 503,
        headers: { ...JSON_HEADERS, 'access-control-allow-origin': '*', 'cache-control': stats ? 'public, max-age=300' : 'no-store' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
