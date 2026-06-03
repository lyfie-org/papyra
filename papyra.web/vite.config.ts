import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Only inject the service-worker registration script in production builds.
      // In dev mode the SW would intercept HMR requests and break live-reload.
      devOptions: { enabled: false },
      workbox: {
        // App shell: precache every build artifact (JS, CSS, fonts)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

        // Runtime caching for API list reads so the app is browsable offline.
        // NetworkFirst: always try the network; fall back to cache on failure.
        // Only cache same-origin API paths (works in production where API + SPA
        // share an origin; in dev the cross-origin API is excluded automatically).
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/notes') ||
              url.pathname === '/health',
            handler: 'NetworkFirst',
            options: {
              cacheName:    'papyra-api-reads',
              networkTimeoutSeconds: 5,
              expiration:   { maxEntries: 200, maxAgeSeconds: 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        name:             'Papyra',
        short_name:       'Papyra',
        description:      'Self-hosted Markdown note-taking — works offline',
        theme_color:      '#7aaa8a',
        background_color: '#f2ebe0',
        display:          'standalone',
        orientation:      'portrait-primary',
        start_url:        '/',
        scope:            '/',
        icons: [
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
