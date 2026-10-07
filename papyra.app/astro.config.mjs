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
  integrations: [
    mdx(),
    react(),
    sitemap({
      // HTML pages only: the 404, and the plain-text twins (/llms.txt,
      // /docs/*.md) which are linked from the pages themselves.
      filter: (page) => !/\/404\/?$|\.(txt|md)\/?$/.test(page),
      // Every build is a fresh look at the docs and the release notes.
      serialize: (item) => ({ ...item, lastmod: new Date().toISOString() }),
    }),
  ],
  markdown: {
    // Tables scroll inside their own box so a wide one never makes the page
    // scroll sideways on a phone.
    rehypePlugins: [rehypeTableScroll],
    // Shiki runs at build time, so no highlighter is shipped to the browser.
    // The css-variables theme emits var(--astro-code-*) instead of colours;
    // site.css maps those onto the design tokens, so code follows light/dark
    // like everything else.
    shikiConfig: {
      theme: 'css-variables',
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
