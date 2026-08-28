// The website renders in the app's exact design system. Rather than reach across
// pnpm packages at build time (fragile under Vite + Astro resolution), the token
// sheet is copied — and this guard fails the build the moment the copy drifts
// from papyra.web/src/styles/tokens.css, which is the original.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = new URL('../../papyra.web/src/styles/tokens.css', import.meta.url);
const COPY = new URL('../src/styles/tokens.css', import.meta.url);

const read = (url) => {
  try {
    // Normalise line endings: this repo is developed on Windows and checked out
    // on Linux CI, so a CRLF/LF difference must not read as a token change.
    return readFileSync(url, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  } catch (err) {
    console.error(`check-tokens: could not read ${fileURLToPath(url)}\n  ${err.message}`);
    process.exit(1);
  }
};

const source = read(SOURCE);
const copy = read(COPY);

if (source === copy) {
  console.log('check-tokens: papyra.app tokens match papyra.web ✓');
  process.exit(0);
}

const a = source.split('\n');
const b = copy.split('\n');
const diffs = [];
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) diffs.push(`  line ${i + 1}\n    app: ${a[i] ?? '<missing>'}\n   site: ${b[i] ?? '<missing>'}`);
  if (diffs.length === 10) break;
}

console.error(
  'check-tokens: design tokens have drifted.\n' +
    `  source: papyra.web/src/styles/tokens.css\n` +
    `    copy: papyra.app/src/styles/tokens.css\n\n` +
    diffs.join('\n') +
    '\n\nIf the app changed on purpose, refresh the copy:\n' +
    '  cp papyra.web/src/styles/tokens.css papyra.app/src/styles/tokens.css\n',
);
process.exit(1);
