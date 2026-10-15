// Post-build: turn dist/ into the dev preview when PUBLIC_SITE_CHANNEL=dev.
//
// The pages already say noindex (Base.astro) and no sitemap is built
// (astro.config.mjs). This covers the two files Astro copies verbatim from
// public/: robots.txt is replaced with a blanket Disallow, and _headers gains an
// X-Robots-Tag on every path — which also reaches /demo and the plain-text
// twins, none of which carry a robots meta. A production build is left alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.PUBLIC_SITE_CHANNEL !== 'dev') process.exit(0);

const DIST = resolve(import.meta.dirname, '../dist');

writeFileSync(
  resolve(DIST, 'robots.txt'),
  '# Papyra dev preview — not for indexing. The real site is https://papyra.app\n\nUser-agent: *\nDisallow: /\n',
);

const headers = resolve(DIST, '_headers');
writeFileSync(
  headers,
  readFileSync(headers, 'utf8').replace(
    /^\/\*(\r?\n)/m,
    (_, eol) =>
      `/*${eol}  # Dev preview (dev.papyra.app): keep every path out of search results.${eol}  X-Robots-Tag: noindex, nofollow${eol}`,
  ),
);
if (!readFileSync(headers, 'utf8').includes('X-Robots-Tag: noindex')) {
  console.error('channel: could not add X-Robots-Tag to dist/_headers (no "/*" rule found).');
  process.exit(1);
}

console.log('channel: dev preview — robots.txt blocks all, X-Robots-Tag added.');
