import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy so the web app uses same-origin relative URLs (/api, /hubs) in
// both dev and prod. In prod the SPA is served from the API's wwwroot, so these
// paths already resolve same-origin and need no proxy.
const API_TARGET = process.env.PAPYRA_API ?? 'http://localhost:5220';

export default defineConfig({
  plugins: [react()],
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
  // process serves the SPA (UseStaticFiles + MapFallbackToFile). emptyOutDir
  // clears stale assets across rebuilds.
  build: {
    outDir: '../papyra.api/src/Papyra.Api/wwwroot',
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
});
