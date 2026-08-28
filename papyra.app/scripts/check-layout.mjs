// Fail on horizontal overflow, in a real browser, at real viewport sizes.
//
// Sideways scroll is the classic responsive bug and it is invisible until
// somebody opens the site on a phone: one wide table, one long unbroken string,
// one grid that will not shrink. This loads every built page at a narrow and a
// wide viewport and fails if the document scrolls horizontally — naming the
// element responsible, because "the page overflows" on its own is not actionable.
//
//   pnpm --filter papyra-app run build     # dist/ must exist
//   pnpm --filter papyra-app run check:layout

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve(import.meta.dirname, '../dist');
const PORT = 4401;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

if (!existsSync(DIST)) {
  console.error('check-layout: dist/ not found. Run the build first.');
  process.exit(1);
}

/** Every built page, as a URL path. The demo is excluded — it is a separate app. */
const pages = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'demo' || entry === '_astro') continue;
      walk(full);
    } else if (entry === 'index.html') {
      pages.push(full.slice(DIST.length, -'index.html'.length).split(sep).join('/') || '/');
    }
  }
})(DIST);

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let file = join(DIST, path);
  if (existsSync(file) && !extname(file)) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(PORT, ok));

const VIEWPORTS = [
  { label: 'mobile', width: 320, height: 780 },
  { label: 'desktop', width: 1440, height: 900 },
];

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.error(
    'check-layout: could not launch Chromium. Install it once with:\n' +
      '  pnpm --filter papyra-app exec playwright install chromium\n\n' +
      String(err.message).split('\n')[0],
  );
  server.close();
  process.exit(1);
}

const problems = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();

  for (const path of pages) {
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflow = doc.scrollWidth - doc.clientWidth;
      if (overflow <= 0) return { overflow: 0, culprits: [] };

      // Name what actually sticks out, so the failure is fixable.
      const limit = doc.clientWidth;
      const culprits = [];
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.right <= limit + 1) continue;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        culprits.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} (right: ${Math.round(rect.right)}px)`);
        if (culprits.length === 3) break;
      }
      return { overflow, culprits };
    });

    if (result.overflow > 0) {
      problems.push(
        `${viewport.label} ${viewport.width}px  ${path}  overflows by ${result.overflow}px\n` +
          result.culprits.map((c) => `      ${c}`).join('\n'),
      );
    }
  }

  await context.close();
}

await browser.close();
server.close();

if (problems.length > 0) {
  console.error(`check-layout: ${problems.length} page(s) scroll horizontally\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(
  `check-layout: ${pages.length} pages x ${VIEWPORTS.length} viewports, no horizontal overflow`,
);
process.exit(0);
