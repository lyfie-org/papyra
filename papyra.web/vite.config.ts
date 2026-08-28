import { copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Everything the demo build needs that the app build does not.
 *
 * 1. Self-hosted fonts. index.html pulls Marcellus/Sora/Roboto Mono from
 *    fonts.googleapis.com, which is fine for a server you run yourself but wrong
 *    on papyra.app: it is a third-party origin, it costs two cross-origin round
 *    trips, it is blocked outright in mainland China, and the site's own CSP
 *    (`style-src 'self'`) refuses it. The website serves the same faces from
 *    /fonts, same origin, so point at those instead.
 *
 * 2. A 404.html copy of the shell. The demo is a client-side-routed SPA at /demo,
 *    so /demo/note/xyz has no file behind it. The usual Cloudflare Pages fix —
 *    `/demo/*  /demo/index.html  200` in _redirects — does NOT work: Pages
 *    rejects any splat whose destination normalises back into the same pattern
 *    ("Infinite loop detected in this rule and has been ignored"), and the
 *    per-route rules it does accept resolve as real 3xx redirects that throw the
 *    path away. Pages serves the nearest parent 404.html for an unmatched path,
 *    keeping the URL intact, so a copy of the shell there IS the SPA fallback.
 *    It answers with a 404 status, which browsers and react-router do not mind
 *    and which the demo's `noindex` makes moot.
 */
function demoBuild(): Plugin {
  return {
    name: 'papyra-demo-build',
    apply: 'build',

    transformIndexHtml(html) {
      return html
        .replace(/\s*<link rel="preconnect"[^>]*fonts\.g[^>]*>/g, '')
        .replace(
          /\s*<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet"\s*\/?>/,
          '\n    <link rel="stylesheet" href="/fonts/fonts.css" />' +
            '\n    <meta name="robots" content="noindex" />',
        );
    },

    closeBundle() {
      const out = resolve(import.meta.dirname, '../papyra.app/public/demo');
      copyFileSync(resolve(out, 'index.html'), resolve(out, '404.html'));
      // public/sw.js is copied verbatim by Vite, but the demo never registers it
      // (see main.tsx) and it precaches fonts.googleapis.com, which the site's
      // CSP forbids. Shipping a worker nothing installs is dead weight at best
      // and a stale-cache trap at worst.
      rmSync(resolve(out, 'sw.js'), { force: true });
    },
  };
}

// Dev-only proxy so the web app uses same-origin relative URLs (/api, /hubs) in
// both dev and prod. In prod the SPA is served from the API's wwwroot, so these
// paths already resolve same-origin and need no proxy.
const API_TARGET = process.env.PAPYRA_API ?? 'http://localhost:5220';

// `--mode demo` builds this same app against an in-browser fake server (src/demo)
// for the product website's live demo. Only the base path and the output
// directory change; the application code is identical, which is the whole point —
// the demo IS the app, so it can never drift from it. VITE_DEMO comes from
// .env.demo, which Vite loads for this mode.
export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    plugins: isDemo ? [react(), demoBuild()] : [react()],
    // The demo is served from papyra.app/demo/, so every asset URL needs the prefix.
    base: isDemo ? '/demo/' : '/',
    // prismjs (pulled in by @lexical/code via @lyfie/luthor) publishes its core as
    // `global.Prism` and every language component then reads the bare `Prism`
    // global. Vite's dev pre-bundle shims `global`, a Rollup prod build does not —
    // so the built bundle threw `ReferenceError: Prism is not defined` at module
    // eval and white-screened the whole SPA. Map `global` to `globalThis` so the
    // core's own publish step runs in the browser build too.
    define: {
      global: 'globalThis',
    },
    // Prod build emits straight into the API's wwwroot so a single Kestrel
    // process serves the SPA (UseStaticFiles + MapFallbackToFile). The demo build
    // emits into the website's public/ instead, where Astro copies it to /demo.
    // emptyOutDir clears stale assets across rebuilds.
    build: {
      outDir: isDemo ? '../papyra.app/public/demo' : '../papyra.api/src/Papyra.Api/wwwroot',
      emptyOutDir: true,
    },
    server: {
      proxy: {
        // PAPYRA_API lets `pnpm dev` drive an API that isn't the local Kestrel —
        // e.g. the container on :8080 — so the dev UI can iterate against the same
        // vault the packaged build is serving.
        '/api': { target: API_TARGET, changeOrigin: true },
        '/hubs': { target: API_TARGET, changeOrigin: true, ws: true },
      },
    },
  };
});
