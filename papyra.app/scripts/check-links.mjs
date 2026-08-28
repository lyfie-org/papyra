// Fail the build on a dead internal link.
//
// A static site's worst failure mode is a link that silently 404s: nothing
// errors, nothing logs, and you find out from a reader. This walks every built
// page, collects same-origin hrefs, and checks each one resolves to a file in
// dist/ — including #fragments, which must exist as an id on the target page.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';

const DIST = resolve(import.meta.dirname, '../dist');

const pages = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (extname(full) === '.html') pages.push(full);
  }
})(DIST);

/** Anchor ids present on a built page, so #fragments can be verified too. */
const idCache = new Map();
const idsOf = (file) => {
  if (!idCache.has(file)) {
    idCache.set(
      file,
      new Set([...readFileSync(file, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])),
    );
  }
  return idCache.get(file);
};

const resolveTarget = (path) => {
  const clean = path.split('?')[0] || '/';
  const direct = join(DIST, clean);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const asDir = join(DIST, clean, 'index.html');
  if (existsSync(asDir)) return asDir;
  return null;
};

const problems = [];

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const from = page.slice(DIST.length).split(sep).join('/');

  for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
    // The demo is a client-side-routed SPA served via a 404.html fallback; its
    // routes deliberately have no file behind them.
    if (href.startsWith('/demo')) continue;

    const [path, hash] = href.split('#');
    const target = resolveTarget(path);
    if (!target) {
      problems.push(`${from} -> ${href}   (no such page)`);
      continue;
    }
    if (hash && !idsOf(target).has(hash)) {
      problems.push(`${from} -> ${href}   (no #${hash} on that page)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-links: ${problems.length} dead internal link(s)\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`check-links: ${pages.length} pages, all internal links resolve`);
