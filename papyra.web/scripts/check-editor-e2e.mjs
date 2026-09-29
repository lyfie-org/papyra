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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

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
const API_PORT = 5231;
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
], { env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' } });
const web = start(process.execPath, [
  resolve(WEB, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort',
], { cwd: WEB, env: { ...process.env, PAPYRA_API: `http://localhost:${API_PORT}` } });

let browser;
try {
  await waitFor(`http://localhost:${API_PORT}/health`, api, 'API');
  await waitFor(`${ORIGIN}/`, web, 'Vite');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('papyra-editor-toolbar', 'always'));
  const page = await context.newPage();
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
  const caretToEnd = async () => {
    const editable = page.locator('.luthor-content-editable');
    await editable.click();
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
        for (const t of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
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
  check(await bodyHas((b) => b.includes('[Example](https://example.org/)')), 'toolbar link: body has no [Example](https://example.org/)');

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
} catch (err) {
  failures.push(`harness: ${err.message}`);
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
console.log('check-editor: every insert path round-trips (upload, GIF, attach, drag & drop, paste, image link, YouTube, web page, link, /image, hand-written markdown) ✓');
