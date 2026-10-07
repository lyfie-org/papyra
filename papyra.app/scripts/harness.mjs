// Shared by the scripts that drive the built site in a real browser
// (shoot.mjs for stills, clips.mjs for the looping videos): a static server
// that behaves like Cloudflare Pages, and helpers that stage the demo.

import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
};

/**
 * Serve dist/ the way Cloudflare Pages does — in particular, falling back to the
 * nearest parent 404.html, which is what makes the demo's client-side routes
 * resolve. Node's own http module rather than a dependency: it is thirty lines
 * and it keeps the screenshot pipeline out of the deploy toolchain.
 */
export function serve(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    // normalize + prefix check: a screenshot script is still a web server, and
    // `..` in a path must not escape dist/.
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(DIST, path);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }

    if (existsSync(file) && !extname(file)) file = join(file, 'index.html');
    if (!existsSync(file)) {
      // Nearest parent 404.html, walking up — /demo/note/x → /demo/404.html.
      let dir = join(DIST, path);
      let fallback = null;
      while (dir.startsWith(DIST)) {
        const candidate = join(dir, '404.html');
        if (existsSync(candidate)) {
          fallback = candidate;
          break;
        }
        dir = resolve(dir, '..');
      }
      if (!fallback) {
        res.writeHead(404).end('not found');
        return;
      }
      file = fallback;
    }

    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok) => server.listen(port, () => ok(server)));
}

/** Where the demo lives on the local server. */
export const demoUrl = (port, path = '/') => `http://localhost:${port}/demo${path === '/' ? '/' : path}`;

/**
 * Rearrange the demo vault for a capture, through the demo's own API so the app
 * sees exactly what a visitor's edits would produce. The demo persists to
 * localStorage, so the caller reloads afterwards.
 */
export async function stageDesk(page, { archive = [], pin = [], unpin = [] } = {}) {
  await page.evaluate(
    async ({ archive, pin, unpin }) => {
      const put = (id, body) =>
        fetch(`/api/notes/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      for (const id of archive) await put(id, { archived: true, pinned: false });
      for (const id of pin) await put(id, { pinned: true });
      for (const id of unpin) await put(id, { pinned: false });
    },
    { archive, pin, unpin },
  );
}

/** Chrome that has no business in a marketing capture. */
export const CAPTURE_CSS =
  '.demo-banner,.top-progress{display:none!important}.workspace__version{visibility:hidden!important}::-webkit-scrollbar{display:none}';
