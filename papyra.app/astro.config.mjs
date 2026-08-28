// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import rehypeTableScroll from './src/lib/rehype-table-scroll.mjs';

export default defineConfig({
  site: 'https://papyra.app',
  // Fully static: every byte is served from Cloudflare's edge with no origin,
  // no cold start and no region. Nothing on this site needs a server.
  output: 'static',
  integrations: [mdx(), react(), sitemap()],
  markdown: {
    // Tables scroll inside their own box so a wide one never makes the page
    // scroll sideways on a phone.
    rehypePlugins: [rehypeTableScroll],
    // Shiki runs at build time and inlines the colours, so no highlighter is
    // shipped to the browser. Two themes, switched by the site's own
    // data-theme attribute rather than a media query.
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },
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
