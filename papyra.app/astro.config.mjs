// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://papyra.app',
  // Fully static: every byte is served from Cloudflare's edge with no origin,
  // no cold start and no region. Nothing on this site needs a server.
  output: 'static',
  integrations: [mdx(), react(), sitemap()],
  // /demo is the papyra.web SPA copied into public/ by its own Vite build.
  // Astro must not try to crawl or transform it.
  build: { format: 'directory' },
  vite: {
    build: {
      // Cloudflare serves brotli; keep chunks whole and legible instead of
      // splitting a site this small into dozens of requests.
      assetsInlineLimit: 2048,
    },
  },
});
