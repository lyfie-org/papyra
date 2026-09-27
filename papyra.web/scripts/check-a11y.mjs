// End-to-end accessibility check, in a real browser, against the in-browser demo
// (the full app over a fake server — no API needed).
//
// For every flow below, in light and dark, at desktop and phone widths, it runs
// axe-core (WCAG 2.0/2.1/2.2 A + AA) and fails on any violation. Then it checks
// what axe cannot see:
//   - keyboard: the formatting-toolbar toggle is reachable by Tab, shows a focus
//     ring, and works with Enter;
//   - the caret holds 3:1 against the sheet it blinks on (WCAG 1.4.11);
//   - selected text — body and links — holds 4.5:1 on the selection wash.
//
//   pnpm --filter papyra-web run check:a11y
//
// Starts its own Vite dev server in demo mode on a spare port.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const PORT = 4402;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = resolve(import.meta.dirname, '..');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 375, height: 812 },
};

// ── Dev server ────────────────────────────────────────────────────────────────
function startServer() {
  const server = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--mode', 'demo', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  const deadline = Date.now() + 60_000;
  return (async () => {
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`dev server exited (${server.exitCode})`);
      try {
        if ((await fetch(`${ORIGIN}/demo/`)).ok) return server;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    server.kill();
    throw new Error('dev server did not start in 60s');
  })();
}

// ── Flows ─────────────────────────────────────────────────────────────────────
// Each opens a state worth scanning. `page` starts on a fresh context with the
// theme (and, where asked, the always-show toolbar) already in localStorage.
const openNote = async (page, id) => {
  await page.goto(`${ORIGIN}/demo/note/${id}`);
  await page.locator('.luthor-content-editable').waitFor();
  // The demo's "this is a demo" banner sits over the note's footer.
  await page.getByRole('button', { name: 'Hide the demo notice' }).click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400); // entrance animation
};

// Set a note's YAML colour through the demo's own API, then reload the grid.
const recolour = async (page, id, color) => {
  await page.goto(`${ORIGIN}/demo/`);
  await page.locator('.note-card').first().waitFor();
  await page.evaluate(async ({ id, color }) => {
    const note = await (await fetch(`/api/notes/${id}`)).json();
    await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...note, color }),
    });
  }, { id, color });
};

const FLOWS = [
  { name: 'notes grid', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/`);
    await page.locator('.note-card').first().waitFor();
  } },
  { name: 'to do', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/todo`);
    await page.waitForLoadState('networkidle');
  } },
  { name: 'collections', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/collections`);
    await page.waitForLoadState('networkidle');
  } },
  { name: 'archive', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/archive`);
    await page.waitForLoadState('networkidle');
  } },
  { name: 'trash', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/trash`);
    await page.waitForLoadState('networkidle');
  } },
  { name: 'settings / appearance', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=appearance`);
    await page.getByText('Always show the formatting toolbar').waitFor();
  } },
  { name: 'search results', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/`);
    const box = page.getByRole('combobox').or(page.locator('.search input')).first();
    await box.fill('model');
    await page.locator('.search__match').first().waitFor();
  } },
  { name: 'plain note + toolbar', toolbar: true, run: async (page) => {
    await openNote(page, 'quarterly-review');
    await page.locator('.luthor-toolbar').waitFor();
  } },
  { name: 'coloured note + toolbar', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.locator('.luthor-toolbar').waitFor();
  } },
  // `color:` is free YAML, so a note can be any colour — not just the pastels.
  { name: 'dark custom-colour note + toolbar', toolbar: true, run: async (page) => {
    await recolour(page, 'quarterly-review', '#1f2a44');
    await openNote(page, 'quarterly-review');
    await page.locator('.luthor-toolbar').waitFor();
  } },
  { name: 'mid-tone custom-colour note + toolbar', toolbar: true, run: async (page) => {
    await recolour(page, 'quarterly-review', '#8a8f98');
    await openNote(page, 'quarterly-review');
    await page.locator('.luthor-toolbar').waitFor();
  } },
  { name: 'insert menu open', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.getByRole('button', { name: 'YouTube video' }).waitFor();
  } },
  { name: 'text-style group open', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.getByRole('button', { name: 'Text style' }).click();
    await page.locator('.luthor-toolbar-group-menu').waitFor();
  } },
  { name: 'embed dialog open', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.getByRole('button', { name: 'YouTube video' }).click();
    await page.getByLabel('Video link').waitFor();
  } },
  { name: 'table dialog open', toolbar: true, run: async (page) => {
    await openNote(page, 'quarterly-review');
    await page.getByRole('button', { name: /^Blocks/ }).click();
    await page.getByRole('button', { name: 'Insert Table' }).click();
    await page.getByText('Rows:').waitFor();
  } },
  { name: 'colour picker open', run: async (page) => {
    await openNote(page, 'welcome');
    await page.getByRole('button', { name: 'Change color' }).click();
    await page.locator('.palette-picker').waitFor();
  } },
];

// ── Checks axe cannot make ──────────────────────────────────────────────────
// Runs in the page: WCAG contrast from computed colours, including the
// `color(srgb …)` form that color-mix() computes to.
const CONTRAST_HELPERS = () => {
  const probe = document.createElement('canvas').getContext('2d');
  window.__rgb = (css) => {
    // Let canvas normalise any CSS colour (rgb, color(srgb), hex) to rgba.
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  window.__contrast = (a, b) => {
    const [x, y] = [lum(window.__rgb(a)), lum(window.__rgb(b))];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
};

async function checkCaretAndSelection(page, failures, label) {
  await page.evaluate(CONTRAST_HELPERS);
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('.note-editor');
    const body = document.querySelector('.luthor-content-editable');
    const para = body.querySelector('p');
    const link = body.querySelector('.luthor-link, .luthor-wikilink, a');
    const bg = getComputedStyle(sheet).backgroundColor;
    const sel = (el) => getComputedStyle(el, '::selection');
    const out = {
      caret: window.__contrast(getComputedStyle(body).caretColor, bg),
      selectedText: window.__contrast(getComputedStyle(para).color, sel(para).backgroundColor),
    };
    if (link) {
      const s = sel(link);
      const ink = s.color && s.color !== 'rgba(0, 0, 0, 0)' ? s.color : getComputedStyle(link).color;
      out.selectedLink = window.__contrast(ink, s.backgroundColor);
    }
    return out;
  });
  if (result.caret < 3) failures.push(`${label}: caret contrast ${result.caret.toFixed(2)}:1 < 3:1`);
  if (result.selectedText < 4.5) failures.push(`${label}: selected text ${result.selectedText.toFixed(2)}:1 < 4.5:1`);
  if (result.selectedLink !== undefined && result.selectedLink < 4.5) {
    failures.push(`${label}: selected link ${result.selectedLink.toFixed(2)}:1 < 4.5:1`);
  }
  return result;
}

async function checkToolbarKeyboard(page, failures, label) {
  // Tab until the toggle has focus; it sits in the note footer. Tab indents
  // inside the body, so the documented way past it is Escape.
  const bodyBefore = await page.locator('.luthor-content-editable').innerText();
  let escapedBody = false;
  for (let i = 0; i < 80; i++) {
    const inBody = await page.evaluate(() => !!document.activeElement?.closest('.luthor-content-editable'));
    if (inBody) escapedBody = true;
    await page.keyboard.press(inBody ? 'Escape' : 'Tab');
    const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    if (name === 'Show formatting toolbar') break;
  }
  if (!(await page.locator('.note-editor').count())) {
    failures.push(`${label}: Escape in the body closed the note instead of leaving the body`);
    return;
  }
  if (!escapedBody) failures.push(`${label}: Tab never reached the note body`);
  if ((await page.locator('.luthor-content-editable').innerText()) !== bodyBefore) {
    failures.push(`${label}: tabbing through the note changed its text`);
  }
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      name: el?.getAttribute('aria-label'),
      outline: el ? getComputedStyle(el).outlineStyle : 'none',
    };
  });
  if (focused.name !== 'Show formatting toolbar') {
    failures.push(`${label}: formatting toggle not reachable by Tab`);
    return;
  }
  if (focused.outline === 'none') failures.push(`${label}: formatting toggle has no visible focus ring`);
  await page.keyboard.press('Enter');
  const shown = await page.locator('.luthor-toolbar').isVisible();
  const pressed = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'));
  if (!shown) failures.push(`${label}: Enter on the toggle did not show the toolbar`);
  if (pressed !== 'true') failures.push(`${label}: toggle does not report aria-pressed=true once on`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
const server = await startServer();
const browser = await chromium.launch();
const failures = [];
let scans = 0;

try {
  for (const theme of ['light', 'dark']) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      for (const flow of FLOWS) {
        const label = `[${theme} · ${vpName}] ${flow.name}`;
        const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
        await context.addInitScript(({ theme, toolbar }) => {
          localStorage.setItem('papyra-theme', theme);
          if (toolbar) localStorage.setItem('papyra-editor-toolbar', 'always');
        }, { theme, toolbar: Boolean(flow.toolbar) });
        const page = await context.newPage();
        try {
          await flow.run(page);
          const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
          scans++;
          for (const v of violations) {
            const where = v.nodes.slice(0, 3).map((n) => {
              const d = n.any[0]?.data;
              const detail = v.id === 'color-contrast' && d
                ? ` [${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1, needs ${d.expectedContrastRatio}]`
                : '';
              return n.target.join(' ') + detail;
            }).join(' | ');
            failures.push(`${label}: ${v.id} (${v.impact}) — ${v.help} → ${where}`);
          }
          if (flow.name.endsWith('+ toolbar')) {
            // Axe would also have flagged the page's text; this adds the caret
            // and ::selection, which it cannot see.
            await checkCaretAndSelection(page, failures, label);
          }
        } catch (err) {
          failures.push(`${label}: flow failed — ${err.message.split('\n')[0]}`);
        } finally {
          await context.close();
        }
      }

      // Keyboard path, on a fresh note without the always-show preference.
      const label = `[${theme} · ${vpName}] keyboard: formatting toggle`;
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
      await context.addInitScript((t) => localStorage.setItem('papyra-theme', t), theme);
      const page = await context.newPage();
      try {
        await openNote(page, 'quarterly-review');
        await checkToolbarKeyboard(page, failures, label);
      } catch (err) {
        failures.push(`${label}: flow failed — ${err.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}

if (failures.length > 0) {
  console.error(`check-a11y: ${failures.length} problem(s) across ${scans} axe scans:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`check-a11y: ${scans} axe scans (WCAG 2.2 AA) + keyboard + caret/selection contrast — all clean ✓`);
