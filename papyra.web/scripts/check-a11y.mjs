// End-to-end accessibility check, in a real browser, against the in-browser demo
// (the full app over a fake server — no API needed).
//
// For every flow below, in light and dark, at desktop and phone widths, it runs
// axe-core (WCAG 2.0/2.1/2.2 A + AA) and fails on any violation. Then it checks
// what axe cannot see:
//   - keyboard: the formatting-toolbar toggle is reachable by Tab, shows a focus
//     ring, and works with Enter; the settings area tabs, the service tiles (one stop,
//     arrows, Home/End, panel wiring) and the tooltip (hover, focus, Escape);
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

// A journal day, counted back from today in the browser's own calendar (the demo's too).
const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Flip "Use the journal" off in Settings → Journal and wait until the tab has collapsed.
const turnJournalOff = async (page) => {
  await page.goto(`${ORIGIN}/demo/settings?tab=journal`);
  await page.getByText('Writing prompts').waitFor();
  await page.getByRole('switch', { name: 'Use the journal' }).click();
  await page.getByText('Writing prompts').waitFor({ state: 'detached' });
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
  // Pinned and Others fold away: the headings are buttons, one of them pressed.
  { name: 'notes grid with a section folded', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/`);
    await page.locator('.note-card').first().waitFor();
    await page.locator('.section-toggle__btn').first().click();
    await page.waitForTimeout(300);
  } },
  { name: 'vault', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/vault`);
    await page.locator('.vault-section').first().waitFor();
    await page.waitForTimeout(300);
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
  // The journal: today's page with its mood glyphs and streak, a locked day's card, the
  // almanac month grid (a real table), the year view and the pages that set days aside.
  { name: 'journal today', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal`);
    await page.locator('.journal-sheet .luthor-content-editable').waitFor();
    await page.waitForTimeout(500); // the page turn
  } },
  { name: 'journal notes panel open', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal`);
    await page.locator('.journal-sheet .luthor-content-editable').waitFor();
    await page.getByRole('button', { name: /Notes & to-dos/ }).click();
    await page.locator('.journal-aside').waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal mood chip and its five open', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/${dayAgo(1)}`);
    await page.locator('.journal-sheet .luthor-content-editable').waitFor();
    await page.getByRole('button', { name: /How the day felt: .*Change/ }).click();
    await page.getByRole('radiogroup', { name: 'How the day felt' }).waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal focus mode', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/${dayAgo(1)}`);
    await page.locator('.journal-sheet .luthor-content-editable').waitFor();
    // The demo's banner sits over a phone's footer, where the Focus button is: press it directly.
    await page.getByRole('button', { name: 'Focus', exact: true }).evaluate((el) => el.click());
    await page.locator('.journal-sheet--focus').waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal day with a checklist', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/${dayAgo(1)}`);
    await page.locator('.journal-sheet .luthor-content-editable').waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal locked day', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/${dayAgo(5)}`);
    await page.locator('.secure-gate').waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal calendar month', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/calendar`);
    await page.getByRole('table').first().waitFor();
    await page.waitForTimeout(500);
  } },
  { name: 'journal calendar year', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/journal/calendar`);
    await page.getByRole('table').first().waitFor();
    await page.getByRole('button', { name: /^Year/ }).or(page.getByRole('tab', { name: /^Year/ })).first().click();
    await page.waitForTimeout(500);
  } },
  { name: 'journal in archive and trash', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/archive`);
    await page.locator('.journal-bin').waitFor();
  } },
  { name: 'settings / journal', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=journal`);
    await page.getByText('Writing prompts').waitFor();
  } },
  // The journal switched off: the tab shrinks to the one switch and its line, and any
  // journal address shows the quiet "off" page. The demo keeps the choice in localStorage,
  // so a reload lands on the off state.
  { name: 'settings / journal switched off', run: async (page) => {
    await turnJournalOff(page);
    await page.getByText('Turning it off hides the Journal.').waitFor();
  } },
  { name: 'journal off page', run: async (page) => {
    await turnJournalOff(page);
    await page.goto(`${ORIGIN}/demo/journal/${dayAgo(1)}`);
    await page.getByRole('heading', { name: 'The journal is off' }).waitFor();
  } },
  // Notification services: the "Where to send" tiles at rest (email chosen), a service's set-up open in its panel, and the
  // list once a place is connected (an extra switch column beside email). Then the same tiles on the administrator's side.
  { name: 'settings / notifications', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
  } },
  { name: 'settings / notifications / ntfy set-up', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications&service=ntfy`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Set up' }).click();
    await page.getByLabel('Topic').waitFor();
  } },
  { name: 'settings / notifications / ntfy connected', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications&service=ntfy`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Set up' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /Send a test/ }).click();
    await page.getByText('Sent. Look for it in ntfy.').waitFor();
    await page.getByRole('button', { name: 'Yes, it arrived' }).click();
    await page.getByRole('switch', { name: 'Send notifications here' }).waitFor();
    await page.getByRole('switch', { name: 'Mentions — ntfy' }).waitFor();
  } },
  // Discord offers a choice of ways in the demo (a direct message from the bot, or a channel webhook).
  { name: 'settings / notifications / discord choice', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications&service=discord`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Set up' }).click();
    await page.getByRole('radio', { name: /direct message/ }).waitFor();
  } },
  { name: 'settings / notifications / discord code', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications&service=discord`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Set up' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your Discord user ID').fill('123456789012345678');
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByLabel('Code from the bot').waitFor();
  } },
  { name: 'settings / notifications / telegram', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=notifications&service=telegram`);
    await page.getByRole('heading', { name: 'Where to send' }).waitFor();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Set up' }).click();
    await page.getByRole('button', { name: 'Get a link' }).waitFor();
  } },
  // Administration: the area tabs' other side, and the administrator's notification services as tiles.
  { name: 'settings / administration', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=users`);
    await page.getByText('Changes here apply to everyone on this server.').waitFor();
  } },
  { name: 'settings / server notifications', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=channels`);
    await page.getByRole('tab', { name: /^ntfy/ }).waitFor();
    await page.getByRole('tabpanel').getByText('Status').waitFor();
  } },
  { name: 'settings / server notifications / discord', run: async (page) => {
    await page.goto(`${ORIGIN}/demo/settings?tab=channels&service=discord`);
    await page.getByRole('tab', { name: /^Discord/ }).waitFor();
    await page.getByRole('tabpanel').getByText('Direct messages', { exact: true }).waitFor();
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
  { name: 'lists group open', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.getByRole('button', { name: 'Lists' }).click();
    await page.locator('.luthor-toolbar-group-menu').waitFor();
  } },
  { name: 'block style list open', toolbar: true, run: async (page) => {
    await openNote(page, 'welcome');
    await page.locator('.luthor-toolbar .luthor-select-trigger').first().click();
    await page.locator('.luthor-select-dropdown').waitFor();
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


// The area tabs, the service tiles and the tooltip, by keyboard and by hover. axe cannot see these.
async function checkSettingsKeyboard(page, failures, label) {
  // Service tiles: one Tab stop; arrows and Home/End move and choose; the panel follows the chosen tile.
  await page.goto(`${ORIGIN}/demo/settings?tab=notifications`);
  await page.getByRole('heading', { name: 'Where to send' }).waitFor();
  const selected = () => page.locator('.service-tabs').getByRole('tab', { selected: true });
  const stops = await page.locator('.service-tabs [role="tab"][tabindex="0"]').count();
  if (stops !== 1) failures.push(`${label}: the tile row has ${stops} Tab stops, expected 1`);
  await selected().focus();
  const name = async () => (await page.evaluate(() => document.activeElement?.querySelector('.service-tab__name')?.textContent)) ?? '';
  const first = await name();
  await page.keyboard.press('ArrowRight');
  const second = await name();
  if (!second || second === first) failures.push(`${label}: ArrowRight did not move to the next tile`);
  // The choice goes through the address, so give the page a moment to catch up before reading it.
  const followed = await page.waitForFunction(
    (n) => document.querySelector('.service-tabs [role="tab"][aria-selected="true"] .service-tab__name')?.textContent === n,
    second, { timeout: 2000 },
  ).then(() => true, () => false);
  if (!followed) failures.push(`${label}: the chosen tile did not follow the arrow key`);
  await page.keyboard.press('End');
  const last = await name();
  if (last !== 'Telegram') failures.push(`${label}: End went to "${last}", expected Telegram`);
  if (!page.url().includes('service=telegram')) failures.push(`${label}: the chosen service is not in the address`);
  await page.keyboard.press('Home');
  if ((await name()) !== first) failures.push(`${label}: Home did not return to the first tile`);
  const owned = await page.evaluate(() => {
    const tab = document.querySelector('.service-tabs [role="tab"][aria-selected="true"]');
    const panel = document.querySelector('.service-tabs__panel[role="tabpanel"]');
    return !!tab && !!panel && panel.getAttribute('aria-labelledby') === tab.id && tab.getAttribute('aria-controls') === panel.id;
  });
  if (!owned) failures.push(`${label}: the tab and its panel do not point at each other`);

  // Tile arrows, on a row too narrow for its tiles: only the end with more has one, it scrolls without choosing, and
  // it is not a Tab stop. A mouse with no sideways wheel has to be able to reach every tile.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/demo/settings?tab=channels`);
  const more = page.getByRole('button', { name: 'Show more services' });
  const earlier = page.getByRole('button', { name: 'Show earlier services' });
  try {
    await more.waitFor({ timeout: 5000 });
    if (await earlier.count()) failures.push(`${label}: the tile row shows a back arrow at its start`);
    if ((await more.getAttribute('tabindex')) !== '-1') failures.push(`${label}: the tile arrow is a Tab stop`);
    const chosen = () => page.locator('.service-tabs [role="tab"][aria-selected="true"] .service-tab__name').textContent();
    const before = await chosen();
    const scrolled = () => page.locator('.service-tabs__list').evaluate(el => el.scrollLeft);
    const edge = async () => page.locator('.service-tabs__list').evaluate(el => el.scrollWidth - el.clientWidth);
    await more.click();
    await earlier.waitFor({ timeout: 2000 });
    if (!(await scrolled() > 0)) failures.push(`${label}: the tile arrow did not scroll the row`);
    if ((await chosen()) !== before) failures.push(`${label}: the tile arrow changed the chosen service`);
    // Enough clicks reach the far end, where the forward arrow leaves.
    for (let i = 0; i < 6 && (await more.count()); i++) { await more.click(); await page.waitForTimeout(400); }
    if (await more.count()) failures.push(`${label}: the tile arrow never reached the end of the row (${await scrolled()} of ${await edge()})`);
  } catch (e) {
    failures.push(`${label}: the tile arrows did not behave: ${e.message.split('\n')[0]}`);
  }
  // The same for the settings pages' pill row on a narrow screen: scrolls, opens nothing, not a Tab stop.
  await page.goto(`${ORIGIN}/demo/settings?tab=profile`);
  const morePages = page.getByRole('button', { name: 'Show more settings pages' });
  try {
    await morePages.waitFor({ timeout: 5000 });
    if ((await morePages.getAttribute('tabindex')) !== '-1') failures.push(`${label}: the page-row arrow is a Tab stop`);
    await morePages.click();
    await page.getByRole('button', { name: 'Show earlier settings pages' }).waitFor({ timeout: 2000 });
    if (!page.url().includes('tab=profile')) failures.push(`${label}: the page-row arrow opened a page`);
  } catch (e) {
    failures.push(`${label}: the page-row arrows did not behave: ${e.message.split('\n')[0]}`);
  }
  if (viewport) await page.setViewportSize(viewport);

  // Area tabs (administrator): reachable, arrow keys move and choose, Home/End jump, focus goes with the choice.
  await page.goto(`${ORIGIN}/demo/settings?tab=about`);
  await page.getByRole('tablist', { name: 'Settings area' }).waitFor();
  // The choice goes through the address and the page opens a little after it: wait for that before the next key.
  const areaChosen = (want) => page.locator('[role="tablist"][aria-label="Settings area"] [role="tab"][aria-selected="true"]', { hasText: want })
    .waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.getByRole('tab', { name: 'Personal' }).focus();
  await page.keyboard.press('ArrowRight');
  if (!(await areaChosen('Administration')) || !page.url().includes('tab=users')) failures.push(`${label}: ArrowRight on "Personal" did not open Administration`);
  const kept = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (kept !== 'Administration') failures.push(`${label}: focus did not follow the chosen area tab (it is on "${kept}")`);
  await page.keyboard.press('Home');
  if (!(await areaChosen('Personal')) || page.url().includes('tab=users')) failures.push(`${label}: Home did not return to Personal`);
  await page.keyboard.press('End');
  if (!(await areaChosen('Administration')) || !page.url().includes('tab=users')) failures.push(`${label}: End did not go to Administration`);
  const linked = await page.evaluate(() => {
    const tab = document.querySelector('[role="tablist"][aria-label="Settings area"] [role="tab"][aria-selected="true"]');
    const panel = document.getElementById(tab?.getAttribute('aria-controls') ?? '');
    return !!tab && !!panel && panel.getAttribute('aria-labelledby') === tab.id;
  });
  if (!linked) failures.push(`${label}: the area tab and its panel do not point at each other`);

  // Tooltip: by pointer (after its wait) and by keyboard focus (at once); Escape closes it.
  await page.goto(`${ORIGIN}/demo/settings?tab=about`);
  const bell = page.locator('button[data-tooltip="Notifications"]').first();
  await bell.hover();
  try { await page.getByRole('tooltip').waitFor({ timeout: 2000 }); } catch { failures.push(`${label}: hovering a control with a tooltip showed none`); return; }
  await page.keyboard.press('Escape');
  if (await page.getByRole('tooltip').count()) failures.push(`${label}: Escape did not close the tooltip`);
  await page.mouse.move(2, 400);
  await bell.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  try { await page.getByRole('tooltip').waitFor({ timeout: 1000 }); } catch { failures.push(`${label}: keyboard focus on a control with a tooltip showed none`); }
}

// A failed flow, said briefly but with what it was waiting for (Playwright's call log names the locator), so a timeout
// explains itself instead of reading "Timeout 30000ms exceeded".
const why = (err) => {
  const lines = String(err.message).split('\n').map((l) => l.trim());
  const waiting = lines.find((l) => l.startsWith('- waiting for'));
  return waiting ? `${lines[0]} (${waiting.slice(2)})` : lines[0];
};

// ── Run ───────────────────────────────────────────────────────────────────────
const server = await startServer();
const browser = await chromium.launch();
const failures = [];
const retried = [];
let scans = 0;

try {
  for (const theme of ['light', 'dark']) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      for (const flow of FLOWS) {
        const label = `[${theme} · ${vpName}] ${flow.name}`;
        // Getting the page to the state worth scanning is tried twice, each time in a fresh context: about one flow in
        // a hundred and sixty has timed out on a page that simply did not render (never reproducible on its own, and
        // different each run). A flow that throws twice fails. Accessibility violations are never retried, and every
        // retry is printed at the end so a rising rate cannot hide.
        let context = null;
        let page = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
          await context.addInitScript(({ theme, toolbar }) => {
            localStorage.setItem('papyra-theme', theme);
            if (toolbar) localStorage.setItem('papyra-editor-toolbar', 'always');
          }, { theme, toolbar: Boolean(flow.toolbar) });
          page = await context.newPage();
          try {
            await flow.run(page);
            break;
          } catch (err) {
            await context.close();
            context = null;
            if (attempt === 1) retried.push(`${label}: ${why(err)}`);
            else failures.push(`${label}: flow failed twice — ${why(err)}`);
          }
        }
        if (!context) continue;
        try {
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
          failures.push(`${label}: flow failed — ${why(err)}`);
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
        failures.push(`${label}: flow failed — ${why(err)}`);
      } finally {
        await context.close();
      }

      // Settings: area tabs, service tiles and tooltip.
      const settingsLabel = `[${theme} · ${vpName}] keyboard: settings`;
      const settingsContext = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
      await settingsContext.addInitScript((t) => localStorage.setItem('papyra-theme', t), theme);
      const settingsPage = await settingsContext.newPage();
      try {
        await checkSettingsKeyboard(settingsPage, failures, settingsLabel);
      } catch (err) {
        failures.push(`${settingsLabel}: flow failed — ${why(err)}`);
      } finally {
        await settingsContext.close();
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}

if (retried.length > 0) {
  console.warn(`check-a11y: ${retried.length} flow(s) needed a second try (the page was slow to get ready; nothing about accessibility):`);
  for (const r of retried) console.warn(`  - ${r}`);
}
if (failures.length > 0) {
  console.error(`check-a11y: ${failures.length} problem(s) across ${scans} axe scans:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`check-a11y: ${scans} axe scans (WCAG 2.2 AA) + keyboard + caret/selection contrast — all clean ✓`);
