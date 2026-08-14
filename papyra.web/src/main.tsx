// MUST be first. @lexical/code (via @lyfie/luthor) pulls in prismjs language
// components that read a bare `Prism` global, but prism's core only publishes
// that global from its own CommonJS factory. In a Rollup prod build the factory
// is lazy while the components are hoisted to top level, so they evaluated
// first and the bundle threw `ReferenceError: Prism is not defined` before
// React ever mounted (white screen — dev was unaffected). Importing the core
// here forces it to run, and publish `globalThis.Prism`, ahead of them.
import 'prismjs';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient.ts';
import { ThemeProvider } from './hooks/ThemeProvider.tsx';
import { ToastProvider } from './components/ToastProvider.tsx';
import { ConfirmProvider } from './components/ConfirmProvider.tsx';
import './index.css';
import App from './App.tsx';

// Offline shell + read cache. Only registered for the built app: in dev the
// module graph is served unbundled and a caching worker would fight HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is an enhancement — a failed registration is not fatal */
    });
  });

  // A new worker that has claimed this page means a new build is live. Without
  // this an already-open tab kept running the previous bundle off the cached
  // shell until it was closed — an upgrade that never arrives.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <ConfirmProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
