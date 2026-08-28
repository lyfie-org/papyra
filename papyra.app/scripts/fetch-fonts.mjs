// Self-host the three Papyra typefaces.
//
// papyra.web/index.html pulls Marcellus/Sora/Roboto Mono from fonts.googleapis.com.
// That is fine for an app you run on your own server, but it is wrong for a public
// marketing site: it is two extra cross-origin round trips everywhere, and it is
// simply blocked in mainland China. Serving the woff2 files ourselves means the
// site makes ZERO third-party requests and renders identically on every network.
//
// Run: pnpm --filter papyra-app run fonts
// Commits the woff2 files and src/styles/fonts.css. Only re-run to change weights.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FAMILIES = [
  { css: 'Marcellus', weights: '400' },
  { css: 'Sora', weights: '400;500;600' },
  { css: 'Roboto+Mono', weights: '400;500' },
];

// Google serves a dozen unicode-range slices per family. The site is English;
// latin + latin-ext covers it, and every extra slice is a file nobody downloads.
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

// Without a modern UA the CSS2 endpoint answers with truetype instead of woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const fontsDir = new URL('../public/fonts/', import.meta.url);
const cssOut = new URL('../src/styles/fonts.css', import.meta.url);

await mkdir(fontsDir, { recursive: true });

const query = FAMILIES.map((f) => `family=${f.css}:wght@${f.weights}`).join('&');
const cssUrl = `https://fonts.googleapis.com/css2?${query}&display=swap`;

const res = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error(`Google Fonts CSS ${res.status} for ${cssUrl}`);
const css = await res.text();

// Each @font-face is preceded by a `/* subset */` comment naming the slice.
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
if (blocks.length === 0) throw new Error('Could not parse any @font-face blocks');

const out = [
  '/* Self-hosted so the site makes no third-party requests — see scripts/fetch-fonts.mjs.',
  '   Generated file: edit the script, not this. */',
  '',
];
let downloaded = 0;
let skipped = 0;

for (const [, subset, block] of blocks) {
  if (!KEEP_SUBSETS.has(subset)) {
    skipped += 1;
    continue;
  }
  const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
  const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
  const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
  const src = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1];
  if (!family || !weight || !src) throw new Error(`Unexpected @font-face shape:\n${block}`);

  const slug = family.toLowerCase().replace(/\s+/g, '-');
  const file = `${slug}-${weight}${style === 'italic' ? '-italic' : ''}-${subset}.woff2`;

  const bin = await fetch(src, { headers: { 'User-Agent': UA } });
  if (!bin.ok) throw new Error(`woff2 ${bin.status} for ${src}`);
  const bytes = Buffer.from(await bin.arrayBuffer());
  await writeFile(new URL(file, fontsDir), bytes);
  downloaded += 1;
  console.log(`  ${file}  ${(bytes.length / 1024).toFixed(1)} KB`);

  out.push(
    '@font-face {',
    `  font-family: '${family}';`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    '  font-display: swap;',
    `  src: url('/fonts/${file}') format('woff2');`,
    `  ${/unicode-range:[^;]+;/.exec(block)?.[0] ?? ''}`.trimEnd(),
    '}',
    '',
  );
}

const css_ = out.join('\n');
await writeFile(cssOut, css_, 'utf8');

// The same sheet, served as a plain file at /fonts/fonts.css. The demo build
// (papyra.web --mode demo) links this instead of Google Fonts: it is a separate
// Vite build with its own index.html, so it cannot import the Astro stylesheet,
// but it is served from this same origin and can just fetch it.
await writeFile(new URL('fonts.css', fontsDir), css_, 'utf8');

console.log(
  `\nfetch-fonts: ${downloaded} files → public/fonts/, ${skipped} non-latin subsets skipped.`,
);
console.log(`Wrote ${fileURLToPath(cssOut)}`);
console.log(`Wrote ${fileURLToPath(new URL('fonts.css', fontsDir))}`);
