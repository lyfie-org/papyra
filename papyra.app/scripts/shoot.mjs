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

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { CAPTURE_CSS, demoUrl, serve, stageDesk } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'src/assets/shots');

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

// The desk is staged before capture (see stageDesk): the demo's "Start here"
// note talks about the demo, which is not what a product shot should show.
const DESK = { archive: ['welcome'], pin: ['sourdough', 'reading-list'] };

const SHOTS = [
  { name: 'desk', path: '/', wait: '.note-card', viewports: ['desktop', 'mobile'], stage: DESK },
  {
    name: 'focus',
    path: '/note/sourdough',
    wait: '[contenteditable="true"]',
    viewports: ['desktop'],
    stage: DESK,
    then: (page) => page.getByRole('button', { name: 'Focus mode' }).click(),
  },
  {
    name: 'search',
    path: '/',
    wait: '.note-card',
    viewports: ['desktop'],
    stage: DESK,
    then: async (page) => {
      await page.locator('.search__input').click();
      await page.keyboard.type('pricing', { delay: 40 });
      await page.waitForTimeout(900);
    },
  },
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
      await page.goto(demoUrl(PORT, '/'), { waitUntil: 'networkidle' });
      await page.evaluate(() => localStorage.removeItem('papyra-demo-vault'));
      await page.reload({ waitUntil: 'networkidle' });
      await stageDesk(page, shot.stage);
      await page.goto(demoUrl(PORT, shot.path), { waitUntil: 'networkidle' });
      try {
        await page.waitForSelector(shot.wait, { timeout: 15_000 });
      } catch {
        console.warn(`  ! ${shot.name}: "${shot.wait}" never appeared — skipped`);
        continue;
      }
      await page.addStyleTag({ content: CAPTURE_CSS });
      if (shot.then) {
        await shot.then(page);
        await page.waitForTimeout(900);
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
