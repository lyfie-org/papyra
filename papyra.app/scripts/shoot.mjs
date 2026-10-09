// Screenshot the live demo for the feature pages.
//
// The shots are of the REAL application — the demo build is papyra.web with an
// in-browser fake server, so what is captured here is the product, not a mockup
// that will quietly go stale. Seeded data is fixed, so re-running this produces
// byte-comparable images and a reviewable diff.
//
//   pnpm --filter papyra-app run build      # dist/ must exist first
//   pnpm --filter papyra-app run shoot
//   pnpm --filter papyra-app run shoot -- --only slash   # just some shots
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
  // Smaller than a typical laptop on purpose: the hero shows these at ~760px,
  // and a tighter viewport keeps the app's own text readable there.
  desktop: { width: 1200, height: 750 },
  mobile: { width: 390, height: 844 },
};

// The desk is staged before capture (see stageDesk): the demo's "Start here"
// note talks about the demo, which is not what a product shot should show.
const DESK = { archive: ['welcome'], pin: ['sourdough', 'reading-list'] };

const SHOTS = [
  { name: 'desk', path: '/', wait: '.note-card', viewports: ['desktop', 'mobile'], stage: DESK },
  {
    name: 'focus',
    path: '/note/reading-list',
    wait: '[contenteditable="true"]',
    viewports: ['desktop', 'mobile'],
    stage: DESK,
    then: (page) => page.getByRole('button', { name: 'Focus mode' }).click(),
  },
  {
    name: 'search',
    path: '/',
    wait: '.note-card',
    viewports: ['desktop', 'mobile'],
    stage: DESK,
    then: async (page) => {
      await page.locator('.search__input').click();
      await page.keyboard.type('pricing', { delay: 40 });
      await page.waitForTimeout(900);
    },
  },
  {
    // The slash menu, opened on a fresh line of a real note.
    name: 'slash',
    path: '/note/reading-list',
    wait: '[contenteditable="true"]',
    viewports: ['desktop', 'mobile'],
    stage: DESK,
    then: async (page) => {
      // The caret at the very end of the last paragraph (a click lands
      // wherever the pointer is, and Ctrl+End is the editor's to interpret).
      await page.locator('.luthor-content-editable').evaluate((el) => {
        // On a phone, after the first paragraph: the short screen keeps the
        // note's opening in view and the menu opens under the line.
        const last = window.innerWidth < 600 ? el.firstElementChild : el.lastElementChild;
        last?.scrollIntoView({ block: 'center' });
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(last ?? el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await page.waitForTimeout(200);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/', { delay: 40 });
      await page.locator('.luthor-slash-menu').waitFor({ timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
];

// `--only a,b`: capture just those shots (the rest stay as committed).
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;

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
    const wanted = SHOTS.filter((s) => s.viewports.includes(label) && (!ONLY || ONLY.has(s.name)));
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
