// Public numbers for the site — GitHub stars and Docker Hub pulls — fetched once
// at build time and baked into the HTML.
//
// Nothing here runs in the browser or on Cloudflare: the site stays fully static
// (no Pages Functions, no Workers, so no request limits however many people
// visit), and it still makes no third-party requests from a visitor's browser.
// The numbers refresh whenever the site is rebuilt — on every push, and once a
// day from the scheduled run in .github/workflows/site.yml. If an API is slow or
// rate-limits the build, the number is simply left out.

const cache = new Map();

/** Fetch JSON once per build; null on any failure. */
function once(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        try {
          const res = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'papyra.app build' },
            signal: AbortSignal.timeout(5000),
          });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return cache.get(url);
}

/** @returns {Promise<number | null>} */
export async function starCount() {
  const data = await once('https://api.github.com/repos/lyfie-org/papyra');
  return typeof data?.stargazers_count === 'number' ? data.stargazers_count : null;
}

/** @returns {Promise<number | null>} */
export async function dockerPulls() {
  const data = await once('https://hub.docker.com/v2/repositories/lyfie/papyra/');
  return typeof data?.pull_count === 'number' ? data.pull_count : null;
}

/**
 * A count rounded down to something honest and readable: 4577 → "4,500+",
 * 12 840 → "12k+". Never rounds up.
 * @param {number} n
 */
export function roundedCount(n) {
  if (n >= 10_000) return `${Math.floor(n / 1000).toLocaleString('en-GB')}k+`;
  if (n >= 1_000) return `${(Math.floor(n / 100) * 100).toLocaleString('en-GB')}+`;
  return n.toLocaleString('en-GB');
}
