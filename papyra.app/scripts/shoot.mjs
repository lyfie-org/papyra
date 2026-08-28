// Screenshot the live demo for the feature pages.
//
// The shots are of the REAL application — the demo build is papyra.web with an
// in-browser fake server, so what is captured here is the product, not a mockup
// that will quietly go stale. Seeded data is fixed, so re-running this produces
// byte-comparable images and a reviewable diff.
//
//   pnpm --filter papyra-app run build      # dist/ must exist first
//   pnpm --filter papyra-app run shoot
//
// One-time, to fetch the browser binary:
//   pnpm --filter papyra-app exec playwright install chromium
//
// NEVER point this at a real vault. papyra.api/src/Papyra.Api/.localdata holds
// dev notes with names like bank-details.md and passwords-hint.md.

import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'src/assets/shots');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve dist/ the way Cloudflare Pages does — in particular, falling back to the
 * nearest parent 404.html, which is what makes the demo's client-side routes
 * resolve. Node's own http module rather than a dependency: it is thirty lines
 * and it keeps the screenshot pipeline out of the deploy toolchain.
 */
function serve(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    // normalize + prefix check: a screenshot script is still a web server, and
    // `..` in a path must not escape dist/.
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(DIST, path);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }

    if (existsSync(file) && !extname(file)) file = join(file, 'index.html');
    if (!existsSync(file)) {
      // Nearest parent 404.html, walking up — /demo/note/x → /demo/404.html.
      let dir = join(DIST, path);
      let fallback = null;
      while (dir.startsWith(DIST)) {
        const candidate = join(dir, '404.html');
        if (existsSync(candidate)) {
          fallback = candidate;
          break;
        }
        dir = resolve(dir, '..');
      }
      if (!fallback) {
        res.writeHead(404).end('not found');
        return;
      }
      file = fallback;
    }

    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok) => server.listen(port, () => ok(server)));
}

/**
 * What to capture. `wait` is a selector that proves the view actually rendered.
 *
 * Only shots a page actually uses are listed: every file here is committed and
 * optimised at build time, so capturing views "just in case" is dead weight in
 * the repository. Add a viewport when a page needs it.
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const SHOTS = [
  { name: 'grid', path: '/demo/', wait: '.note-card', viewports: ['desktop', 'mobile'] },
  { name: 'editor', path: '/demo/note/revenue-model', wait: '[contenteditable="true"]', viewports: ['desktop'] },
  { name: 'vault', path: '/demo/vault', wait: '.workspace', viewports: ['desktop'] },
  { name: 'categories', path: '/demo/categories', wait: '.workspace', viewports: ['desktop'] },
];

const PORT = 4399;

if (!existsSync(DIST)) {
  console.error('shoot: dist/ not found. Run `pnpm --filter papyra-app run build` first.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const server = await serve(PORT);
console.log(`shoot: serving dist/ on :${PORT}`);

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.error(
    'shoot: could not launch Chromium. Install it once with:\n' +
      '  pnpm --filter papyra-app exec playwright install chromium\n\n' +
      String(err.message).split('\n')[0],
  );
  server.close();
  process.exit(1);
}

let count = 0;

for (const theme of ['light', 'dark']) {
  for (const [label, size] of Object.entries(VIEWPORTS)) {
    const wanted = SHOTS.filter((s) => s.viewports.includes(label));
    if (wanted.length === 0) continue;

    const context = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 2,
      colorScheme: theme,
      // Freeze the clock: the seed ages its notes relative to "now", and a
      // moving date would make every screenshot differ on every run.
      locale: 'en-GB',
      timezoneId: 'UTC',
    });

    // Both keys are read before first paint: the app's own theme key, and the
    // demo banner's dismissal, which would otherwise sit over the UI.
    await context.addInitScript(
      ([t]) => {
        try {
          localStorage.setItem('papyra-theme', t);
          sessionStorage.setItem('papyra-demo-banner-dismissed', '1');
        } catch {
          /* storage blocked — the shot is just less clean */
        }
      },
      [theme],
    );

    const page = await context.newPage();

    for (const shot of wanted) {
      await page.goto(`http://localhost:${PORT}${shot.path}`, { waitUntil: 'networkidle' });
      try {
        await page.waitForSelector(shot.wait, { timeout: 15_000 });
      } catch {
        console.warn(`  ! ${shot.name}: "${shot.wait}" never appeared — skipped`);
        continue;
      }
      // Let the grid's entry animation settle so cards are not caught mid-fade.
      await page.waitForTimeout(600);

      const file = join(OUT, `${shot.name}-${label}-${theme}.png`);
      await page.screenshot({ path: file });
      count += 1;
      console.log(`  ${shot.name}-${label}-${theme}.png`);
    }

    await context.close();
  }
}

await browser.close();
server.close();
console.log(`\nshoot: ${count} screenshots → src/assets/shots/`);
