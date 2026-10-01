// End-to-end check of the editor's insert paths against a real API: every way a
// picture, file or embed gets into a note, and that each one survives the round
// trip — visual editor → markdown on disk → reload → the same visual again,
// without the reopen rewriting the body.
//
// Starts its own throwaway API (a fresh data dir under the OS temp folder, never
// your vault) and a Vite dev server proxying to it, creates a first user through
// the normal setup endpoint, then drives Chromium.
//
//   pnpm --filter papyra-web run check:editor
//
// Needs the .NET SDK (the API runs with `dotnet run`).

import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

// RFC 6238 (SHA-1, 6 digits, 30 s) — what an authenticator app would show.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function totp(secret) {
  let bits = '';
  for (const ch of secret) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const WEB = resolve(import.meta.dirname, '..');
const API_PROJECT = resolve(WEB, '../papyra.api/src/Papyra.Api');
// Not 5231: that is where Development settings point the API at a hand-started
// collab engine, and an API listening there asks itself about live rooms (every
// save then fails). The harness spawns the built engine instead (see below).
const API_PORT = 5243;
const COLLAB_SCRIPT = resolve(WEB, '../papyra.collab/dist/server.mjs');
const WEB_PORT = 4403;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const NOTE = 'e2e-inserts';
const LINK_IMAGE = 'android-chrome-192x192.png';

// 1×1 PNG, 1×1 GIF, and a minimal PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PDF = Buffer.from('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// ── Servers ─────────────────────────────────────────────────────────────────
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  child.logTail = () => log.split('\n').slice(-15).join('\n');
  return child;
}

async function waitFor(url, child, what) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited:\n${child.logTail()}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`${what} did not start:\n${child.logTail()}`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'papyra-e2e-'));
const api = start('dotnet', [
  'run', '--project', API_PROJECT, '--no-launch-profile', '--',
  `--Papyra:DataDir=${dataDir}`, `--urls=http://localhost:${API_PORT}`,
  // Spawn the bundled engine (`pnpm --filter papyra-collab run build`), with a
  // fresh secret, rather than connect to a dev one on 5231.
  '--Collab:Url=', `--Collab:Script=${COLLAB_SCRIPT}`, '--Collab:Secret=',
], { env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' } });
const web = start(process.execPath, [
  resolve(WEB, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort',
], { cwd: WEB, env: { ...process.env, PAPYRA_API: `http://localhost:${API_PORT}` } });

const MEDIA_NOTE = 'e2e-media';

async function noteBody(page, id) {
  const list = await (await page.request.get(`${ORIGIN}/api/notes`)).json();
  return (list.find?.((n) => n.id === id) ?? {}).body ?? '';
}

async function waitForBody(page, id, test, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const b = await noteBody(page, id);
    if (test(b)) return b;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(300);
  }
}

// In the page: PNG files drawn on a canvas (real pixels, real sizes).
async function makePngs(page, specs) {
  return page.evaluate(async (specs) => {
    const out = [];
    for (const { name, w, h, color } of specs) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = color; g.fillRect(0, 0, w, h);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({ name, type: 'image/png', base64: btoa(bin) });
    }
    return out;
  }, specs);
}

// Dispatch a drag of these files ending at (x, y) on whatever is there, or
// (x, y omitted) on the lower half of the note's last block.
async function dropAt(page, files, x, y) {
  await page.evaluate(({ files, x, y }) => {
    if (x === undefined) {
      const last = document.querySelector('.luthor-content-editable').lastElementChild;
      last.scrollIntoView({ block: 'center' });
      const r = last.getBoundingClientRect();
      x = r.left + 20;
      y = r.bottom - 2;
    }
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : new Uint8Array(f.size);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const target = document.elementFromPoint(x, y);
    for (const t of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
  }, { files, x, y });
}

async function openNote(page, id) {
  await page.goto(`${ORIGIN}/note/${id}`);
  await page.locator('.luthor-content-editable').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
}

async function checkMedia(page) {
  console.log('· media: setup');
  const [wide] = await makePngs(page, [{ name: 'wide.png', w: 1200, h: 800, color: '#7aaa8a' }]);
  const up = await page.request.post(`${ORIGIN}/api/media/upload?noteId=${MEDIA_NOTE}`, {
    multipart: { file: { name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(wide.base64, 'base64') } },
  });
  const picture = (await up.json()).filename;
  const start = `Intro\n\n![[${picture}]]\n\nOutro`;
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: start },
  });
  await openNote(page, MEDIA_NOTE);
  check(await noteBody(page, MEDIA_NOTE) === start, 'media: opening the note rewrote it');

  // Clicking a selected picture again and again: its toolbar stays put (the
  // old bug: the bar blinked away and back on every click).
  console.log('· media: repeated clicks');
  const img = page.locator('.luthor-media img').first();
  await img.scrollIntoViewIfNeeded();
  await img.click();
  await page.locator('.luthor-media__toolbar').waitFor({ timeout: 5000 });
  await page.evaluate(() => {
    window.__toolbarRemovals = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) {
        if (n.nodeType === 1 && (n.matches('.luthor-media__toolbar') || n.querySelector('.luthor-media__toolbar'))) window.__toolbarRemovals++;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  for (let i = 0; i < 10; i++) { await img.click(); await page.waitForTimeout(60); }
  const clicks = await page.evaluate(() => ({
    removals: window.__toolbarRemovals,
    toolbar: !!document.querySelector('.luthor-media__toolbar'),
    textBar: [...document.querySelectorAll('.luthor-floating-toolbar')].some((el) => el.getBoundingClientRect().width > 0),
  }));
  check(clicks.toolbar && clicks.removals === 0, `media: toolbar left or blinked during 10 clicks (${JSON.stringify(clicks)})`);
  check(!clicks.textBar, 'media: the text formatting bar showed over a selected picture');

  // Keyboard resize, then a handle drag: each saves the width in the markdown.
  console.log('· media: resize');
  const frameWidth = () => page.locator('.luthor-media__frame').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const w0 = await frameWidth();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const keyedWidth = (b) => Number(/\|(\d+)\]\]/.exec(b)?.[1]);
  const keyed = await waitForBody(page, MEDIA_NOTE, (b) => Math.abs(keyedWidth(b) - (w0 - 20)) <= 2);
  check(!!keyed, `media: Shift+← twice did not save about |${w0 - 20} (${JSON.stringify(await noteBody(page, MEDIA_NOTE))})`);

  const handle = page.locator('.luthor-media__handle--right').first();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(hb.x + hb.width / 2 - i * 20, hb.y + hb.height / 2);
  await page.mouse.up();
  const dragged = await waitForBody(page, MEDIA_NOTE, (b) => keyedWidth(b) < keyedWidth(keyed ?? '') - 40);
  const savedWidth = Number(/\|(\d+)\]\]/.exec(dragged ?? '')?.[1]);
  check(!!dragged && savedWidth < w0 - 20, `media: dragging the handle did not save a smaller width (${JSON.stringify(dragged)})`);
  const selectionStyle = await page.evaluate(() => document.body.style.userSelect);
  check(selectionStyle !== 'none', 'media: text selection stayed disabled after a resize');

  await openNote(page, MEDIA_NOTE);
  const afterReload = await frameWidth();
  check(Math.abs(afterReload - savedWidth) <= 2, `media: width after reload ${afterReload} ≠ saved ${savedWidth}`);
  check(await noteBody(page, MEDIA_NOTE) === dragged, 'media: reopening a resized picture rewrote the note');

  // Four files dropped on the lower half of "Intro": they land right after it,
  // in the order they were dropped, each through a placeholder.
  console.log('· media: ordered drop');
  const four = await makePngs(page, [1, 2, 3, 4].map((n) => ({ name: `order-${n}.png`, w: 40 * n, h: 30, color: '#a0785a' })));
  const intro = await page.locator('.luthor-content-editable > *').first().boundingBox();
  await dropAt(page, four, intro.x + 20, intro.y + intro.height * 0.75);
  const ordered = await waitForBody(page, MEDIA_NOTE, (b) => (b.match(/order-\d/g) ?? []).length === 4);
  const order = (ordered ?? '').match(/order-\d/g)?.join(',');
  check(order === 'order-1,order-2,order-3,order-4', `media: 4-file drop landed as ${order}`);
  check((ordered ?? '').indexOf('order-1') > (ordered ?? '').indexOf('Intro') && (ordered ?? '').indexOf('order-4') < (ordered ?? '').indexOf(picture),
    `media: the drop did not land between Intro and the picture (${JSON.stringify(ordered)})`);
  check(!(await page.locator('.media-drop').count()), 'media: "Drop to attach" stuck after a drop');

  // A drop on the title goes before the first block.
  console.log('· media: drop on the title');
  const [titled] = await makePngs(page, [{ name: 'on-title.png', w: 60, h: 40, color: '#5a78a0' }]);
  const title = await page.locator('.note-editor input').first().boundingBox();
  await dropAt(page, [titled], title.x + 30, title.y + title.height / 2);
  const onTitle = await waitForBody(page, MEDIA_NOTE, (b) => b.includes('on-title-'));
  check(!!onTitle && onTitle.trimStart().startsWith('![[on-title-'), `media: a drop on the title did not land first (${JSON.stringify(onTitle?.slice(0, 80))})`);

  // Word/Excel paste (HTML + a picture of it on the clipboard) → the text, no upload.
  console.log('· media: Word paste');
  const uploadsBefore = (await noteBody(page, MEDIA_NOTE)).match(/!\[\[/g)?.length ?? 0;
  await page.evaluate(() => {
    const root = document.querySelector('.luthor-content-editable');
    const last = root.lastElementChild;
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    root.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal><b>Bold from Word</b> and more</p></body></html>');
    dt.setData('text/plain', 'Bold from Word and more');
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const pasted = await waitForBody(page, MEDIA_NOTE, (b) => b.includes('Bold from Word'));
  check(!!pasted, 'media: a Word paste did not insert its text');
  check(((pasted ?? '').match(/!\[\[/g)?.length ?? 0) === uploadsBefore, 'media: a Word paste also uploaded a picture of itself');

  // Cancel an upload in flight: nothing lands, nothing is left behind.
  console.log('· media: cancel');
  await page.route('**/api/media/upload**', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue().catch(() => {}); });
  const [slow] = await makePngs(page, [{ name: 'cancel-me.png', w: 50, h: 50, color: '#333333' }]);
  await dropAt(page, [slow]);
  const cancel = page.getByRole('button', { name: /Cancel uploading cancel-me/ });
  await cancel.waitFor({ timeout: 5000 });
  await cancel.click();
  await page.waitForTimeout(5000);
  await page.unroute('**/api/media/upload**');
  check(!(await noteBody(page, MEDIA_NOTE)).includes('cancel-me'), 'media: a cancelled upload still landed');
  check(!(await page.locator('.luthor-upload').count()), 'media: a cancelled upload left its placeholder');

  // Too big for its kind: refused before a byte is sent, said once.
  console.log('· media: oversized');
  let uploads = 0;
  const countUploads = (req) => { if (req.url().includes('/api/media/upload')) uploads++; };
  page.on('request', countUploads);
  await dropAt(page, [{ name: 'huge.png', type: 'image/png', size: 31 * 1024 * 1024 }]);
  await page.waitForTimeout(1500);
  page.off('request', countUploads);
  check(uploads === 0, `media: an oversized file was sent anyway (${uploads} upload requests)`);
  check(await page.getByText(/over the 30 MB limit for images/).count() === 1, 'media: an oversized file was not refused with one message');

  // A video brings its poster frame and size (captured in the browser).
  console.log('· media: video poster');
  const video = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d');
    const stream = c.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    let frame = 0;
    const tick = setInterval(() => { g.fillStyle = frame++ % 2 ? '#7aaa8a' : '#a0785a'; g.fillRect(0, 0, 320, 180); }, 60);
    rec.start();
    await new Promise((r) => setTimeout(r, 1500));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    clearInterval(tick);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: 'clip.webm', type: 'video/webm', base64: btoa(bin) };
  });
  await dropAt(page, [video]);
  const withVideo = await waitForBody(page, MEDIA_NOTE, (b) => /!\[\[clip-[^\]]+\.webm\]\]/.test(b), 20_000);
  const clip = /!\[\[(clip-[^\]|]+\.webm)/.exec(withVideo ?? '')?.[1];
  const clipMeta = clip ? await (await page.request.get(`${ORIGIN}/api/media/${clip}/meta`)).json() : null;
  check(!!clipMeta?.poster && clipMeta?.width === 320 && clipMeta?.height === 180,
    `media: the video did not keep its browser-made poster and size (${JSON.stringify(clipMeta)})`);

  // A missing file says so, with a way to try again.
  console.log('· media: broken');
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: 'Gone:\n\n![[missing-e2e.png]]' },
  });
  await openNote(page, MEDIA_NOTE);
  check(await page.getByRole('button', { name: 'Retry' }).count() >= 1, 'media: a missing picture shows no Retry');

  // Switching the theme keeps every picture (no editor rebuild).
  console.log('· media: theme switch');
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: start },
  });
  await openNote(page, MEDIA_NOTE);
  const kept = await page.evaluate(async () => {
    const before = document.querySelector('.luthor-media img');
    document.querySelector('button[aria-label^="Switch to"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    return { same: document.querySelector('.luthor-media img') === before && before?.isConnected };
  });
  check(kept.same, 'media: switching the theme rebuilt the editor (the picture reloaded)');

  // A selected picture with its toolbar and handles, both themes: WCAG 2.2 AA.
  console.log('· media: accessibility');
  for (const theme of ['first', 'second']) {
    await page.locator('.luthor-media img').first().click();
    await page.locator('.luthor-media__toolbar').waitFor({ timeout: 5000 });
    const scan = await new AxeBuilder({ page })
      .include('.note-editor__canvas')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    for (const v of scan.violations) {
      check(false, `media a11y (${theme} theme): ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`);
    }
    await page.evaluate(() => document.querySelector('button[aria-label^="Switch to"]')?.click());
    await page.waitForTimeout(600);
  }

  // A right-to-left note: the picture's toolbar stays inside it and the
  // handles still resize the way they are dragged.
  console.log('· media: right-to-left');
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note',
      body: `مرحبا بالعالم، هذه ملاحظة\n\n![[${picture}|400]]\n\nשלום עולם` },
  });
  await openNote(page, MEDIA_NOTE);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await page.locator('.luthor-media img').first().click();
  await page.locator('.luthor-media__toolbar').waitFor({ timeout: 5000 });
  const rtl = await page.evaluate(() => {
    const frame = document.querySelector('.luthor-media__frame').getBoundingClientRect();
    const bar = document.querySelector('.luthor-media__toolbar').getBoundingClientRect();
    const left = document.querySelector('.luthor-media__handle--left').getBoundingClientRect();
    const right = document.querySelector('.luthor-media__handle--right').getBoundingClientRect();
    return {
      barInside: bar.left >= frame.left - 1 && bar.right <= frame.right + 1,
      handles: Math.abs(left.left + left.width / 2 - frame.left) < 12 && Math.abs(right.left + right.width / 2 - frame.right) < 12,
    };
  });
  check(rtl.barInside && rtl.handles, `media: right-to-left layout of the picture's toolbar/handles is off (${JSON.stringify(rtl)})`);
  const rh = await page.locator('.luthor-media__handle--right').first().boundingBox();
  await page.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(rh.x + rh.width / 2 - i * 20, rh.y + rh.height / 2);
  await page.mouse.up();
  const rtlBody = await waitForBody(page, MEDIA_NOTE, (b) => /\|(\d+)\]\]/.test(b) && Number(/\|(\d+)\]\]/.exec(b)[1]) < 400);
  check(!!rtlBody, `media: in a right-to-left note, dragging the right handle inwards did not shrink the picture (${JSON.stringify(await noteBody(page, MEDIA_NOTE))})`);
  await page.evaluate(() => { document.documentElement.dir = ''; });

  // Reduced motion: the attachment toolbar appears without animating.
  console.log('· media: reduced motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNote(page, MEDIA_NOTE);
  await page.locator('.luthor-media img').first().click();
  await page.locator('.luthor-media__toolbar').waitFor({ timeout: 5000 });
  const motion = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.luthor-media__toolbar'));
    return { animation: cs.animationName, transition: cs.transitionDuration };
  });
  // (A global reduce rule's 0.01 ms counts as none — it exists so end events still fire.)
  const longest = Math.max(...motion.transition.split(',').map((d) => (d.trim().endsWith('ms') ? parseFloat(d) / 1000 : parseFloat(d))));
  check(motion.animation === 'none' && longest <= 0.01,
    `media: the toolbar still moves with reduced motion on (${JSON.stringify(motion)})`);
  await page.emulateMedia({ reducedMotion: null });

  // A PDF card previews in place at its page (S7), or — with no inline viewer
  // (headless browsers) — offers the framable route in a new tab.
  console.log('· media: PDF preview');
  const pdfUp = await page.request.post(`${ORIGIN}/api/media/upload?noteId=${MEDIA_NOTE}`, {
    multipart: { file: { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF } },
  });
  const pdfName = (await pdfUp.json()).filename;
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: `Read:\n\n![[${pdfName}#page=2]]` },
  });
  await openNote(page, MEDIA_NOTE);
  const viewer = await page.evaluate(() => navigator.pdfViewerEnabled);
  const viewUrl = `/api/media/view/${pdfName}#page=2`;
  if (viewer) {
    await page.getByRole('button', { name: 'Preview PDF' }).click();
    const frame = page.locator('.pdf-preview__frame iframe');
    await frame.waitFor({ timeout: 5000 });
    check(await frame.getAttribute('src') === viewUrl, `media: PDF frame src ${await frame.getAttribute('src')}`);
  } else {
    check(await page.getByRole('link', { name: /Open in new tab/ }).getAttribute('href') === viewUrl, 'media: no-viewer PDF card has no new-tab link to the view route');
  }
  const viewRes = await page.request.get(`${ORIGIN}/api/media/view/${pdfName}`);
  check(viewRes.headers()['x-frame-options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(viewRes.headers()['content-security-policy'] ?? ''),
    'media: the PDF view route is not framable by Papyra itself');
  const cardScan = await new AxeBuilder({ page }).include('.luthor-media').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  for (const v of cardScan.violations) check(false, `media a11y (PDF card): ${v.id} — ${v.help}`);

  // Cards on the desk load thumbnails, never the originals.
  console.log('· media: cards');
  await page.request.put(`${ORIGIN}/api/notes/${MEDIA_NOTE}`, {
    data: { title: 'Media', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: start },
  });
  await page.goto(`${ORIGIN}/`);
  // A vault picture's cover appears once its metadata is in (a web image's at once).
  await page.locator('.card-media__cover img[src*="/api/media/"]').first().waitFor({ timeout: 15_000 });
  const cardSrcs = await page.locator('.card-media__cover img, .card-media__thumb img').evaluateAll((els) => els.map((e) => e.currentSrc || e.src));
  // Web images (a link to another site) have no thumbnail; vault files always do.
  const vault = cardSrcs.filter((s) => s.includes('/api/media/'));
  check(vault.length > 0 && vault.every((s) => s.includes('/thumb?')), `media: cards loaded originals (${JSON.stringify(cardSrcs)})`);
}


// The production bundle the API serves from wwwroot (`pnpm run build`): budgets
// are meaningless against the Vite dev server's unbundled modules.
const API_ORIGIN = `http://localhost:${API_PORT}`;
// Requests in flight at once are the browser's to schedule (6 per host over
// HTTP/1.1, multiplexed over HTTP/2), so they are reported, not budgeted; what
// the app controls is how many it asks for (lazy loading) and which (thumbs).
const BUDGET = { firstPaintMs: 1000, cls: 0.02, heapMb: 150, noteRequests: 100, deskRequests: 120 };

async function checkPerf(browser) {
  if (!existsSync(resolve(WEB, '../papyra.api/src/Papyra.Api/wwwroot/index.html'))) {
    console.log('· perf: skipped — no production build in wwwroot (run `pnpm run build` first)');
    return;
  }
  console.log('· perf: setup (200 pictures, 300 notes)');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Layout shifts and media requests, recorded from the first byte of every page.
  await context.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        (window.__shifts ??= []).push([Math.round(e.startTime), +e.value.toFixed(4),
          e.sources?.map((x) => x.node?.className?.toString?.().slice(0, 40)).join('|')]);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  // The signed-in session from the editor checks: cookies are per host, not
  // per port, so it is valid on the API's own origin too.
  await context.addCookies(await browser.contexts()[0].cookies(ORIGIN));
  const page = await context.newPage();

  let inFlight = 0;
  let maxInFlight = 0;
  const media = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/media/') || r.method() !== 'GET') return;
    media.push(r.url().replace(API_ORIGIN, ''));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
  });
  const settled = (r) => { if (r.url().includes('/api/media/') && r.method() === 'GET') inFlight = Math.max(0, inFlight - 1); };
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);

  // 200 distinct photo-sized pictures, made on a canvas.
  await page.goto(`${API_ORIGIN}/`);
  const pictures = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 200; i++) {
      const c = document.createElement('canvas');
      c.width = 1600; c.height = 1200;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${(i * 37) % 360} 45% 55%)`;
      g.fillRect(0, 0, 1600, 1200);
      g.fillStyle = '#fff';
      g.font = 'bold 160px sans-serif';
      g.fillText(String(i), 100, 600);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const f = new FormData();
      f.append('file', new File([blob], `perf-${i}.png`, { type: 'image/png' }));
      const res = await fetch('/api/media/upload?noteId=perf', { method: 'POST', body: f });
      out.push((await res.json()).filename);
    }
    return out;
  });
  check(pictures.length === 200 && pictures.every(Boolean), `perf: uploads failed (${pictures.filter(Boolean).length}/200)`);
  const body = pictures.map((p, i) => `Picture ${i}\n\n![[${p}]]`).join('\n\n');
  await page.request.put(`${API_ORIGIN}/api/notes/perf`, {
    data: { title: 'Perf: 200 pictures', tags: [], color: null, pinned: false, archived: false, kind: 'note', body },
  });
  for (let i = 0; i < 300; i += 25) {
    await Promise.all(Array.from({ length: 25 }, (_, k) => page.request.put(`${API_ORIGIN}/api/notes/card-${i + k}`, {
      data: { title: `Card ${i + k}`, tags: [], color: null, pinned: false, archived: false, kind: 'note',
        body: `A note with a photo.\n\n![[${pictures[(i + k) % 200]}]]` },
    })));
  }

  // The editor waits on one batched metadata request: it must be quick.
  const metaStart = Date.now();
  await page.request.post(`${API_ORIGIN}/api/media/meta`, { data: { names: pictures } });
  const metaMs = Date.now() - metaStart;
  console.log(JSON.stringify({ metaBatchMs: metaMs }));
  check(metaMs < 300, `perf: metadata for 200 pictures took ${metaMs} ms (budget 300)`);

  // A 200-picture note, opened cold: content on screen fast, nothing jumping,
  // only what is near the viewport loading, thumbnails not originals.
  console.log('· perf: 200-picture note');
  media.length = 0;
  maxInFlight = 0;
  await page.goto(`${API_ORIGIN}/note/perf`);
  await page.waitForFunction(() => document.querySelectorAll('.luthor-media').length >= 200, null, { timeout: 30_000 });
  const firstPaint = await page.evaluate(() => {
    const frames = document.querySelectorAll('.luthor-media');
    return frames.length >= 200 ? performance.now() : null;
  });
  await page.waitForTimeout(3000);
  const timeline = await page.evaluate(() => ({
    meta: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/media/meta')).map((e) => [Math.round(e.startTime), Math.round(e.responseEnd)]),
    notes: performance.getEntriesByType('resource').filter((e) => /\/api\/notes(\?|$)/.test(e.name)).map((e) => [Math.round(e.startTime), Math.round(e.responseEnd)]),
    fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1),
    shifts: window.__shifts ?? [],
  }));
  console.log(JSON.stringify({ timeline }));
  const notePerf = await page.evaluate(() => ({
    cls: window.__cls,
    heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    loaded: [...document.querySelectorAll('.luthor-media img')].filter((i) => i.complete && i.naturalWidth > 0).length,
  }));
  const originals = media.filter((u) => /\/api\/media\/perf-[^/?]+\.png$/.test(u.split('?')[0]) && !u.includes('/thumb'));
  console.log(JSON.stringify({ note: { firstPaintMs: Math.round(firstPaint), ...notePerf, requests: media.length, maxInFlight } }));
  check(firstPaint !== null && firstPaint < BUDGET.firstPaintMs, `perf: 200-picture note took ${Math.round(firstPaint)} ms to show (budget ${BUDGET.firstPaintMs})`);
  check(notePerf.cls < BUDGET.cls, `perf: 200-picture note layout shift ${notePerf.cls.toFixed(4)} (budget ${BUDGET.cls})`);
  check(notePerf.heapMb === null || notePerf.heapMb < BUDGET.heapMb, `perf: 200-picture note heap ${notePerf.heapMb?.toFixed(0)} MB (budget ${BUDGET.heapMb})`);
  check(media.length < BUDGET.noteRequests, `perf: opening the note fetched ${media.length} pictures (lazy loading should keep it near the viewport)`);
  check(originals.length === 0, `perf: the note loaded ${originals.length} full-size originals for 1600px pictures in a narrower column`);

  // The desk with 300 photo cards: thumbnails only, near the viewport only.
  console.log('· perf: 300-card desk');
  media.length = 0;
  maxInFlight = 0;
  await page.goto(`${API_ORIGIN}/`);
  await page.locator('.card-media__cover img').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  const deskCls = await page.evaluate(() => window.__cls);
  const deskOriginals = media.filter((u) => !u.includes('/thumb') && !u.includes('/meta'));
  console.log(JSON.stringify({ desk: { requests: media.length, maxInFlight, cls: deskCls } }));
  check(deskOriginals.length === 0, `perf: the desk loaded originals (${deskOriginals.slice(0, 3).join(', ')})`);
  check(media.filter((u) => u.includes('/thumb')).length < BUDGET.deskRequests, `perf: the desk fetched ${media.length} thumbnails up front (lazy loading should keep it near the viewport)`);
  check(deskCls < BUDGET.cls, `perf: the desk shifted ${deskCls.toFixed(4)} while loading (budget ${BUDGET.cls})`);
  await context.close();
}

let browser;
let page;
// E2E_SHOTS=<dir>: on a failure, keep a screenshot and the note body there.
const SHOTS = process.env.E2E_SHOTS;
try {
  await waitFor(`http://localhost:${API_PORT}/health`, api, 'API');
  await waitFor(`${ORIGIN}/`, web, 'Vite');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('papyra-editor-toolbar', 'always'));
  page = await context.newPage();
  page.on('dialog', (d) => { failures.push(`unexpected native dialog: ${d.type()} "${d.message()}"`); void d.dismiss(); });

  // First user + an empty note to work in.
  // The first admin needs an authenticator: enrol a throwaway one.
  const totpSecret = base32(randomBytes(20));
  const setup = await page.request.post(`${ORIGIN}/api/auth/setup`, {
    data: { username: 'e2e', name: 'E2E', password: 'Tr0ub4dor&3-papyra-e2e!', totpSecret, totpCode: totp(totpSecret) },
  });
  if (!setup.ok()) throw new Error(`setup failed: ${setup.status()} ${await setup.text()}`);
  const put = await page.request.put(`${ORIGIN}/api/notes/${NOTE}`, {
    data: { title: 'Insert paths', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: 'Start.' },
  });
  if (!put.ok()) throw new Error(`creating the note failed: ${put.status()} ${await put.text()}`);

  const body = async () => {
    const list = await (await page.request.get(`${ORIGIN}/api/notes`)).json();
    return (list.find?.((n) => n.id === NOTE) ?? {}).body ?? '';
  };
  // Autosave is debounced: poll the body on disk until it shows what we expect.
  const bodyHas = async (test, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const b = await body();
      if (test(b)) return true;
      if (Date.now() > deadline) return false;
      await page.waitForTimeout(400);
    }
  };
  const settle = async () => {
    // Autosave debounces; wait for the status to read saved and the body to stop changing.
    await page.waitForTimeout(1500);
    await page.getByText('Saved to local disk').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  // Below the last block, the way a person continues a note. (Clicking the
  // middle of the body would land on — and select — a picture or embed.)
  const caretToEnd = async () => {
    const editable = page.locator('.luthor-content-editable');
    await editable.evaluate((el) => el.lastElementChild?.scrollIntoView({ block: 'center' }));
    const box = await editable.boundingBox();
    await page.mouse.click(box.x + 40, box.y + box.height - 3);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
  };
  const insertMenu = async (label) => {
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.getByRole('button', { name: label }).click();
  };
  const chooseFile = async (label, name, mimeType, buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await insertMenu(label);
    await (await chooser).setFiles({ name, mimeType, buffer });
  };
  const dropFile = async (name, type, base64, kind) => {
    await page.evaluate(({ name, type, base64, kind }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      const target = document.querySelector('.luthor-content-editable');
      if (kind === 'drop') {
        // Released just under the last block: lands at the end.
        const r = target.getBoundingClientRect();
        const at = { clientX: r.left + 40, clientY: r.bottom - 3 };
        for (const t of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
        }
      } else {
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }, { name, type, base64: base64.toString('base64'), kind });
  };

  await page.goto(`${ORIGIN}/note/${NOTE}`);
  await page.locator('.luthor-toolbar').waitFor({ timeout: 30_000 });

  // 1. Toolbar → Insert → Upload image (PNG) → ![[…png]]
  console.log('· step 1');
  await caretToEnd();
  await chooseFile('Upload image or GIF', 'photo.png', 'image/png', PNG);
  await settle();
  check(await bodyHas((b) => /!\[\[photo-[^\]]+\.png\]\]/.test(b)), 'upload image: body has no ![[photo-….png]]');

  // 2. Same menu, a GIF
  console.log('· step 2');
  await caretToEnd();
  await chooseFile('Upload image or GIF', 'dance.gif', 'image/gif', GIF);
  await settle();
  check(await bodyHas((b) => /!\[\[dance-[^\]]+\.gif\]\]/.test(b)), 'upload GIF: body has no ![[dance-….gif]]');

  // 3. Attach a non-image file
  console.log('· step 3');
  await caretToEnd();
  await chooseFile('Attach a file', 'report.pdf', 'application/pdf', PDF);
  await settle();
  check(await bodyHas((b) => /!\[\[report-[^\]]+\.pdf\]\]/.test(b)), 'attach file: body has no ![[report-….pdf]]');

  // 4. Drag and drop an image onto the body
  console.log('· step 4');
  await caretToEnd();
  await dropFile('dropped.png', 'image/png', PNG, 'drop');
  await settle();
  check(await bodyHas((b) => /!\[\[dropped-[^\]]+\.png\]\]/.test(b)), 'drag & drop: body has no ![[dropped-….png]]');

  // 5. Paste an image
  console.log('· step 5');
  await caretToEnd();
  await dropFile('pasted.png', 'image/png', PNG, 'paste');
  await settle();
  check(await bodyHas((b) => /!\[\[pasted-[^\]]+\.png\]\]/.test(b)), 'paste: body has no ![[pasted-….png]]');

  // 6. Image from a link (themed dialog, with alt text)
  console.log('· step 6');
  await caretToEnd();
  await insertMenu('Image from a link');
  await page.getByLabel('Image or GIF link').fill(`${ORIGIN}/${LINK_IMAGE}`);
  await page.getByLabel('Description (alt text)').fill('Papyra mark');
  await page.locator('.luthor-dialog').getByRole('button', { name: 'Insert', exact: true }).click();
  await settle();
  check(await bodyHas((b) => b.includes(`![Papyra mark](${ORIGIN}/${LINK_IMAGE})`)), 'image link: body has no ![Papyra mark](…)');

  // 7. YouTube embed
  console.log('· step 7');
  await caretToEnd();
  await insertMenu('YouTube video');
  await page.getByLabel('Video link').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.locator('.luthor-dialog').getByRole('button', { name: 'Embed', exact: true }).click();
  await settle();
  check(await bodyHas((b) => /!\[\[youtube:[^\]]*dQw4w9WgXcQ[^\]]*\]\]/.test(b)), 'youtube: body has no ![[youtube:…]]');

  // 8. Web page embed
  console.log('· step 8');
  await caretToEnd();
  await insertMenu('Web page');
  await page.getByLabel('Page link').fill('https://example.com/');
  await page.locator('.luthor-dialog').getByRole('button', { name: 'Embed', exact: true }).click();
  await settle();
  check(await bodyHas((b) => /!\[\[iframe:https:\/\/example\.com\/?[^\]]*\]\]/.test(b)), 'web page: body has no ![[iframe:https://example.com…]]');

  // 9. Toolbar link → themed dialog (address + text) → [text](url)
  console.log('· step 9');
  await caretToEnd();
  await page.getByRole('button', { name: /Insert Link/ }).click();
  await page.getByLabel('Link address').fill('https://example.org/');
  await page.getByLabel(/Text to show/).fill('Example');
  await page.locator('.luthor-dialog').getByRole('button', { name: 'Link', exact: true }).click();
  await settle();
  check(await bodyHas((b) => b.includes('[Example](https://example.org/)')), `toolbar link: body has no [Example](https://example.org/) — ends ${JSON.stringify((await body()).slice(-160))}`);

  // 10. The /image slash command asks in the same themed dialog (no window.prompt)
  console.log('· step 10');
  await caretToEnd();
  await page.keyboard.type('/image');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.getByLabel('Image link').fill(`${ORIGIN}/${LINK_IMAGE}`);
  await page.getByLabel('Description (alt text)').fill('Slash image');
  await page.locator('.luthor-dialog').getByRole('button', { name: 'Insert', exact: true }).click();
  await settle();
  check(await bodyHas((b) => b.includes(`![Slash image](${ORIGIN}/${LINK_IMAGE})`)), 'slash /image: body has no ![Slash image](…)');

  // ── Round trip: reload, the same visuals, and nothing rewritten ────────────
  const before = await body();
  await page.reload();
  await page.locator('.luthor-content-editable').waitFor();
  await page.waitForTimeout(2500);
  const after = await body();
  check(after === before, 'reopening the note rewrote its body (markdown round trip is not stable)');

  const rendered = await page.evaluate(async () => {
    const root = document.querySelector('.luthor-content-editable');
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    return {
      images: imgs.map((img) => ({ src: img.getAttribute('src'), ok: img.naturalWidth > 0 })),
      iframes: [...root.querySelectorAll('iframe')].map((f) => f.getAttribute('src')),
      links: [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      blob: root.innerHTML.includes('blob:'),
    };
  });
  const loaded = rendered.images.filter((i) => i.ok).length;
  check(loaded >= 6, `after reload only ${loaded} images rendered (expected ≥6: png, gif, dropped, pasted, link, slash) — ${JSON.stringify(rendered.images)}`);
  check(rendered.iframes.some((s) => s?.includes('youtube')), 'after reload the YouTube embed is not rendered');
  check(rendered.iframes.some((s) => s?.includes('example.com')), 'after reload the web page embed is not rendered');
  check(!rendered.blob, 'a blob: URL leaked into the note');
  check(!before.includes('blob:'), 'a blob: URL was written to disk');

  // Every uploaded file is served back.
  for (const m of before.matchAll(/!\[\[([^\]:|]+\.(?:png|gif|pdf))\]\]/g)) {
    const res = await page.request.get(`${ORIGIN}/api/media/${encodeURIComponent(m[1])}`);
    check(res.ok(), `media ${m[1]} is not served (${res.status()})`);
  }

  // ── Markdown → visual: a body written on disk renders and survives a save ──
  const handWritten = [
    'Hand-written.',
    '',
    `![A link image](${ORIGIN}/${LINK_IMAGE})`,
    '',
    '![[youtube:https://www.youtube.com/embed/dQw4w9WgXcQ]]',
    '',
    '- [ ] a task',
    '- [x] done',
  ].join('\n');
  await page.request.put(`${ORIGIN}/api/notes/${NOTE}`, {
    data: { title: 'Insert paths', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: handWritten },
  });
  await page.reload();
  await page.locator('.luthor-content-editable').waitFor();
  await page.waitForTimeout(2500);
  const handRendered = await page.evaluate(() => {
    const root = document.querySelector('.luthor-content-editable');
    return { img: !!root.querySelector('img[alt="A link image"]'), yt: !!root.querySelector('iframe[src*="youtube"]'), checks: root.querySelectorAll('li[role="checkbox"], li[aria-checked]').length };
  });
  check(handRendered.img, 'hand-written ![alt](url) did not render as an image');
  check(handRendered.yt, 'hand-written ![[youtube:…]] did not render as an embed');
  const reopened = await body();
  check(reopened === handWritten, `opening a hand-written body rewrote it:
--- on disk before
${handWritten}
--- after
${reopened}`);

  console.log(JSON.stringify({ images: rendered.images.length, iframes: rendered.iframes.length }, null, 0));

  // ── Attachments: select, resize, upload pipeline (media overhaul S4–S6) ───
  await checkMedia(page);

  // ── Performance budgets on a media-heavy vault (media overhaul S9) ─────────
  await checkPerf(browser);
} catch (err) {
  failures.push(`harness: ${err.message}`);
  if (SHOTS && page) {
    await page.screenshot({ path: join(SHOTS, 'check-editor-failure.png') }).catch(() => {});
    console.error(`screenshot: ${join(SHOTS, 'check-editor-failure.png')}`);
    const list = await (await page.request.get(`${ORIGIN}/api/notes`)).json().catch(() => []);
    writeFileSync(join(SHOTS, 'check-editor-body.md'), (list.find?.((n) => n.id === NOTE) ?? {}).body ?? '');
  }
} finally {
  await browser?.close();
  web.kill();
  api.kill();
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the API may still hold a lock on Windows */ }
}

if (failures.length) {
  console.error(`check-editor: ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('check-editor: every insert path round-trips (upload, GIF, attach, drag & drop, paste, image link, YouTube, web page, link, /image, hand-written markdown); attachments select, resize, upload in order, cancel, refuse, keep posters, survive theme switches, PDFs preview in place, and cards use thumbnails ✓');
