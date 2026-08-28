// Demo-mode entry point.
//
// Imported dynamically from main.tsx behind `import.meta.env.VITE_DEMO`, so a
// normal production build never pulls any of this into the bundle.

import { installDemoBackend } from './backend';
import { mountDemoBanner } from './banner';

export async function startDemo(): Promise<void> {
  installDemoBackend();
  // The banner needs <body>, which exists by the time the module script runs.
  mountDemoBanner();
}
