// Record the short looping videos on the home page.
//
// Like shoot.mjs, every clip is the REAL application — the demo build of
// papyra.web — driven by Playwright. The only thing added is a visible cursor
// (headless Chrome draws none) and, for the drag-and-drop clip, the little file
// chip a desktop OS would draw under the pointer. The drop itself is a genuine
// DataTransfer handed to the app's own drop handler.
//
// Frames come from Chrome's screencast (lossless enough, real timing) and are
// encoded by ffmpeg into H.264 MP4 — a tenth the size of a GIF and sharper.
//
//   pnpm --filter papyra-web run build:demo   # the demo, into public/demo
//   pnpm --filter papyra-app run build        # dist/ must exist
//   pnpm --filter papyra-app run clips        # or: CLIPS=drop,search … run clips
//
// Needs ffmpeg on PATH. Output: public/media/clips/{name}-{theme}.mp4 + .webp poster.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { CAPTURE_CSS, demoUrl, serve, stageDesk } from './harness.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'public/media/clips');
const TMP = join(ROOT, 'node_modules/.cache/clips');
const PORT = 4397;

// Big enough that the app lays out as on a laptop, small enough that its text
// stays legible when the clip is shown at ~700px wide. Captured at 2x and
// scaled to 1.5x by the screencast, so text is supersampled.
const VIEW = { width: 1120, height: 700 };
const SCALE = 1.5;

const ONLY = process.env.CLIPS ? new Set(process.env.CLIPS.split(',')) : null;

// ------------------------------------------------------------------ cursor

/** A drawn pointer, since headless Chrome renders none. Follows real mouse events. */
function cursorScript() {
  const mount = () => {
    if (document.getElementById('__cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #__cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        transform: translate(-100px, -100px); will-change: transform; }
      #__cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); transition: transform .12s ease; transform-origin: 3px 3px; }
      #__cursor.down svg { transform: scale(.82); }
      #__cursor .ring { position: absolute; left: -14px; top: -14px; width: 32px; height: 32px; border-radius: 50%;
        border: 2px solid rgba(122,170,138,.9); opacity: 0; transform: scale(.4); }
      #__cursor.down .ring { animation: __ring .45s ease-out; }
      @keyframes __ring { from { opacity: 1; transform: scale(.4); } to { opacity: 0; transform: scale(1.3); } }
      #__cursor .file { position: absolute; left: 18px; top: 16px; display: none; align-items: center; gap: 8px;
        padding: 8px 12px 8px 10px; border-radius: 10px; background: #fff; color: #3d2c1e;
        font: 500 13px/1 Sora, system-ui, sans-serif; white-space: nowrap;
        box-shadow: 0 8px 24px rgba(40,28,18,.22), 0 0 0 1px rgba(40,28,18,.08); }
      #__cursor.dragging .file { display: inline-flex; }
      #__cursor .file b { display: inline-grid; place-items: center; width: 22px; height: 26px; border-radius: 4px;
        background: #7aaa8a; color: #0f2118; font: 600 8px/1 'Roboto Mono', monospace; }
    `;
    const el = document.createElement('div');
    el.id = '__cursor';
    el.innerHTML =
      '<span class="ring"></span>' +
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.4 3 6.7 3-1.3-3-6.6h6.4z" fill="#1c1917" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<span class="file"><b>MD</b><span class="name"></span></span>';
    document.head.append(style);
    document.body.append(el);
    const at = (e) => { el.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 3}px)`; };
    document.addEventListener('mousemove', at, true);
    document.addEventListener('mousedown', (e) => { at(e); el.classList.remove('down'); void el.offsetWidth; el.classList.add('down'); }, true);
    document.addEventListener('mouseup', () => setTimeout(() => el.classList.remove('down'), 120), true);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
}

/** Move like a hand: eased, not teleporting. */
async function glide(page, from, to, ms = 700) {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
  return to;
}

async function centre(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Glide to an element and click it. Returns the new pointer position. */
async function clickOn(page, pos, locator, ms = 650) {
  const to = await centre(locator);
  await glide(page, pos, to, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
  return to;
}

const type = (page, text, delay = 55) => page.keyboard.type(text, { delay });

// ------------------------------------------------------------------- clips

const LISBON = `# Lisbon, in May

Flights booked for the **14th**. Staying in Alfama, near the tram stop.

## To pack
- [x] Camera, both lenses
- [ ] Walking shoes
- [ ] Sunscreen

> Pastéis de nata at Manteigaria — every single morning.
`;

/**
 * Each clip: `stage` sets the vault up before recording starts (untimed), `run`
 * is what the viewer sees. `themes` lists which themes to record.
 */
const CLIPS = {
  // Any .md file, dragged in from the desktop, becomes a note.
  drop: {
    themes: ['light', 'dark'],
    path: '/',
    stage: { archive: ['welcome'], unpin: ['quarterly-review'] },
    async run(page) {
      let pos = { x: VIEW.width * 0.62, y: VIEW.height * 0.42 };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(700);

      // The file arrives from outside the window, as it would from Finder.
      await page.evaluate(() => {
        const c = document.getElementById('__cursor');
        c.querySelector('.name').textContent = 'lisbon-trip.md';
        c.classList.add('dragging');
      });
      const start = { x: VIEW.width + 40, y: VIEW.height * 0.8 };
      await page.mouse.move(start.x, start.y);
      const target = { x: VIEW.width * 0.55, y: VIEW.height * 0.5 };
      const steps = 40;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const e = 1 - (1 - t) ** 3;
        pos = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e };
        await page.mouse.move(pos.x, pos.y);
        if (pos.x < VIEW.width - 4) {
          await page.evaluate(({ x, y }) => {
            const t = document.elementFromPoint(x, y) ?? document.body;
            t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
          }, pos);
        }
        await page.waitForTimeout(22);
      }
      await page.waitForTimeout(650);

      await page.evaluate(({ x, y, body }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([body], 'lisbon-trip.md', { type: 'text/markdown' }));
        const t = document.elementFromPoint(x, y) ?? document.body;
        t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
        document.getElementById('__cursor').classList.remove('dragging');
      }, { ...pos, body: LISBON });

      const card = page.locator('.note-card', { hasText: 'Lisbon, in May' }).first();
      await card.waitFor({ timeout: 5000 });
      await page.waitForTimeout(1300);
      pos = await clickOn(page, pos, card, 700);
      await page.locator('.note-modal [contenteditable="true"]').waitFor();
      await page.waitForTimeout(500);
      await glide(page, pos, { x: VIEW.width * 0.86, y: VIEW.height * 0.55 }, 600);
      await page.waitForTimeout(2200);
    },
  },

  // Write, link another note with [[, and watch it save itself.
  write: {
    themes: ['light', 'dark'],
    path: '/',
    stage: { archive: ['welcome'] },
    async run(page) {
      let pos = { x: VIEW.width * 0.5, y: VIEW.height * 0.5 };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(500);
      pos = await clickOn(page, pos, page.getByRole('button', { name: 'New note' }));
      const title = page.locator('.note-editor__title');
      await title.waitFor();
      await page.waitForTimeout(400);
      await title.focus();
      await type(page, 'Weekend', 70);
      await page.waitForTimeout(300);

      const body = page.locator('.note-modal [contenteditable="true"]').first();
      pos = await clickOn(page, pos, body, 500);
      await page.waitForTimeout(250);
      // Markdown shortcuts, typed as anyone would type them.
      await type(page, '## Saturday', 70);
      await page.keyboard.press('Enter');
      await type(page, 'Bake a loaf from ');
      await type(page, '[[', 120);
      await page.waitForTimeout(250);
      await type(page, 'sour', 110);
      await page.waitForTimeout(900);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await type(page, '- ', 90);
      await type(page, 'Rye flour');
      await page.keyboard.press('Enter');
      await type(page, 'A long walk, no phone');
      await glide(page, pos, { x: VIEW.width * 0.72, y: VIEW.height * 0.86 }, 700);
      // Autosave lands ~1.5s after the last keystroke; hold on the label.
      await page.getByText('Saved to local disk').waitFor({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(2200);
    },
  },

  // One shortcut, every note, matches highlighted.
  search: {
    themes: ['light', 'dark'],
    path: '/',
    stage: { archive: ['welcome'], pin: ['sourdough', 'reading-list'] },
    async run(page) {
      let pos = { x: VIEW.width * 0.7, y: VIEW.height * 0.55 };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(600);
      pos = await clickOn(page, pos, page.locator('.search__input'), 700);
      await page.waitForTimeout(300);
      await type(page, 'pricing', 110);
      await page.waitForTimeout(1300);
      await glide(page, pos, { x: pos.x + 40, y: pos.y + 100 }, 500);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.locator('.note-modal').waitFor({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(2400);
    },
  },

  // Locked notes stay sealed until the vault PIN opens them.
  vault: {
    themes: ['light', 'dark'],
    path: '/vault',
    stage: {},
    async run(page) {
      let pos = { x: VIEW.width * 0.6, y: VIEW.height * 0.6 };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(800);
      pos = await clickOn(page, pos, page.locator('.note-card', { hasText: 'Travel documents' }).first());
      const input = page.locator('.vault-unlock__input');
      await input.waitFor();
      await page.waitForTimeout(700);
      pos = await clickOn(page, pos, input, 500);
      await type(page, '246810', 150);
      await page.waitForTimeout(300);
      pos = await clickOn(page, pos, page.locator('.vault-unlock__btn').first(), 450);
      await page.waitForTimeout(800);
      await glide(page, pos, { x: VIEW.width * 0.82, y: VIEW.height * 0.3 }, 600);
      await page.waitForTimeout(2200);
    },
  },

  // Light to dark and back — the same calm either way.
  theme: {
    themes: ['light'],
    path: '/',
    stage: { archive: ['welcome'], pin: ['sourdough', 'reading-list'] },
    async run(page) {
      let pos = { x: VIEW.width * 0.55, y: VIEW.height * 0.55 };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(900);
      const toggle = page.locator('button[aria-label*="theme" i], button[aria-label*="dark" i], button[aria-label*="light" i]').first();
      pos = await clickOn(page, pos, toggle, 800);
      await page.waitForTimeout(1900);
      pos = await clickOn(page, pos, toggle, 300);
      await page.waitForTimeout(1600);
    },
  },
};

// ------------------------------------------------------------------ record

async function record(page, run) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, ts: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: VIEW.width * SCALE,
    maxHeight: VIEW.height * SCALE,
  });
  const t0 = Date.now() / 1000;
  await run(page);
  const t1 = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  return { frames, t0, t1 };
}

function encode(name, { frames, t1 }) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lines = [];
  frames.forEach((f, i) => {
    const file = `f${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.ts ?? t1;
    lines.push(`file '${file}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
  });
  // The concat demuxer ignores the last duration unless the file is repeated.
  lines.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'));

  const W = VIEW.width * SCALE;
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', `fps=30,scale=${W}:-2:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '25', '-tune', 'animation',
    '-movflags', '+faststart', '-an', mp4,
  ]);
  // Poster = the first frame, so nothing jumps when playback starts.
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', join(dir, 'f00000.jpg'),
    '-vf', `scale=${W}:-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', '82', join(OUT, `${name}.webp`),
  ]);
  return mp4;
}

// -------------------------------------------------------------------- main

if (!existsSync(join(ROOT, 'dist/demo/index.html'))) {
  console.error('clips: dist/demo not found. Build the demo and the site first (see the header).');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();

try {
  for (const [name, clip] of Object.entries(CLIPS)) {
    if (ONLY && !ONLY.has(name)) continue;
    for (const theme of clip.themes) {
      const context = await browser.newContext({
        viewport: VIEW,
        deviceScaleFactor: 2,
        colorScheme: theme,
        locale: 'en-GB',
        timezoneId: 'UTC',
      });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('papyra-theme', t);
        } catch {
          /* blocked storage — the clip just follows the OS */
        }
      }, theme);
      await context.addInitScript(cursorScript);
      const page = await context.newPage();

      await page.goto(demoUrl(PORT, '/'), { waitUntil: 'networkidle' });
      await stageDesk(page, clip.stage);
      await page.goto(demoUrl(PORT, clip.path), { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: CAPTURE_CSS });
      await page.waitForTimeout(1200);

      const take = await record(page, clip.run);
      const label = clip.themes.length > 1 ? `${name}-${theme}` : name;
      const file = encode(label, take);
      const size = (await import('node:fs')).statSync(file).size;
      console.log(`  ${label}.mp4  ${take.frames.length} frames  ${(take.t1 - take.t0).toFixed(1)}s  ${(size / 1024).toFixed(0)} KB`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
