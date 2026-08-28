// Render the social preview image.
//
// Rendered in a real browser rather than composed with an image library, for one
// reason: fonts. Papyra's identity is Marcellus, and rasterising text with the
// right face, kerning and optical sizing is exactly what a browser is for.
// Playwright is already here for the screenshots, so this costs no new tooling.
//
//   pnpm --filter papyra-app run og
//
// The fonts are inlined as base64 so the page needs no server and no network.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
// public/, not src/assets/: social scrapers want one stable URL that does not
// change with a content hash, and this file is already small enough that Astro's
// image pipeline would add nothing.
const OUT_DIR = resolve(ROOT, 'public');

const font = async (file) =>
  `data:font/woff2;base64,${(await readFile(resolve(ROOT, 'public/fonts', file))).toString('base64')}`;

const logo = `data:image/png;base64,${(
  await readFile(resolve(ROOT, 'src/assets/papyra_logo.png'))
).toString('base64')}`;

const [marcellus, sora] = await Promise.all([
  font('marcellus-400-latin.woff2'),
  font('sora-400-latin.woff2'),
]);

// The light palette, copied from the token sheet. A social card is shown on
// someone else's dark or light chrome, so it commits to one look rather than
// trying to follow a theme it cannot see.
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'Marcellus'; src: url('${marcellus}') format('woff2'); font-weight: 400; }
  @font-face { font-family: 'Sora'; src: url('${sora}') format('woff2'); font-weight: 400; }

  * { box-sizing: border-box; margin: 0; }

  body {
    width: 1200px;
    height: 630px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 28px;
    padding: 88px;
    background:
      radial-gradient(52rem 34rem at 84% -10%, rgba(122, 170, 138, 0.22), transparent 68%),
      radial-gradient(40rem 30rem at 4% 6%, rgba(61, 44, 30, 0.08), transparent 62%),
      #f2ebe0;
    color: #7a5c4e;
    font-family: 'Sora', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .brand { display: flex; align-items: center; gap: 20px; }
  .brand img { width: 76px; height: 76px; border-radius: 16px; }
  .brand span {
    font-family: 'Marcellus', Georgia, serif;
    font-size: 54px;
    color: #3d2c1e;
    letter-spacing: -0.01em;
  }

  h1 {
    font-family: 'Marcellus', Georgia, serif;
    font-size: 76px;
    line-height: 1.04;
    letter-spacing: -0.03em;
    color: #3d2c1e;
    max-width: 20ch;
    font-weight: 400;
  }

  p { font-size: 27px; line-height: 1.45; max-width: 46ch; }

  .rule { width: 96px; height: 3px; background: #7aaa8a; border-radius: 999px; }
</style>
<div class="brand"><img src="${logo}" alt=""><span>Papyra</span></div>
<div class="rule"></div>
<h1>A calm, self-hosted home for your notes.</h1>
<p>Every note is an ordinary Markdown file in a folder you own. Open source, one Docker command.</p>
`;

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

const file = resolve(OUT_DIR, 'og.png');
await page.screenshot({ path: file });
await browser.close();

const { size } = await import('node:fs').then((fs) => fs.statSync(file));
console.log(`og: 1200x630 -> public/og.png (${(size / 1024).toFixed(0)} KB)`);
