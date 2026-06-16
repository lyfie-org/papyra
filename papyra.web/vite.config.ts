import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy so the web app uses same-origin relative URLs (/api, /hubs) in
// both dev and prod. In prod the SPA is served from the API's wwwroot, so these
// paths already resolve same-origin and need no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5220', changeOrigin: true },
      '/hubs': { target: 'http://localhost:5220', changeOrigin: true, ws: true },
    },
  },
});
